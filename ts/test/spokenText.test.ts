// Voice punctuation and spoken numbers (IDEAS №9, approved batch 2 item 1): core table, settings,
// the «Словарь» switches and a dictation take with the passes on and off.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyLanguage } from '../src/core/strings';
import { SAMPLE_RATE } from '../src/core/takeBuffer';
import { applySpoken, applySpokenNumbers, applySpokenPunctuation } from '../src/core/spokenText';
import * as Settings from '../src/main/settings';
import { DictionaryController } from '../src/main/dictionary/dictionaryPage';
import { DictationSession, type RecognizerLike } from '../src/main/dictation/dictationSession';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'chawo-spoken-'));
  process.env.CHAWO_LOCALAPPDATA = join(dir, 'local');
  process.env.CHAWO_APPDATA = join(dir, 'roaming');
  applyLanguage('Russian');
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.CHAWO_LOCALAPPDATA;
  delete process.env.CHAWO_APPDATA;
});

describe('voice punctuation', () => {
  const cases: [string, string][] = [
    // v3 models put their own marks around the command word; exactly one mark is left.
    ['Привет, запятая, как дела, вопросительный знак.', 'Привет, как дела?'],
    ['привет запятая как дела вопросительный знак', 'привет, как дела?'],
    ['Готово точка. Завтра продолжим точка', 'Готово. Завтра продолжим.'],
    ['готово точка завтра продолжим', 'готово. Завтра продолжим'],
    ['Пункт один двоеточие хлеб, точка с запятой, молоко.', 'Пункт один: хлеб; молоко.'],
    ['Список: хлеб точка, с запятой молоко', 'Список: хлеб; молоко'],
    ['Это тире наш продукт.', 'Это — наш продукт.'],
    ['Сделай что дефис нибудь', 'Сделай что-нибудь'],
    ['Цена открыть скобку без НДС закрыть скобку, сто рублей.', 'Цена (без НДС), сто рублей.'],
    ['Он сказал открыть кавычки привет закрыть кавычки.', 'Он сказал «привет».'],
    ['Первая строка. Новая строка. Вторая строка.', 'Первая строка.\nВторая строка.'],
    ['Первый абзац новый абзац второй', 'Первый абзац\n\nВторой'],
    ['Итак многоточие продолжим', 'Итак… Продолжим'],
    ['Ура восклицательный знак', 'Ура!'],
    ['Как дела знак вопроса', 'Как дела?'],
    // A comma after the model's own sentence end lowers the capital the model gave.
    ['Привет запятая. Как дела', 'Привет, как дела'],
    // Acronyms keep their capitals.
    ['Привет запятая. CPU греется', 'Привет, CPU греется'],
    // ё and capitals in the command word do not matter.
    ['Привет ЗАПЯТАЯ мир', 'Привет, мир'],
    // «точка» as a noun stays a word.
    ['Это точка зрения клиента.', 'Это точка зрения клиента.'],
    ['Наша торговая точка работает.', 'Наша торговая точка работает.'],
    ['Конечная точка доступа', 'Конечная точка доступа'],
    // Words that only contain a command are left alone.
    ['Запятаями не злоупотребляй, тирекс', 'Запятаями не злоупотребляй, тирекс'],
  ];
  it.each(cases)('%j → %j', (input, want) => {
    expect(applySpokenPunctuation(input)).toBe(want);
  });

  it('real v3 e2e output from the box smoke (piper speech) gets its marks', () => {
    const heard = 'Встреча 5, в офисе. Бюджет 25 000 ₽, вопросительный знак, новая строка. Скидка: открыть скобку до конца месяца закрыть скобку 10%.';
    expect(applySpoken(heard, { SpokenPunctuation: true, SpokenNumbers: true }))
      .toBe('Встреча 5, в офисе. Бюджет 25 000 ₽?\nСкидка: (до конца месяца) 10%.');
  });

  it('text without commands comes back as the same string', () => {
    const s = 'Обычная фраза, без команд.';
    expect(applySpokenPunctuation(s)).toBe(s);
    expect(applySpokenPunctuation('')).toBe('');
  });
});

describe('spoken numbers', () => {
  const cases: [string, string][] = [
    ['двадцать пять рублей', '25 рублей'],
    ['за двадцать минут', 'за 20 минут'],
    ['Пять минут', '5 минут'],
    ['сто один', '101'],
    ['двести двадцать два', '222'],
    ['тысяча двести', '1200'],
    ['три миллиона пятьсот тысяч', '3500000'],
    ['две тысячи двадцать шестого года', '2026-го года'],
    ['двадцать пятое октября', '25-е октября'],
    ['в двадцать первом веке', 'в 21-м веке'],
    ['восемь девятьсот шестнадцать', '8 916'],
    ['одиннадцать два', '11 2'],
    ['ноль пять', '0 5'],
    ['от трёх до пяти дней', 'от 3 до 5 дней'],
    ['двадцать один день', '21 день'],
    // Left as words: a lone «один», a scale word without digits, a lone ordinal, look-alikes.
    ['один из лучших', 'один из лучших'],
    ['тысячи людей', 'тысячи людей'],
    ['пятое октября', 'пятое октября'],
    ['всей семью поехали', 'всей семью поехали'],
    ['Пятничный отчёт', 'Пятничный отчёт'],
    // Digits already there are kept.
    ['2 тысячи', '2 тысячи'],
  ];
  it.each(cases)('%j → %j', (input, want) => {
    expect(applySpokenNumbers(input)).toBe(want);
  });
});

describe('applySpoken switches', () => {
  it('each pass only when on, punctuation first', () => {
    const t = 'двадцать пять запятая тридцать';
    expect(applySpoken(t, {})).toBe(t);
    expect(applySpoken(t, { SpokenPunctuation: true })).toBe('двадцать пять, тридцать');
    expect(applySpoken(t, { SpokenNumbers: true })).toBe('25 запятая 30');
    expect(applySpoken(t, { SpokenPunctuation: true, SpokenNumbers: true })).toBe('25, 30');
  });
});

describe('settings and «Словарь» switches', () => {
  it('off by default; round trip through settings.json', () => {
    const d = Settings.defaults();
    expect(d.SpokenPunctuation).toBe(false);
    expect(d.SpokenNumbers).toBe(false);
    d.SpokenPunctuation = true;
    d.SpokenNumbers = true;
    const back = Settings.fromJsonObject(Settings.toJsonObject(d)).settings;
    expect(back.SpokenPunctuation).toBe(true);
    expect(back.SpokenNumbers).toBe(true);
    expect(Settings.fromJsonObject({ SpokenPunctuation: 'yes', SpokenNumbers: 1 }).settings.SpokenPunctuation).toBe(false);
  });

  it('two switches with hints; saved once per real change', () => {
    const s = Settings.defaults();
    let saves = 0;
    let changes = 0;
    const ctl = new DictionaryController({ settings: () => s, save: () => void saves++, changed: () => void changes++ });
    const st = ctl.state();
    expect(st.spoken.punctuation).toBe(false);
    expect(st.spoken.numbers).toBe(false);
    expect(st.spoken.punctuationLabel).toBe('Знаки препинания голосом');
    expect(st.spoken.numbersLabel).toBe('Числа цифрами');
    expect(st.spoken.punctuationHint).toContain('«новая строка»');
    expect(ctl.setSpoken('punctuation', true).spoken.punctuation).toBe(true);
    expect(s.SpokenPunctuation).toBe(true);
    expect(saves).toBe(1);
    ctl.setSpoken('punctuation', true);
    expect(saves).toBe(1);
    expect(ctl.setSpoken('numbers', true).spoken.numbers).toBe(true);
    expect(s.SpokenNumbers).toBe(true);
    ctl.setSpoken('bogus' as never, false);
    ctl.setSpoken('numbers', 'x' as never);
    expect(s.SpokenNumbers).toBe(true);
    expect([saves, changes]).toEqual([2, 2]);
    applyLanguage('English');
    expect(ctl.state().spoken.numbersLabel).toBe('Numbers as digits');
    applyLanguage('Russian');
  });
});

class FakeRecognizer implements RecognizerLike {
  readonly kind = 'v3_e2e_rnnt' as const;
  readonly modelId = 'v3_e2e_rnnt';
  deviceActual = 'cpu';
  deviceNote: string | null = null;
  intraOpThreads = 4;
  reply = '';
  async transcribeCancelable(): Promise<string> {
    return this.reply;
  }
  cancelOwned(): void {}
  async dispose(): Promise<void> {}
}

function speech(seconds = 1, amp = 0.3): Float32Array {
  const n = Math.round(seconds * SAMPLE_RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (i > n * 0.3 && i < n * 0.7 ? amp : 0) * Math.sin(i * 0.2) + 0.001 * Math.sin(i * 1.3);
  return out;
}

describe('dictation take', () => {
  function make(edit: (s: Settings.SettingsData) => void) {
    const s = Settings.defaults();
    edit(s);
    const rec = new FakeRecognizer();
    const copied: string[] = [];
    const sess = new DictationSession({
      settings: () => s,
      push: () => {},
      copy: (t) => void copied.push(t),
      micName: () => 'Mic',
      find: (k) => `/m/${k}`,
      open: async () => rec,
      platform: 'win32',
      partialMs: 0,
    });
    const take = async (reply: string) => {
      rec.reply = reply;
      expect(sess.startTake().ok).toBe(true);
      const x = speech(1);
      for (let i = 0; i < x.length; i += 640) sess.appendPcm(x.subarray(i, i + 640));
      await sess.stopTake();
      return copied[copied.length - 1];
    };
    return { s, take };
  }

  it('off: the phrase goes in as recognized', async () => {
    const { take } = make(() => {});
    expect(await take('Встреча в пять, запятая, в офисе.')).toBe('Встреча в пять, запятая, в офисе.');
  });

  it('on: after the dictionary, before simple syntax', async () => {
    const { take } = make((s) => {
      s.SpokenPunctuation = true;
      s.SpokenNumbers = true;
      s.WordReplacementRules = 'офис -> Office\n';
    });
    expect(await take('Встреча в пять, запятая, в офис, точка.')).toBe('Встреча в 5, в Office.');
  });

  it('on with simple syntax: the closing period from «точка» goes too', async () => {
    const { take } = make((s) => {
      s.SpokenPunctuation = true;
      s.SimpleSyntax = true;
    });
    expect(await take('Привет запятая как дела точка')).toBe('привет, как дела');
  });
});
