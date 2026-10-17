import { describe, expect, it } from 'vitest';
import { MAX_SPEECH_CHARS, speechInput, splitByScript, splitForSpeech } from '../src/tts/speechText';

describe('text for reading aloud', () => {
  it('folds whitespace, drops invisible characters, caps the length', () => {
    expect(speechInput('  Привет,​   мир!\r\n\r\n\r\n\r\nДальше\tтекст  ')).toBe('Привет, мир!\n\nДальше текст');
    expect(speechInput(' \n\t ')).toBe('');
    expect(speechInput('а'.repeat(MAX_SPEECH_CHARS + 50))).toHaveLength(MAX_SPEECH_CHARS);
  });

  it('cuts long text at sentence ends, never inside a word, and loses nothing', () => {
    const sentence = 'Это предложение для проверки нарезки текста. ';
    const text = sentence.repeat(200).trim();
    const parts = splitForSpeech(text, 500);
    expect(parts.every((p) => p.length <= 500)).toBe(true);
    expect(parts.every((p) => p.endsWith('.'))).toBe(true);
    expect(parts.join(' ')).toBe(text);
  });

  it('falls back to commas and spaces, and hard-cuts only a single giant word', () => {
    const commas = Array.from({ length: 60 }, (_, i) => `часть${i}`).join(', ');
    const parts = splitForSpeech(commas, 100);
    expect(parts.every((p) => p.length <= 100)).toBe(true);
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(commas);
    expect(splitForSpeech('x'.repeat(250), 100)).toEqual(['x'.repeat(100), 'x'.repeat(100), 'x'.repeat(50)]);
    expect(splitForSpeech('коротко', 100)).toEqual(['коротко']);
  });

  it('one language comes back whole; a few foreign words stay inside their sentence', () => {
    expect(splitByScript('Привет, мир. Как дела?')).toEqual(['Привет, мир. Как дела?']);
    expect(splitByScript('Hello world. How are you?')).toEqual(['Hello world. How are you?']);
    expect(splitByScript('Запусти команду npm run build и подожди.')).toEqual(['Запусти команду npm run build и подожди.']);
    expect(splitByScript('Docker Compose поднимает все сервисы, README.md лежит рядом.')).toHaveLength(1);
    expect(splitByScript('2026')).toEqual(['2026']);
  });

  it('Russian and English parts go apart: paragraphs, short sentences, a long quote', () => {
    expect(splitByScript('Hello team, the build is green now.\n\nПривет, всё работает.')).toEqual([
      'Hello team, the build is green now.',
      'Привет, всё работает.',
    ]);
    expect(splitByScript('Спасибо! Thanks a lot! Пока.')).toEqual(['Спасибо!', 'Thanks a lot!', 'Пока.']);
    const quote = 'Он прочитал вслух всю фразу the quick brown fox jumps over the lazy dog и потом долго смеялся над ней.';
    expect(splitByScript(quote)).toEqual([
      'Он прочитал вслух всю фразу',
      'the quick brown fox jumps over the lazy dog',
      'и потом долго смеялся над ней.',
    ]);
    const words = (s: string) => s.split(/\s+/).filter(Boolean);
    expect(words(splitByScript(quote).join(' '))).toEqual(words(quote));
  });
});
