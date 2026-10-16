import { describe, expect, it } from 'vitest';
import {
  actionLabel,
  looksLikeRefusal,
  parseCommand,
  serverConfigured,
  stripAddress,
  stripThink,
} from '../src/brain/brain';

describe('Brain', () => {
  it('ParseCommand finds the last address', () => {
    expect(parseCommand('просто текст')).toBeNull();
    expect(parseCommand('текст. Чаво, исправь')).toEqual({ body: 'текст.', command: 'исправь' });
    expect(parseCommand('call Chawo, translate')).toEqual({ body: 'call', command: 'translate' });
    expect(parseCommand('скажи гига писарю привет. Чаво, короче')).toEqual({
      body: 'скажи гига писарю привет.',
      command: 'короче',
    });
    // legacy alone
    const legacy = parseCommand('готово. писарь, исправь');
    expect(legacy?.command).toBe('исправь');
    expect(legacy?.body).toMatch(/готово/);
  });

  it('StripAddress removes a leading address', () => {
    expect(stripAddress('Чаво, сделай короче')).toBe('сделай короче');
    expect(stripAddress('chawo fix it')).toBe('fix it');
  });

  it('ActionLabel picks verbs', () => {
    expect(actionLabel('переведи на англ')).toMatch(/Перевожу|Translating/);
    expect(actionLabel('сделай короче')).toMatch(/Сокращаю|Shortening/);
    expect(actionLabel('исправь ошибки')).toMatch(/Исправляю|Fixing/);
    expect(actionLabel(null)).toMatch(/Причёсываю|Polishing/);
  });

  it('ServerConfigured needs url+model and a key unless custom', () => {
    expect(serverConfigured('https://api.deepseek.com/v1', 'deepseek-chat', '')).toBe(false);
    expect(serverConfigured('https://api.deepseek.com/v1', 'deepseek-chat', 'sk')).toBe(true);
    expect(serverConfigured('http://127.0.0.1:1234/v1', 'local', '')).toBe(true);
    expect(serverConfigured('bad', 'm', 'k')).toBe(false);
  });

  it('LooksLikeRefusal and StripThink', () => {
    expect(looksLikeRefusal("I'm sorry, I can't help with that", 'hello world')).toBe(true);
    expect(looksLikeRefusal('hello world', 'hello world')).toBe(false);
    expect(looksLikeRefusal("i can't swim", "i can't swim today")).toBe(false);
    expect(stripThink('a <think>x</think> b')).toBe('a  b');
    expect(stripThink('noise</think>answer')).toBe('answer');
  });
});
