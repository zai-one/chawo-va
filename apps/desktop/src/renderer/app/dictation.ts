// «Диктовка» outside React: the in-window hold button, the global hold key (the Windows helper starts
// the take in main and asks this window to run the mic) and the «Чаво» wake-word microphone. The mic
// lives here; main does the rest. Pages read holdStore / meterStore and call holdDown / holdUp.
import type { DictationStateDto, HotEventDto, WakeWantDto } from '@chawo/ipc/contract';
import { MicCapture } from '../audio/micCapture';
import { playCue } from '../audio/cues';
import { invoke, on, send } from '../bridge';
import { applyDictation as setDictation, dictationStore } from './state';
import { createStore } from './store';

const METER_BARS = 28;
const silence = (): number[] => new Array<number>(METER_BARS).fill(0);

/** Input level history for the bars next to the hold button (newest last). */
export const meterStore = createStore<number[]>(silence());
/** The in-window hold button is down (shown as listening before main confirms). */
export const holdStore = createStore(false);

let startJob: Promise<MicCapture | null> | null = null;
let activeCapture: MicCapture | null = null;

/** Every dictation state from main: the take ended there (cap, Stop, Escape) → release the mic. */
export function applyDictation(s: DictationStateDto): void {
  if (activeCapture && s.phase !== 'Listening') {
    const cap = activeCapture;
    activeCapture = null;
    holdStore.set(false);
    void cap.stop();
  }
  if (s.phase !== 'Listening') meterStore.set(silence());
  setDictation(s);
}

export async function refreshMicDevices(): Promise<void> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const inputs = all.filter((d) => d.kind === 'audioinput');
    const def = inputs.find((d) => d.deviceId === 'default');
    const defaultName = (def?.label ?? '').replace(/^(default|по умолчанию)\s*[-—:]\s*/i, '');
    const list = inputs.filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d) => ({ id: d.deviceId, label: d.label }));
    applyDictation(await invoke('dictation:devices', list, defaultName));
  } catch {
    /* no mediaDevices: the list keeps only the default row */
  }
}

async function micFailed(e: unknown, channel: 'dictation:micFailed' | 'wake:micFailed'): Promise<void> {
  const err = e as DOMException;
  applyDictation(await invoke(channel, err?.name ?? 'Error', err?.message ?? String(e)));
}

async function beginTake(): Promise<MicCapture | null> {
  const r = await invoke('dictation:start');
  applyDictation(r.state);
  if (!r.ok) {
    // No model, client role or busy: the status says why; the button does not pretend to listen.
    holdStore.set(false);
    return null;
  }
  const cap = new MicCapture();
  try {
    await cap.start(r.micId, (c) => send('dictation:pcm', c));
  } catch (e) {
    await cap.stop().catch(() => undefined);
    await micFailed(e, 'dictation:micFailed');
    holdStore.set(false);
    return null;
  }
  activeCapture = cap;
  return cap;
}

export function holdDown(): void {
  if (holdStore.get() || dictationStore.get()?.phase === 'Recognizing') return;
  holdStore.set(true);
  startJob = beginTake();
}

export async function holdUp(): Promise<void> {
  if (!holdStore.get()) return;
  holdStore.set(false);
  const job = startJob;
  startJob = null;
  const cap = job ? await job : null;
  if (!cap || activeCapture !== cap) return;
  activeCapture = null;
  await cap.stop();
  applyDictation(await invoke('dictation:stop'));
  void refreshMicDevices();
}

export function cancelTake(): void {
  holdStore.set(false);
  void invoke('dictation:cancel').then(applyDictation);
}

// ── the global hold key (Windows helper) ──
// The key is seen by the main process; the take is already started there. The mic lives here, so the
// main side asks us to open it, to stop it (then recognize), or to drop it (Escape). Window focus does
// not matter: the window may be hidden in the tray.
let hotJob: Promise<MicCapture | null> | null = null;

async function hotOpen(micId: string): Promise<MicCapture | null> {
  const cap = new MicCapture();
  try {
    await cap.start(micId, (c) => send('dictation:pcm', c));
  } catch (e) {
    await cap.stop().catch(() => undefined);
    await micFailed(e, 'dictation:micFailed');
    return null;
  }
  activeCapture = cap;
  return cap;
}

async function hotClose(recognize: boolean): Promise<void> {
  const job = hotJob;
  hotJob = null;
  const cap = job ? await job : null;
  if (cap && activeCapture === cap) {
    activeCapture = null;
    await cap.stop();
  } else if (cap) await cap.stop().catch(() => undefined);
  if (recognize && cap) applyDictation(await invoke('dictation:stop'));
}

function onHot(ev: HotEventDto): void {
  if (ev.kind === 'start') {
    if (hotJob) return;
    hotJob = hotOpen(ev.micId);
  } else void hotClose(ev.kind === 'stop');
}

// ── «Чаво»: an always-on capture for the word, separate from the take's own capture ──
// Main asks for it only while the setting is on and recognition is local. Its chunks go to the word's
// detector; during a take started by the word the main side feeds them into that take.
let wakeCapture: MicCapture | null = null;
let wakeKey = '';
let wakeJob: Promise<void> = Promise.resolve();

function applyWake(want: WakeWantDto): void {
  const key = want.on ? `on|${want.micId}` : 'off';
  if (key === wakeKey) return;
  wakeKey = key;
  wakeJob = wakeJob.then(async () => {
    if (wakeCapture) {
      const cap = wakeCapture;
      wakeCapture = null;
      await cap.stop().catch(() => undefined);
    }
    if (!want.on || wakeKey !== key) return;
    const cap = new MicCapture();
    try {
      await cap.start(want.micId, (c) => send('wake:pcm', c));
    } catch (e) {
      await cap.stop().catch(() => undefined);
      wakeKey = '';
      await micFailed(e, 'wake:micFailed');
      return;
    }
    if (wakeKey !== key) {
      await cap.stop().catch(() => undefined);
      return;
    }
    wakeCapture = cap;
    document.documentElement.dataset.wake = 'listening';
  }).finally(() => {
    if (!wakeCapture) document.documentElement.dataset.wake = 'off';
  });
}

function onLevel(v: number): void {
  meterStore.update((m) => [...m.slice(1), Math.max(0, Math.min(1, Number(v) || 0))]);
}

/** Wires the pushes and the window-wide listeners once, at startup. */
export function initDictation(): void {
  on('dictation:state', applyDictation);
  on('dictation:level', onLevel);
  on('dictation:cue', playCue);
  on('dictation:hot', onHot);
  on('wake:listen', applyWake);
  void invoke('wake:want').then(applyWake);
  window.addEventListener('pointerup', () => void holdUp());
  window.addEventListener('pointercancel', () => void holdUp());
  // A lost window (Alt+Tab while holding) ends the take instead of leaving it stuck.
  window.addEventListener('blur', () => void holdUp());
  window.addEventListener('keydown', (e) => {
    const phase = dictationStore.get()?.phase;
    if (e.key === 'Escape' && (phase === 'Listening' || phase === 'Recognizing')) cancelTake();
  });
  navigator.mediaDevices?.addEventListener?.('devicechange', () => void refreshMicDevices());
}
