// Speech services for «Голос». Three ways to ask for audio:
//   'speech'  OpenAI-compatible POST {base}/audio/speech → audio bytes (OpenAI, OpenRouter, OmniRoute, Groq, own)
//   'mimo'    Xiaomi MiMo: POST {base}/chat/completions with an `audio` object → base64 WAV in the message
//   'gemini'  Google Gemini: POST {base}/models/{model}:generateContent with AUDIO output → base64 PCM
// The key of a service is shared with the Brain when both use the same service (ProviderKeys[id]).
// Nothing is sent anywhere until the user picks a service on «Голос» and presses «Озвучить».
import { t } from '@chawo/core/strings';

export type TtsKind = 'speech' | 'mimo' | 'gemini';

export interface TtsProvider {
  id: string;
  name: string;
  kind: TtsKind;
  /** Default address; for 'tts-custom' empty (the user types it). */
  baseUrl: string;
  /** The address can be changed on «Голос» (a cluster, a local gateway, an own server). */
  editableUrl: boolean;
  models: string[];
  voices: string[];
  /** What the service returns: WAV pieces are merged, MP3 pieces are joined. */
  format: 'mp3' | 'wav';
  /** Longest piece sent at once (a longer text goes in several requests). */
  maxChars: number;
  keysUrl: string;
  /** False for a local gateway / own server that may work without a key. */
  needsKey: boolean;
  /** A line under the choice: languages, price, what to install. */
  note: () => string;
}

const GEMINI_VOICES = ['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr'];
const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];

export const Xiaomi: TtsProvider = {
  id: 'xiaomi',
  name: 'Xiaomi MiMo',
  kind: 'mimo',
  baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
  editableUrl: true,
  models: ['mimo-v2.5-tts'],
  voices: ['mimo_default', 'Mia', 'Chloe', 'Milo', 'Dean', '冰糖', '茉莉', '苏打', '白桦'],
  format: 'wav',
  maxChars: 1500,
  keysUrl: 'https://platform.xiaomimimo.com/',
  needsKey: true,
  note: () =>
    t(
      'Ключ тот же, что у Мозга (Token Plan, tp-…). TTS в подписке сейчас бесплатный. Голоса официально китайские и английские: русский не заявлен. Адрес — кластер вашего ключа (sgp, cn или ams).',
      'Same key as the Brain (Token Plan, tp-…). TTS is free in the plan for now. Voices are officially Chinese and English: Russian is not listed. The address is your key’s cluster (sgp, cn or ams).',
    ),
};

export const Gemini: TtsProvider = {
  id: 'gemini',
  name: 'Google Gemini',
  kind: 'gemini',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  editableUrl: false,
  models: ['gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts'],
  voices: GEMINI_VOICES,
  format: 'wav',
  maxChars: 3000,
  keysUrl: 'https://aistudio.google.com/apikey',
  needsKey: true,
  note: () => t('Читает по-русски. Есть бесплатный лимит. Ключ тот же, что у Мозга (AIza…).', 'Reads Russian. Has a free tier. Same key as the Brain (AIza…).'),
};

export const OpenAI: TtsProvider = {
  id: 'openai',
  name: 'OpenAI',
  kind: 'speech',
  baseUrl: 'https://api.openai.com/v1',
  editableUrl: false,
  models: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'],
  voices: OPENAI_VOICES,
  format: 'mp3',
  maxChars: 4000,
  keysUrl: 'https://platform.openai.com/api-keys',
  needsKey: true,
  note: () => t('Читает по-русски. Платно, по количеству символов.', 'Reads Russian. Paid per character.'),
};

export const OpenRouter: TtsProvider = {
  id: 'openrouter',
  name: 'OpenRouter',
  kind: 'speech',
  baseUrl: 'https://openrouter.ai/api/v1',
  editableUrl: false,
  models: ['openai/gpt-4o-mini-tts-2025-12-15', 'fish-audio/s2.1-pro-free:free', 'mistralai/voxtral-mini-tts-2603'],
  voices: OPENAI_VOICES,
  format: 'mp3',
  maxChars: 4000,
  keysUrl: 'https://openrouter.ai/keys',
  needsKey: true,
  note: () =>
    t(
      'Модели OpenAI и других; язык зависит от модели. Ключ тот же, что у Мозга (sk-or-…). Бесплатно и по-русски — fish-audio/s2.1-pro-free:free; для бесплатных моделей OpenRouter просит разрешить в настройках приватности бесплатные эндпоинты, которые могут сохранять текст.',
      'OpenAI and other models; the language depends on the model. Same key as the Brain (sk-or-…). Free and Russian: fish-audio/s2.1-pro-free:free; for free models OpenRouter asks to allow, in its privacy settings, free endpoints that may keep the text.',
    ),
};

export const OmniRoute: TtsProvider = {
  id: 'omniroute',
  name: 'OmniRoute',
  kind: 'speech',
  baseUrl: 'http://localhost:20128/v1',
  editableUrl: true,
  models: ['google/gemini-2.5-flash-preview-tts', 'xiaomi-mimo/mimo-v2.5-tts', 'openai/gpt-4o-mini-tts', 'gtts/default'],
  voices: ['Kore', 'mimo_default', 'alloy', 'ru'],
  format: 'mp3',
  maxChars: 4000,
  keysUrl: 'https://github.com/diegosouzapw/OmniRoute',
  needsKey: false,
  note: () =>
    t(
      'Свой шлюз OmniRoute на этом компьютере: модель вида «провайдер/модель». gtts/default с голосом «ru» — бесплатно и по-русски.',
      'Your own OmniRoute gateway on this computer: models as «provider/model». gtts/default with voice «ru» is free and Russian.',
    ),
};

export const Groq: TtsProvider = {
  id: 'groq',
  name: 'Groq',
  kind: 'speech',
  baseUrl: 'https://api.groq.com/openai/v1',
  editableUrl: false,
  models: ['canopylabs/orpheus-v1-english'],
  voices: ['autumn', 'diana', 'hannah', 'austin', 'daniel', 'troy'],
  format: 'wav',
  maxChars: 200,
  keysUrl: 'https://console.groq.com/keys',
  needsKey: true,
  note: () => t('Только английский. Условия модели надо принять в консоли Groq.', 'English only. Accept the model terms in the Groq console first.'),
};

export const Custom: TtsProvider = {
  id: 'tts-custom',
  name: '',
  kind: 'speech',
  baseUrl: '',
  editableUrl: true,
  models: ['tts-1'],
  voices: ['alloy'],
  format: 'mp3',
  maxChars: 4000,
  keysUrl: '',
  needsKey: false,
  note: () =>
    t(
      'Любой сервер с OpenAI-совместимым /v1/audio/speech: openai-edge-tts (голос ru-RU-SvetlanaNeural), Piper, XTTS и другие.',
      'Any server with an OpenAI-compatible /v1/audio/speech: openai-edge-tts (voice ru-RU-SvetlanaNeural), Piper, XTTS and others.',
    ),
};

/**
 * Fish Audio models pick a random voice for each request that names none, so a text read in pieces
 * changed voice from piece to piece. With the voice left empty they get this one, the voice of
 * OpenRouter's own example request for fish-audio/s2.1-pro-free; any voice id from fish.audio works too.
 */
export const FISH_VOICE = 'b347db033a6549378b48d00acb0d06cd';

const isFish = (model: string) => /^fish-audio\//i.test(model.trim());

/** The voice sent: the chosen one; with none, a fixed one for a model that would pick anew per request; '' = the service's own. */
export function voiceFor(model: string, voice: string): string {
  return voice.trim() || (isFish(model) ? FISH_VOICE : '');
}

/** Voices offered under the field: a Fish model takes Fish voice ids, not the service's usual names. */
export function voicesFor(p: TtsProvider, model: string): string[] {
  return isFish(model) ? [FISH_VOICE] : [...p.voices];
}

export const ALL: readonly TtsProvider[] = [Xiaomi, Gemini, OpenAI, OpenRouter, OmniRoute, Groq, Custom];

export function byId(id: string): TtsProvider | null {
  return ALL.find((p) => p.id === id) ?? null;
}

export function title(p: TtsProvider): string {
  return p.id === Custom.id ? t('Свой сервер (OpenAI-совместимый)', 'Own server (OpenAI-compatible)') : p.name;
}
