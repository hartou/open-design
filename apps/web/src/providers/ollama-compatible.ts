import { effectiveMaxTokens } from '../state/maxTokens';
import type { AppConfig, ChatMessage } from '../types';
import type { StreamHandlers } from './anthropic';
import { parseSseFrame } from './sse';

/**
 * Stream a chat completion through the ArrowFlow Agent (Foundry) proxy.
 * Unlike other providers, the daemon owns the API key — the client only
 * sends the model name and messages.
 */
export async function streamMessageFoundry(
  cfg: AppConfig,
  system: string,
  history: ChatMessage[],
  signal: AbortSignal,
  handlers: StreamHandlers,
): Promise<void> {
  if (!cfg.model) {
    handlers.onError(new Error('No model selected — open Settings and pick one.'));
    return;
  }

  let acc = '';

  try {
    const resp = await fetch('/api/proxy/foundry/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        systemPrompt: system,
        messages: history.map((m) => ({ role: m.role, content: m.content })),
        maxTokens: effectiveMaxTokens(cfg),
      }),
      signal,
    });

    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '');
      handlers.onError(new Error(`foundry proxy ${resp.status}: ${text || 'no body'}`));
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const frame = parseSseFrame(line);
        if (!frame) continue;
        if (frame.event === 'delta') {
          const delta = (frame.data as { delta?: string }).delta ?? '';
          acc += delta;
          handlers.onToken(acc, delta);
        } else if (frame.event === 'error') {
          const msg = (frame.data as { message?: string }).message ?? 'Unknown error';
          handlers.onError(new Error(msg));
          return;
        } else if (frame.event === 'end') {
          handlers.onComplete(acc);
          return;
        }
      }
    }

    handlers.onComplete(acc);
  } catch (err: any) {
    if (err.name === 'AbortError') return;
    handlers.onError(err);
  }
}
