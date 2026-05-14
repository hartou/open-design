// Shared metadata for the four API protocols the BYOK pickers offer.
//
// Originally these tables lived inline in `SettingsDialog.tsx`. The
// memory-extraction picker needs the exact same lists (so it can mirror
// the chat picker's protocol tabs / suggested-model dropdown / API key
// placeholders) — extracting them here keeps the two pickers from
// drifting apart whenever someone adds a new fast-pass model or a new
// quick-fill provider.
//
// The lists are intentionally hand-curated rather than auto-discovered:
// every option exposes `provider/model` strings the daemon already
// understands, so a new entry here implies a deliberate decision about
// support on the request side too.

import type { ApiProtocol } from '../types';

// Suggested fast-pass / common models per protocol — what the BYOK
// model dropdown lists by default. The first OpenAI-compatible block is
// duplicated under both `openai` and `azure` because azure's chat-
// completions endpoint speaks the same JSON shape; the deployment name
// the user types in the model field is what's variable, not the API.
export const SUGGESTED_MODELS_BY_PROTOCOL: Record<ApiProtocol, readonly string[]> = {
  anthropic: [
    'claude-opus-4-5',
    'claude-sonnet-4-5',
    'claude-haiku-4-5',
    'deepseek-chat',
    'deepseek-reasoner',
    'deepseek-v4-flash',
    'deepseek-v4-pro',
    'MiniMax-M2.7-highspeed',
    'MiniMax-M2.7',
    'MiniMax-M2.5-highspeed',
    'MiniMax-M2.5',
    'MiniMax-M2.1-highspeed',
    'MiniMax-M2.1',
    'MiniMax-M2',
    'mimo-v2.5-pro',
  ],
  openai: [
    'gpt-4o',
    'gpt-4o-mini',
    'o3',
    'o4-mini',
    'deepseek-chat',
    'deepseek-reasoner',
    'deepseek-v4-flash',
    'deepseek-v4-pro',
    'MiniMax-M2.7-highspeed',
    'MiniMax-M2.7',
    'MiniMax-M2.5-highspeed',
    'MiniMax-M2.5',
    'MiniMax-M2.1-highspeed',
    'MiniMax-M2.1',
    'MiniMax-M2',
    'mimo-v2.5-pro',
  ],
  azure: [
    'gpt-4o',
    'gpt-4o-mini',
  ],
  google: [
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-1.5-pro',
    'gemini-1.5-flash',
  ],
  foundry: [
    // Populated dynamically from /api/foundry/models at runtime;
    // this static list is the fallback when the daemon is unreachable.
    'gpt-5.4-nano',
    'gpt-5.4-mini',
    'claude-opus-4-6',
  ],
};

// "Fast / cheap" model recommendation for each protocol. Used by the
// memory extractor's auto-mode pill ("we'll quietly run gpt-4o-mini on
// your OpenAI key") and by anyone else who needs a one-pick default
// that prioritises latency + cost over reasoning depth.
export const FAST_MODEL_BY_PROTOCOL: Record<ApiProtocol, string> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-4o-mini',
  azure: 'gpt-4o-mini',
  google: 'gemini-2.0-flash',
  foundry: 'gpt-5.4-nano',
};

export const API_PROTOCOL_TABS: ReadonlyArray<{
  id: ApiProtocol;
  title: string;
}> = [
  { id: 'anthropic', title: 'Anthropic' },
  { id: 'openai', title: 'OpenAI' },
  { id: 'azure', title: 'Azure OpenAI' },
  { id: 'google', title: 'Google Gemini' },
  { id: 'foundry', title: 'ArrowFlow Agent' },
];

export const API_PROTOCOL_LABELS: Record<ApiProtocol, string> = {
  anthropic: 'Anthropic API',
  openai: 'OpenAI API',
  azure: 'Azure OpenAI',
  google: 'Google Gemini',
  foundry: 'ArrowFlow Agent',
};

export const API_KEY_PLACEHOLDERS: Record<ApiProtocol, string> = {
  anthropic: 'sk-ant-...',
  openai: 'sk-...',
  azure: 'azure key',
  google: 'AIza...',
  foundry: '',
};

// Default base URL the daemon assumes when the user leaves the field
// blank. Kept here so the BYOK form can render it as a placeholder
// hint and keep the two surfaces (form vs. daemon) in sync.
export const DEFAULT_BASE_URL_BY_PROTOCOL: Record<ApiProtocol, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  azure: '',
  google: 'https://generativelanguage.googleapis.com',
  foundry: '',
};
