/**
 * Azure AI Foundry proxy — routes chat completions through server-side
 * credentials so users only pick a model, never handle API keys.
 *
 * Two Foundry resources are supported, each with its own endpoint + key:
 *   - Primary (OD_FOUNDRY_ENDPOINT / OD_FOUNDRY_KEY)
 *   - Secondary (OD_FOUNDRY_ENDPOINT_2 / OD_FOUNDRY_KEY_2)
 *
 * Deployment-to-resource mapping is resolved at startup by querying
 * both endpoints.
 */

import type { Express, Request, Response } from 'express';

// ── env helpers ──────────────────────────────────────────────────────

interface FoundryResource {
  endpoint: string;  // e.g. https://arrowflow-ai.cognitiveservices.azure.com/
  apiKey: string;
}

interface DeploymentInfo {
  id: string;       // deployment name e.g. "gpt-5.4-nano"
  model: string;    // underlying model name
  resource: FoundryResource;
}

let deployments: DeploymentInfo[] = [];

function getResources(): FoundryResource[] {
  const resources: FoundryResource[] = [];
  const e1 = process.env.OD_FOUNDRY_ENDPOINT?.trim();
  const k1 = process.env.OD_FOUNDRY_KEY?.trim();
  if (e1 && k1) resources.push({ endpoint: e1, apiKey: k1 });

  const e2 = process.env.OD_FOUNDRY_ENDPOINT_2?.trim();
  const k2 = process.env.OD_FOUNDRY_KEY_2?.trim();
  if (e2 && k2) resources.push({ endpoint: e2, apiKey: k2 });

  return resources;
}

export function isFoundryConfigured(): boolean {
  return getResources().length > 0;
}

// ── deployment discovery ─────────────────────────────────────────────

async function discoverDeployments(resource: FoundryResource): Promise<DeploymentInfo[]> {
  const url = `${resource.endpoint.replace(/\/+$/, '')}/openai/deployments?api-version=2024-10-21`;
  try {
    const resp = await fetch(url, {
      headers: { 'api-key': resource.apiKey },
    });
    if (!resp.ok) {
      console.warn(`[foundry] deployment discovery failed for ${resource.endpoint}: ${resp.status}`);
      return [];
    }
    const data = await resp.json() as { data?: Array<{ id: string; model: string }> };
    return (data.data ?? [])
      .filter((d) => d.id && d.model)
      .map((d) => ({ id: d.id, model: d.model, resource }));
  } catch (err: any) {
    console.warn(`[foundry] deployment discovery error for ${resource.endpoint}: ${err.message}`);
    return [];
  }
}

export async function initFoundry(): Promise<void> {
  const resources = getResources();
  if (resources.length === 0) {
    console.log('[foundry] no Foundry resources configured');
    return;
  }
  const results = await Promise.all(resources.map(discoverDeployments));
  deployments = results.flat();
  console.log(`[foundry] discovered ${deployments.length} deployment(s): ${deployments.map((d) => d.id).join(', ')}`);
}

export function getFoundryDeployments(): Array<{ id: string; model: string }> {
  return deployments.map((d) => ({ id: d.id, model: d.model }));
}

function findDeployment(deploymentId: string): DeploymentInfo | undefined {
  return deployments.find((d) => d.id === deploymentId);
}

// ── SSE helpers (reuse patterns from chat-routes) ────────────────────

function createSseResponse(res: Response) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  return {
    send(event: string, data: unknown) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end() {
      res.end();
    },
  };
}

// ── routes ───────────────────────────────────────────────────────────

export function registerFoundryRoutes(app: Express): void {
  // List available Foundry deployments — no auth needed from client side
  app.get('/api/foundry/models', (_req: Request, res: Response) => {
    if (!isFoundryConfigured()) {
      return res.status(404).json({ error: 'Foundry not configured' });
    }
    return res.json({
      models: getFoundryDeployments(),
    });
  });

  // Chat completions proxy — server provides the key
  app.post('/api/proxy/foundry/stream', async (req: Request, res: Response) => {
    const { model, systemPrompt, messages, maxTokens } = req.body || {};
    if (!model) {
      return res.status(400).json({ error: 'model is required' });
    }

    const deployment = findDeployment(model);
    if (!deployment) {
      return res.status(404).json({
        error: `Unknown deployment: ${model}. Available: ${deployments.map((d) => d.id).join(', ')}`,
      });
    }

    const baseUrl = deployment.resource.endpoint.replace(/\/+$/, '');
    const url = `${baseUrl}/openai/deployments/${encodeURIComponent(deployment.id)}/chat/completions?api-version=2024-10-21`;

    console.log(`[foundry] ${req.method} ${deployment.id} on ${baseUrl}`);

    const payloadMessages: Array<{ role: string; content: string }> = [];
    if (typeof systemPrompt === 'string' && systemPrompt) {
      payloadMessages.push({ role: 'system', content: systemPrompt });
    }
    if (Array.isArray(messages)) {
      payloadMessages.push(...messages);
    }

    const payload: Record<string, unknown> = {
      messages: payloadMessages,
      stream: true,
    };
    if (typeof maxTokens === 'number' && maxTokens > 0) {
      payload.max_tokens = maxTokens;
    }

    const sse = createSseResponse(res);
    sse.send('start', { model: deployment.id });

    try {
      const upstream = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': deployment.resource.apiKey,
        },
        body: JSON.stringify(payload),
      });

      if (!upstream.ok) {
        const errorText = await upstream.text();
        console.error(`[foundry] upstream error: ${upstream.status} ${errorText.slice(0, 200)}`);
        sse.send('error', {
          message: `Upstream error: ${upstream.status}`,
          code: upstream.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR',
          retryable: upstream.status === 429 || upstream.status >= 500,
        });
        return sse.end();
      }

      if (!upstream.body) {
        sse.send('error', { message: 'No response body', code: 'INTERNAL_ERROR' });
        return sse.end();
      }

      // Azure OpenAI streams SSE with `data: {...}` lines
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let ended = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;
          if (trimmed === 'data: [DONE]') {
            sse.send('end', {});
            ended = true;
            break;
          }
          if (trimmed.startsWith('data: ')) {
            try {
              const json = JSON.parse(trimmed.slice(6));
              const delta = json.choices?.[0]?.delta?.content;
              if (typeof delta === 'string' && delta) {
                sse.send('delta', { delta });
              }
            } catch {
              // skip malformed JSON lines
            }
          }
        }
        if (ended) break;
      }

      if (!ended) sse.send('end', {});
      sse.end();
    } catch (err: any) {
      console.error(`[foundry] internal error: ${err.message}`);
      sse.send('error', { message: err.message, code: 'INTERNAL_ERROR' });
      sse.end();
    }
  });
}
