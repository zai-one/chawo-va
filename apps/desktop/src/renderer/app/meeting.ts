// «Запись встречи» outside React: the capture lives here so it survives page switches.
import type { MeetingStateDto } from '@chawo/ipc/contract';
import { MeetingCapture } from '../audio/meetingCapture';
import { invoke } from '../bridge';
import { currentPage, showPage } from './pages';
import { applyMeeting as setMeeting, meetingStore } from './state';
import { createStore } from './store';

/** Peaks of the last chunk [mic, computer] and the clock, refreshed twice a second while recording. */
export const meetingLive = createStore<{ levels: [number, number]; now: number }>({ levels: [0, 0], now: Date.now() });

let capture: MeetingCapture | null = null;
let busy = false;
let timer: number | null = null;

export function applyMeeting(s: MeetingStateDto): void {
  setMeeting(s);
  if (s.recording && timer === null) {
    timer = window.setInterval(() => meetingLive.set({ levels: capture?.levels ?? [0, 0], now: Date.now() }), 500);
  }
  if (!s.recording && timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
  // Auto-detect offer: jump to the file page so the compact prompt is visible.
  if (s.offer && !s.recording && currentPage.get() !== 'file') showPage('file');
}

export async function meetingStart(): Promise<void> {
  if (busy || meetingStore.get()?.recording) return;
  busy = true;
  try {
    const r = await invoke('meeting:start');
    if (!r.ok) {
      applyMeeting(r.state);
      return;
    }
    const cap = new MeetingCapture();
    try {
      await cap.start(r.micId, r.system);
    } catch (e) {
      await cap.stop().catch(() => undefined);
      applyMeeting(await invoke('meeting:failed', (e as DOMException)?.name ?? String(e)));
      return;
    }
    capture = cap;
    applyMeeting(await invoke('meeting:state'));
  } finally {
    busy = false;
  }
}

export async function meetingFinish(cancel: boolean): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const cap = capture;
    capture = null;
    await cap?.stop();
    applyMeeting(await (cancel ? invoke('meeting:cancel') : invoke('meeting:stop')));
  } finally {
    busy = false;
  }
}
