import { describe, expect, it } from 'vitest';
import {
  All,
  Anthropic,
  Custom,
  DeepSeek,
  Gemini,
  Groq,
  OpenAI,
  OpenRouter,
  Xiaomi,
  chatModels,
  fromKey,
  fromUrl,
  pickDefault,
  providerIdFromUrl,
} from '../src/main/brain/brainProviders';

describe('BrainProviders', () => {
  it('All lists the eight services ending with Custom', () => {
    expect(All.map((p) => p.id)).toEqual([
      'deepseek',
      'openrouter',
      'openai',
      'groq',
      'gemini',
      'anthropic',
      'xiaomi',
      'custom',
    ]);
    expect(Custom.isCustom).toBe(true);
    expect(DeepSeek.preferredModels).toContain('deepseek-chat');
  });

  it('FromKey matches C# heuristics', () => {
    expect(fromKey('tp-abc')?.id).toBe(Xiaomi.id);
    expect(fromKey('ttp-abc')?.id).toBe(Xiaomi.id);
    expect(fromKey('sk-or-v1-xyz')?.id).toBe(OpenRouter.id);
    expect(fromKey('sk-ant-api03-x')?.id).toBe(Anthropic.id);
    expect(fromKey('gsk_abc')?.id).toBe(Groq.id);
    expect(fromKey('AIzaSyAbc')?.id).toBe(Gemini.id);
    expect(fromKey('sk-' + 'a'.repeat(32))?.id).toBe(DeepSeek.id);
    expect(fromKey('sk-proj-longenough')?.id).toBe(OpenAI.id);
    expect(fromKey('sk-svcacct-x')?.id).toBe(OpenAI.id);
    expect(fromKey('sk-' + 'x'.repeat(43))?.id).toBe(OpenAI.id); // length >= 45 with sk-
    expect(fromKey('sk-short')).toBeNull();
    expect(fromKey('random')).toBeNull();
  });

  it('FromUrl strips /chat/completions and falls back to Custom', () => {
    expect(fromUrl('https://api.deepseek.com/v1').id).toBe(DeepSeek.id);
    expect(fromUrl('https://api.deepseek.com/v1/').id).toBe(DeepSeek.id);
    expect(fromUrl('https://api.deepseek.com/v1/chat/completions').id).toBe(DeepSeek.id);
    expect(fromUrl('https://example.com/v1').id).toBe(Custom.id);
    expect(providerIdFromUrl('')).toBe(DeepSeek.id);
  });

  it('ChatModels drops non-chat ids and strips models/ prefix', () => {
    expect(chatModels(['gpt-4o-mini', 'text-embedding-3', 'whisper-1', 'models/gemini-2.5-flash'])).toEqual([
      'gpt-4o-mini',
      'gemini-2.5-flash',
    ]);
  });

  it('PickDefault prefers exact then substring then first', () => {
    expect(pickDefault(DeepSeek, ['other', 'deepseek-chat'])).toBe('deepseek-chat');
    expect(pickDefault(DeepSeek, ['prefix-deepseek-flash-suffix'])).toBe('prefix-deepseek-flash-suffix');
    expect(pickDefault(DeepSeek, ['only-one'])).toBe('only-one');
    expect(pickDefault(DeepSeek, [])).toBe('deepseek-flash');
  });
});
