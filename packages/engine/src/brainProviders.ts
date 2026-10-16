// Thin re-export so settings.ts `providerIdFromUrl` keeps working.
// Full implementation lives in ./brain/brainProviders.

export {
  type BrainProvider,
  DeepSeek,
  OpenRouter,
  OpenAI,
  Groq,
  Gemini,
  Anthropic,
  Xiaomi,
  Custom,
  All,
  DEEPSEEK,
  title,
  fromKey,
  fromUrl,
  providerIdFromUrl,
  chatModels,
  pickDefault,
} from './brain/brainProviders';
