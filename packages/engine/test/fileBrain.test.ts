import { describe, expect, it } from 'vitest';
import {
  bullets,
  cloudName,
  describe as describeTarget,
  group,
  isFaithful,
  outputPath,
  paragraphsOf,
  runAsync,
  runWithAsk,
  splitLong,
  target,
} from '../src/brain/fileBrain';
import type { SettingsData } from '../src/settings';
import { defaults } from '../src/settings';

function settings(over: Partial<SettingsData> = {}): SettingsData {
  return { ...defaults(), ...over };
}

describe('FileBrain helpers', () => {
  it('OutputPath / Target / Describe', () => {
    expect(outputPath('/tmp/a.txt')).toBe('/tmp/a.brain.txt');
    expect(target(settings({ Brain: 'Off' }))).toBe('None');
    expect(
      target(
        settings({
          Brain: 'Server',
          CleanupEndpointUrl: 'https://api.deepseek.com/v1',
          CleanupModel: 'deepseek-chat',
          CleanupApiKey: 'k',
        }),
      ),
    ).toBe('Cloud');
    const cloud = settings({
      Brain: 'Server',
      CleanupEndpointUrl: 'https://api.deepseek.com/v1',
      CleanupModel: 'm',
      CleanupApiKey: 'k',
    });
    expect(describeTarget(cloud)).toMatch(/DeepSeek/);
  });

  it('Paragraphs / SplitLong / Bullets / IsFaithful / Group', () => {
    const segs = [
      { start: 0, end: 1, text: 'Hello world.' },
      { start: 1, end: 2, text: 'Second piece.' },
    ];
    const paras = paragraphsOf(segs);
    expect(paras.length).toBeGreaterThanOrEqual(1);
    expect(paras[0].start).toBe(0);

    expect(splitLong('abc', 10)).toEqual(['abc']);
    const long = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ');
    expect(splitLong(long, 40).every((p) => p.length <= 40)).toBe(true);

    expect(bullets('Кратко:\n- one\n* two\n3) three\n')).toBe('- one\n- two\n- three');
    expect(isFaithful('almost same length text here!!', 'almost same length text here!!')).toBe(true);
    expect(isFaithful('x', 'a'.repeat(100))).toBe(false);
    expect(isFaithful("I'm sorry I cannot help", 'normal dictation')).toBe(false);

    expect(group(['aa', 'bb', 'cccc'], 5)).toEqual(['aa', 'bb', 'cccc']);
  });

  it('RunAsync cleans paragraphs with an injected ask', async () => {
    const segs = [
      { start: 0, end: 1, text: 'Эээ ну вот это тест номер один для абзаца.' },
      { start: 1, end: 2, text: 'Второй абзац тоже достаточно длинный текст.' },
    ];
    const asks: string[] = [];
    const result = await runAsync(
      settings({ Brain: 'Server', CleanupEndpointUrl: 'https://api.deepseek.com/v1', CleanupModel: 'm', CleanupApiKey: 'k' }),
      'Cloud',
      segs,
      true,
      () => undefined,
      new AbortController().signal,
      async (prompt, text) => {
        asks.push(prompt.slice(0, 20));
        if (prompt.includes('key points') || prompt.includes('Merge')) return '- point one\n- point two';
        return text.replace(/Эээ |ну |вот /gi, '');
      },
    );
    expect(result.paragraphs).toBeGreaterThanOrEqual(1);
    expect(result.text).toContain('Кратко');
    expect(result.text).toContain('- point');
    expect(asks.length).toBeGreaterThan(1);
  });
});

describe('runWithAsk (shared by the page and the CLI)', () => {
  it('same output as runAsync with the same ask; None → error', async () => {
    const segs = [{ start: 0, end: 3, text: 'Ну, привет всем.' }];
    const ask = async (prompt: string, text: string) => (prompt.includes('Remove only filler words') ? text.replace('Ну, ', '') : '- Привет');
    const ac = new AbortController();
    const a = await runWithAsk('Local', segs, true, () => undefined, ac.signal, ask);
    const b = await runAsync({} as never, 'Local', segs, true, () => undefined, ac.signal, ask);
    expect(a).toEqual(b);
    expect(a.text.startsWith('[00:00:00] привет всем.')).toBe(true);
    await expect(runWithAsk('None', segs, true, () => undefined, ac.signal, ask)).rejects.toThrow();
  });
});

describe('cloudName: a server on this computer is not a cloud', () => {
  const server = (url: string) => settings({ Brain: 'Server', CleanupEndpointUrl: url, CleanupModel: 'm' });
  it('loopback with a port → null (no «text leaves» prompt)', () => {
    for (const url of ['http://127.0.0.1:1234/v1', 'http://localhost:11434/v1', 'http://[::1]:8080/v1', 'http://127.0.0.2/v1', 'http://localhost/v1']) {
      expect(cloudName(server(url)), url).toBeNull();
    }
  });
  it('another host is still named, with its port', () => {
    expect(cloudName(server('http://192.168.1.20:8080/v1'))).toBe('192.168.1.20:8080');
    expect(cloudName(server('http://127.0.0.1.example.com/v1'))).toBe('127.0.0.1.example.com');
  });
});
