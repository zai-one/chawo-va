// Known cloud services for the server Brain. Port of src/App/BrainProviders.cs.

import { t } from '../../core/strings';

export interface BrainProvider {
  id: string;
  name: string;
  baseUrl: string;
  preferredModels: string[];
  keysUrl: string;
  /** True when BaseUrl is empty (own LM Studio / Ollama / …). */
  isCustom: boolean;
}

function p(
  id: string,
  name: string,
  baseUrl: string,
  preferredModels: string[],
  keysUrl: string,
): BrainProvider {
  return { id, name, baseUrl, preferredModels, keysUrl, isCustom: baseUrl.length === 0 };
}

export const DeepSeek = p(
  'deepseek',
  'DeepSeek',
  'https://api.deepseek.com/v1',
  ['deepseek-flash', 'deepseek-chat'],
  'https://platform.deepseek.com/api_keys',
);
export const OpenRouter = p(
  'openrouter',
  'OpenRouter',
  'https://openrouter.ai/api/v1',
  ['deepseek/deepseek-chat-v3-0324', 'deepseek/deepseek-chat', 'google/gemini-2.5-flash', 'openai/gpt-4.1-mini'],
  'https://openrouter.ai/keys',
);
export const OpenAI = p('openai', 'OpenAI', 'https://api.openai.com/v1', ['gpt-4.1-mini', 'gpt-4o-mini'], 'https://platform.openai.com/api-keys');
export const Groq = p('groq', 'Groq', 'https://api.groq.com/openai/v1', ['llama-3.3-70b-versatile'], 'https://console.groq.com/keys');
export const Gemini = p(
  'gemini',
  'Google Gemini',
  'https://generativelanguage.googleapis.com/v1beta/openai',
  ['gemini-2.5-flash', 'gemini-2.0-flash'],
  'https://aistudio.google.com/apikey',
);
export const Anthropic = p(
  'anthropic',
  'Anthropic (Claude)',
  'https://api.anthropic.com/v1',
  ['claude-haiku-4-5'],
  'https://console.anthropic.com/settings/keys',
);
/** Xiaomi MiMo Token Plan, Singapore cluster. Off until the user picks this service and pastes a key. */
export const Xiaomi = p(
  'xiaomi',
  'Xiaomi MiMo',
  'https://token-plan-sgp.xiaomimimo.com/v1',
  ['mimo-v2.6-flash'],
  'https://platform.xiaomimimo.com/',
);
export const Custom = p('custom', '', '', [], '');

export const All: readonly BrainProvider[] = [DeepSeek, OpenRouter, OpenAI, Groq, Gemini, Anthropic, Xiaomi, Custom];

/** Alias used by settings migration before the full list lived here. */
export const DEEPSEEK = DeepSeek;

export function title(provider: BrainProvider): string {
  return provider.isCustom ? t('Свой сервер (LM Studio, Ollama…)', 'Own server (LM Studio, Ollama…)') : provider.name;
}

const DEEPSEEK_KEY = /^sk-[0-9a-f]{32}$/;

/** Guesses the service from the look of the key; null when it could be anything. */
export function fromKey(key: string): BrainProvider | null {
  key = key.trim();
  if (key.startsWith('tp-') || key.startsWith('ttp-')) return Xiaomi;
  if (key.startsWith('sk-or-')) return OpenRouter;
  if (key.startsWith('sk-ant-')) return Anthropic;
  if (key.startsWith('gsk_')) return Groq;
  if (key.startsWith('AIza')) return Gemini;
  if (DEEPSEEK_KEY.test(key)) return DeepSeek;
  // Plain "sk-" is used by several services; only OpenAI's long keys are a safe guess.
  if (key.startsWith('sk-proj-') || key.startsWith('sk-svcacct-') || (key.startsWith('sk-') && key.length >= 45)) return OpenAI;
  return null;
}

/** The service a saved address belongs to; Custom for anything else. */
export function fromUrl(url: string): BrainProvider {
  let u = url.trim().replace(/\/+$/, '');
  if (u.toLowerCase().endsWith('/chat/completions')) {
    u = u.slice(0, -'/chat/completions'.length);
  }
  const hit = All.find((x) => !x.isCustom && x.baseUrl.toLowerCase() === u.toLowerCase());
  return hit ?? Custom;
}

export function providerIdFromUrl(url: string): string {
  if (!url || !url.trim()) return DEEPSEEK.id;
  return fromUrl(url).id;
}

const NON_CHAT = /embed|whisper|tts|dall-e|moderation|image|audio|realtime|transcribe|search|guard|imagen|veo|aqa/i;

/** Only chat models are useful here: drop embeddings, speech, images and the like. */
export function chatModels(ids: Iterable<string>): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (NON_CHAT.test(id)) continue;
    out.push(id.startsWith('models/') ? id.slice('models/'.length) : id);
  }
  return out;
}

/** A sensible default among the models the server offers. */
export function pickDefault(provider: BrainProvider, models: readonly string[]): string | null {
  for (const want of provider.preferredModels) {
    const exact = models.find((m) => m.toLowerCase() === want.toLowerCase());
    if (exact) return exact;
    const partial = models.find((m) => m.toLowerCase().includes(want.toLowerCase()));
    if (partial) return partial;
  }
  if (models.length > 0) return models[0]!;
  return provider.preferredModels[0] ?? null;
}
