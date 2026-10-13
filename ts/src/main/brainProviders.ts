// Minimal BrainProviders port for settings migration (FromUrl → provider id).
// Full provider UI comes later with Brain*.

export interface BrainProvider {
  id: string;
  name: string;
  baseUrl: string;
  isCustom: boolean;
}

const ALL: BrainProvider[] = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', isCustom: false },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', isCustom: false },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', isCustom: false },
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', isCustom: false },
  {
    id: 'gemini',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    isCustom: false,
  },
  { id: 'anthropic', name: 'Anthropic (Claude)', baseUrl: 'https://api.anthropic.com/v1', isCustom: false },
  { id: 'xiaomi', name: 'Xiaomi MiMo', baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1', isCustom: false },
  { id: 'custom', name: '', baseUrl: '', isCustom: true },
];

export const DEEPSEEK = ALL[0]!;

/** The service a saved address belongs to; custom for anything else. */
export function fromUrl(url: string): BrainProvider {
  let u = url.trim().replace(/\/+$/, '');
  if (u.toLowerCase().endsWith('/chat/completions')) {
    u = u.slice(0, -'/chat/completions'.length);
  }
  const hit = ALL.find((p) => !p.isCustom && p.baseUrl.toLowerCase() === u.toLowerCase());
  return hit ?? ALL[ALL.length - 1]!;
}

export function providerIdFromUrl(url: string): string {
  if (!url || !url.trim()) return DEEPSEEK.id;
  return fromUrl(url).id;
}
