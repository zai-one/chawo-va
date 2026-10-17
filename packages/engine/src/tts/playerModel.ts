// The TTS player window's state (the window itself lives in main, its page in renderer/player.*). The
// audio goes to the page as bytes and plays from a Blob: the page never reaches the network.
import { t } from '@chawo/core/strings';

export type PlayerPhase = 'loading' | 'ready' | 'error';

export interface PlayerState {
  phase: PlayerPhase;
  /** The start of the text being read (or the error). */
  title: string;
  /** Loading / error line under the title. */
  message: string;
  /** Playback speed the page starts with (settings TtsSpeed). */
  rate: number;
  /** The speeds in the player's menu. */
  speeds: number[];
  labels: { play: string; pause: string; close: string; speed: string; again: string; settings: string };
}

/** Speeds offered in the player and on «Голос». */
export const SPEEDS: readonly number[] = [0.75, 1, 1.25, 1.5, 1.75, 2];

export function clampSpeed(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 1;
  return Math.min(2, Math.max(0.5, Math.round(n * 100) / 100));
}

const GAP = 16;

/** Below-right of the pointer, kept inside the work area of its display. */
export function playerPosition(
  area: { x: number; y: number; width: number; height: number },
  pointer: { x: number; y: number },
  w: number,
  h: number,
): { x: number; y: number } {
  let x = pointer.x + GAP;
  let y = pointer.y + GAP;
  if (x + w > area.x + area.width) x = pointer.x - GAP - w;
  if (y + h > area.y + area.height) y = pointer.y - GAP - h;
  x = Math.min(Math.max(x, area.x), area.x + area.width - w);
  y = Math.min(Math.max(y, area.y), area.y + area.height - h);
  return { x: Math.round(x), y: Math.round(y) };
}

/** «Первые слова текста…» for the player's head line. */
export function titleOf(text: string, max = 80): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : one.slice(0, max - 1).trimEnd() + '…';
}

function labels(): PlayerState['labels'] {
  return {
    play: t('Слушать', 'Play'),
    pause: t('Пауза', 'Pause'),
    close: t('Закрыть', 'Close'),
    speed: t('Скорость', 'Speed'),
    again: t('Сначала', 'From the start'),
    settings: t('Настройки голоса', 'Voice settings'),
  };
}

export function loadingState(text: string, rate: number): PlayerState {
  return { phase: 'loading', title: titleOf(text), message: t('Озвучиваю…', 'Making the audio…'), rate: clampSpeed(rate), speeds: [...SPEEDS], labels: labels() };
}

export function readyState(text: string, rate: number): PlayerState {
  return { phase: 'ready', title: titleOf(text), message: '', rate: clampSpeed(rate), speeds: [...SPEEDS], labels: labels() };
}

export function errorState(text: string, error: string, rate: number): PlayerState {
  return { phase: 'error', title: titleOf(text), message: error, rate: clampSpeed(rate), speeds: [...SPEEDS], labels: labels() };
}
