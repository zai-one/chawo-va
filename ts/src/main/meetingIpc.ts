// IPC for «Запись встречи». The page captures (getUserMedia / getDisplayMedia → meeting worklet)
// and streams interleaved stereo chunks here; MeetingController writes the WAV and hands it to the
// file queue. The computer sound is Chromium's loopback (Windows WASAPI, Linux Pulse/PipeWire
// monitor): the display-media request is answered with the first screen + `audio: 'loopback'` only
// while a meeting start is pending, and the page drops the video track at once (nothing of the
// screen is recorded or kept). Any other getDisplayMedia call is refused.

import { BrowserWindow, app, desktopCapturer, ipcMain, session } from 'electron';
import { join } from 'node:path';
import * as Settings from './settings';
import type { SettingsData } from './settings';
import { env } from './paths';
import { isRussian, t } from '../core/strings';
import * as Log from './log';
import { MeetingController } from './meeting/meetingController';
import { systemAudioMode } from './meeting/systemAudio';

/** The worklet posts 4000 stereo frames; anything far bigger is not ours. */
const MAX_CHUNK = 64000;

export function meetingsDir(): string {
  return env('MEETINGS_DIR') ?? join(app.getPath('documents'), 'Chawo VA', t('Встречи', 'Meetings'));
}

export function registerMeetingIpc(
  getWindow: () => BrowserWindow | null,
  settings: { get: () => SettingsData },
  files: { enqueue: (path: string) => void },
): { dispose: () => void; controller: MeetingController } {
  let loopbackArmed = false;
  const push = () => getWindow()?.webContents.send('meeting:state', controller.state());
  const controller: MeetingController = new MeetingController({
    dir: meetingsDir,
    settings: () => settings.get(),
    save: () => Settings.save(settings.get()),
    mode: () => systemAudioMode(),
    armLoopback: (on) => (loopbackArmed = on),
    enqueue: files.enqueue,
    changed: push,
    log: Log.write,
    isRussian,
  });

  if (systemAudioMode() === 'loopback') {
    session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
      if (!loopbackArmed) {
        cb({});
        return;
      }
      loopbackArmed = false;
      desktopCapturer
        .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => (sources[0] ? cb({ video: sources[0], audio: 'loopback' }) : cb({})))
        .catch(() => cb({}));
    });
  }

  ipcMain.handle('meeting:state', () => controller.state());
  ipcMain.handle('meeting:start', () => controller.start());
  ipcMain.handle('meeting:systemOpened', (_e, ok: unknown, reason: unknown) => controller.systemOpened(ok === true, typeof reason === 'string' ? reason : ''));
  ipcMain.on('meeting:pcm', (_e, chunk: unknown) => {
    if (chunk instanceof Float32Array && chunk.length <= MAX_CHUNK) controller.pcm(chunk);
  });
  ipcMain.handle('meeting:stop', () => controller.stop());
  ipcMain.handle('meeting:cancel', () => controller.cancel());
  ipcMain.handle('meeting:failed', (_e, reason: unknown) => controller.failed(typeof reason === 'string' ? reason : 'Error'));
  ipcMain.handle('meeting:system', (_e, on: unknown) => controller.setSystem(on === true));
  return { dispose: () => controller.dispose(), controller };
}
