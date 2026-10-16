// «Статистика разговора» (COMPETITORS.md п.7, как Gong): доля речи по спикерам, монологи, вопросы,
// темп и трекеры ключевых слов. Считается локально по фразам со временем (.srt / .json / .txt с метками);
// без диаризации — один «спикер», трекеры и темп всё равно работают. Ничего не уходит в сеть.

import type { TranscriptSegment } from './transcriptFormat';

/** Один трекер: название и термины. «скидк*» — начало слова, «следующий шаг» — фраза подряд. */
export interface Tracker {
  name: string;
  terms: string[];
}

export interface TrackerHit {
  /** Секунды от начала записи. */
  start: number;
  /** 0-based, как в TranscriptSegment; нет — без диаризации. */
  speaker?: number;
  /** Первый сработавший термин (как написан в трекере); фраза в hits одна на трекер. */
  term: string;
  text: string;
}

export interface TrackerResult {
  name: string;
  terms: string[];
  count: number;
  hits: TrackerHit[];
}

export interface SpeakerStats {
  /** 0-based; -1 = речь без метки спикера. */
  speaker: number;
  talkSeconds: number;
  /** 0..1 от всего времени речи. */
  share: number;
  words: number;
  phrases: number;
  questions: number;
  /** Слов в минуту речи; 0, если времени нет. */
  wpm: number;
  longestMonologueSeconds: number;
}

export interface Monologue {
  speaker: number;
  start: number;
  end: number;
  seconds: number;
}

export interface CallStats {
  /** От первой фразы до конца последней. */
  durationSeconds: number;
  talkSeconds: number;
  words: number;
  phrases: number;
  /** Есть ли метки спикеров (без них доля речи — 100 % у одного). */
  diarized: boolean;
  speakers: SpeakerStats[];
  /** Смен говорящего (только с диаризацией). */
  turns: number;
  /** Смен говорящего в минуту (интерактивность). */
  turnsPerMinute: number;
  longestMonologue: Monologue | null;
  /** Монологов длиннее MONOLOGUE_LONG_SECONDS. */
  longMonologues: number;
  trackers: TrackerResult[];
}

/** Порог «длинного монолога», как ориентир у Gong (~1 мин у менеджера — уже много). */
export const MONOLOGUE_LONG_SECONDS = 60;
/** Пауза между фразами одного спикера, после которой монолог считается прерванным. */
export const MONOLOGUE_GAP_SECONDS = 5;

/** Встроенные трекеры для звонков продаж; пустая настройка = эти. */
export const DEFAULT_TRACKERS_TEXT = [
  'Цена: цен*, стоимост*, дорог*, бюджет*, прайс*',
  'Скидка: скидк*, акци*, дешевле',
  'Конкуренты: конкурент*, у других, аналог*',
  'Сроки: срок*, когда, доставк*, до конца месяца, до пятниц*, к понедельнику, к пятниц*',
  'Следующий шаг: созвон*, встреч*, пришл*, отправл*, договорил*, следующий шаг',
  'Возражения: подумаю, не сейчас, не нужно, нет бюджета, дорого',
].join('\n');

const MAX_TRACKERS = 30;
const MAX_TERMS = 40;
const MAX_HITS_PER_TRACKER = 200;

/** ё = е, нижний регистр. */
export function normalizeWord(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е');
}

/** Слова фразы (буквы/цифры/дефис внутри слова). */
export function wordsOf(text: string): string[] {
  return normalizeWord(text ?? '').match(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu) ?? [];
}

/**
 * «Название: термин, термин» — по строке на трекер. Строки без двоеточия: название = сами термины.
 * Пустые строки и «#…» пропускаются. Пустой текст — встроенные трекеры.
 */
export function parseTrackers(text: string | null | undefined): Tracker[] {
  const src = (text ?? '').trim() ? (text as string) : DEFAULT_TRACKERS_TEXT;
  const list: Tracker[] = [];
  for (const raw of src.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    const name = (colon > 0 ? line.slice(0, colon) : line).trim().slice(0, 60);
    const body = colon > 0 ? line.slice(colon + 1) : line;
    const terms = body.split(/[,;]/).map((x) => x.trim()).filter((x) => wordsOf(x.replace(/\*/g, '')).length > 0).slice(0, MAX_TERMS);
    if (!name || terms.length === 0) continue;
    list.push({ name, terms });
    if (list.length >= MAX_TRACKERS) break;
  }
  return list;
}

/** Обратно в текст для поля настройки. */
export function formatTrackers(list: readonly Tracker[]): string {
  return list.map((t) => `${t.name}: ${t.terms.join(', ')}`).join('\n');
}

interface CompiledTerm {
  term: string;
  words: string[];
  /** Последнее слово — начало («*»). */
  prefix: boolean;
}

function compileTerm(term: string): CompiledTerm | null {
  const prefix = /\*\s*$/.test(term);
  const words = wordsOf(term.replace(/\*/g, ' '));
  if (words.length === 0) return null;
  return { term: term.trim(), words, prefix };
}

/** Сколько раз термин встречается в словах фразы. */
function countTerm(words: readonly string[], c: CompiledTerm): number {
  let n = 0;
  const k = c.words.length;
  for (let i = 0; i + k <= words.length; i++) {
    let ok = true;
    for (let j = 0; j < k; j++) {
      const w = words[i + j];
      const want = c.words[j];
      const last = j === k - 1;
      if (last && c.prefix ? !w.startsWith(want) : w !== want) {
        ok = false;
        break;
      }
    }
    if (ok) {
      n++;
      i += k - 1;
    }
  }
  return n;
}

function hasSpeakers(segments: readonly TranscriptSegment[]): boolean {
  return segments.some((s) => typeof s.speaker === 'number' && s.speaker >= 0);
}

function spk(s: TranscriptSegment): number {
  return typeof s.speaker === 'number' && s.speaker >= 0 ? Math.floor(s.speaker) : -1;
}

/**
 * Длительность фразы. У .txt с метками end = начало следующей (вместе с паузой) — берём как есть,
 * но не больше 30 с на фразу, чтобы длинная тишина не делала спикера «болтливым».
 */
function segSeconds(s: TranscriptSegment): number {
  const d = (Number.isFinite(s.end) ? s.end : s.start) - s.start;
  return d > 0 ? Math.min(d, 30) : 0;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

export function computeCallStats(segments: readonly TranscriptSegment[], trackers: readonly Tracker[] = parseTrackers('')): CallStats {
  const segs = segments.filter((s) => (s.text ?? '').trim() && Number.isFinite(s.start)).slice().sort((a, b) => a.start - b.start);
  const diarized = hasSpeakers(segs);
  const by = new Map<number, SpeakerStats>();
  const get = (id: number) => {
    let v = by.get(id);
    if (!v) {
      v = { speaker: id, talkSeconds: 0, share: 0, words: 0, phrases: 0, questions: 0, wpm: 0, longestMonologueSeconds: 0 };
      by.set(id, v);
    }
    return v;
  };
  const compiled = trackers.map((t) => ({ t, cs: t.terms.map(compileTerm).filter((c): c is CompiledTerm => c !== null) }));
  const results: TrackerResult[] = trackers.map((t) => ({ name: t.name, terms: [...t.terms], count: 0, hits: [] }));

  let talk = 0;
  let words = 0;
  let turns = 0;
  let prevSpeaker: number | null = null;
  const monologues: Monologue[] = [];
  let cur: Monologue | null = null;

  for (const s of segs) {
    const id = diarized ? spk(s) : -1;
    const sec = segSeconds(s);
    const ws = wordsOf(s.text);
    const st = get(id);
    st.talkSeconds += sec;
    st.words += ws.length;
    st.phrases++;
    if (s.text.includes('?')) st.questions++;
    talk += sec;
    words += ws.length;

    if (diarized && id >= 0) {
      if (prevSpeaker !== null && prevSpeaker !== id) turns++;
      prevSpeaker = id;
    }
    const end = s.start + sec;
    if (cur && cur.speaker === id && s.start - cur.end <= MONOLOGUE_GAP_SECONDS) {
      cur.end = Math.max(cur.end, end);
    } else {
      if (cur) monologues.push(cur);
      cur = { speaker: id, start: s.start, end, seconds: 0 };
    }

    // One hit per phrase and tracker (the first term that matched); count adds every occurrence.
    compiled.forEach(({ cs }, ti) => {
      let first: string | null = null;
      let n = 0;
      for (const c of cs) {
        const k = countTerm(ws, c);
        if (k === 0) continue;
        n += k;
        first ??= c.term;
      }
      if (n === 0 || first === null) return;
      const r = results[ti];
      r.count += n;
      if (r.hits.length < MAX_HITS_PER_TRACKER) {
        const hit: TrackerHit = { start: s.start, term: first, text: s.text.trim() };
        if (diarized && id >= 0) hit.speaker = id;
        r.hits.push(hit);
      }
    });
  }
  if (cur) monologues.push(cur);
  let longest: Monologue | null = null;
  let longMonologues = 0;
  for (const m of monologues) {
    m.seconds = round1(Math.max(0, m.end - m.start));
    const st = by.get(m.speaker);
    if (st && m.seconds > st.longestMonologueSeconds) st.longestMonologueSeconds = m.seconds;
    if (m.seconds >= MONOLOGUE_LONG_SECONDS) longMonologues++;
    if (!longest || m.seconds > longest.seconds) longest = m;
  }
  const speakers = [...by.values()].sort((a, b) => (a.speaker < 0 ? 1 : b.speaker < 0 ? -1 : a.speaker - b.speaker));
  for (const st of speakers) {
    st.share = talk > 0 ? st.talkSeconds / talk : speakers.length === 1 ? 1 : 0;
    st.wpm = st.talkSeconds > 0 ? Math.round(st.words / (st.talkSeconds / 60)) : 0;
    st.talkSeconds = round1(st.talkSeconds);
  }
  const first = segs[0];
  const last = segs[segs.length - 1];
  const duration = first && last ? Math.max(0, Math.max(last.end, last.start + segSeconds(last)) - first.start) : 0;
  return {
    durationSeconds: round1(duration),
    talkSeconds: round1(talk),
    words,
    phrases: segs.length,
    diarized,
    speakers,
    turns,
    turnsPerMinute: duration > 0 ? round1(turns / (duration / 60)) : 0,
    longestMonologue: longest && longest.seconds > 0 ? longest : null,
    longMonologues,
    trackers: results,
  };
}

/** mm:ss или h:mm:ss. */
export function shortClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function speakerName(id: number, t: (ru: string, en: string) => string): string {
  return id < 0 ? t('Речь', 'Speech') : t(`Спикер ${id + 1}`, `Speaker ${id + 1}`);
}

/** Текстовый отчёт: то же, что карточка в окне, для CLI и .stats.txt. */
export function formatCallStats(st: CallStats, t: (ru: string, en: string) => string, opts: { hits?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push(t(`Длительность: ${shortClock(st.durationSeconds)}, речь: ${shortClock(st.talkSeconds)}, слов: ${st.words}, фраз: ${st.phrases}`,
    `Duration: ${shortClock(st.durationSeconds)}, speech: ${shortClock(st.talkSeconds)}, words: ${st.words}, phrases: ${st.phrases}`));
  if (!st.diarized) lines.push(t('Спикеры не размечены — доля речи по спикерам недоступна (включите «Разделять по спикерам»).',
    'No speaker labels — talk ratio per speaker is unavailable (turn on «Split by speakers»).'));
  lines.push('');
  lines.push(t('Доля речи:', 'Talk ratio:'));
  for (const s of st.speakers) {
    const pct = Math.round(s.share * 100);
    lines.push(t(
      `  ${speakerName(s.speaker, t)}: ${pct}% (${shortClock(s.talkSeconds)}), слов ${s.words}, ${s.wpm} сл/мин, вопросов ${s.questions}, самый длинный монолог ${shortClock(s.longestMonologueSeconds)}`,
      `  ${speakerName(s.speaker, t)}: ${pct}% (${shortClock(s.talkSeconds)}), ${s.words} words, ${s.wpm} wpm, ${s.questions} questions, longest monologue ${shortClock(s.longestMonologueSeconds)}`,
    ));
  }
  if (st.diarized) {
    lines.push(t(`Смен говорящего: ${st.turns} (${st.turnsPerMinute} в минуту)`, `Speaker switches: ${st.turns} (${st.turnsPerMinute} per minute)`));
  }
  if (st.longestMonologue) {
    const m = st.longestMonologue;
    lines.push(t(`Самый длинный монолог: ${speakerName(m.speaker, t)}, ${shortClock(m.seconds)} (с ${shortClock(m.start)})`,
      `Longest monologue: ${speakerName(m.speaker, t)}, ${shortClock(m.seconds)} (at ${shortClock(m.start)})`));
  }
  if (st.longMonologues > 0) lines.push(t(`Монологов дольше минуты: ${st.longMonologues}`, `Monologues over a minute: ${st.longMonologues}`));
  if (st.trackers.length > 0) {
    lines.push('');
    lines.push(t('Трекеры слов:', 'Keyword trackers:'));
    for (const r of st.trackers) {
      lines.push(`  ${r.name}: ${r.count}`);
      if (opts.hits) {
        for (const h of r.hits) {
          const who = typeof h.speaker === 'number' ? speakerName(h.speaker, t) + ': ' : '';
          lines.push(`    [${shortClock(h.start)}] ${who}${h.text}`);
        }
      }
    }
  }
  return lines.join('\n') + '\n';
}
