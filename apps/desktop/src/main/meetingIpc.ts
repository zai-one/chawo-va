// IPC for «Запись встречи». The page captures (getUserMedia / getDisplayMedia → meeting worklet)
// and streams interleaved stereo chunks here; MeetingController writes the WAV and hands it to the
// file queue. The computer sound is Chromium's loopback (Windows WASAPI, Linux Pulse/PipeWire
// monitor): the display-media request is answered with the first screen + `audio: 'loopback'` only
// while a meeting start is pending, and the page drops the video track at once (nothing of the
// screen is recorded or kept). Any other getDisplayMedia call is refused.
//
// «Автоопределение встречи» (opt-in): a gentle poller watches known meeting apps (Windows/Linux) and/or
// a local .ics path; when something looks active and we are not recording, the page gets a compact
// «Похоже, идёт встреча — записать?» offer. Recording never starts without the user clicking.

import { BrowserWindow, app, desktopCapturer, dialog, ipcMain, session } from 'electron';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import * as Settings from '@chawo/engine/settings';
import type { SettingsData } from '@chawo/engine/settings';
import { env } from '@chawo/engine/paths';
import { isRussian, t } from '@chawo/core/strings';
import * as Log from '@chawo/engine/log';
import { MeetingController } from '@chawo/engine/meeting/meetingController';
import { systemAudioMode } from '@chawo/engine/meeting/systemAudio';
import { detectMeeting, MeetingDetectPoller, SNOOZE_MS } from '@chawo/engine/meeting/meetingDetect';
import type { ExecLike } from '@chawo/engine/meeting/meetingApps';

/** The worklet posts 4000 stereo frames; anything far bigger is not ours. */
const MAX_CHUNK = 64000;

const realExec: ExecLike = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- an ExecFileException is an Error (typed via Omit<>)
      if (err) reject(err);
      else resolve(stdout);
    });
  });

export function meetingsDir(): string {
  return env('MEETINGS_DIR') ?? join(app.getPath('documents'), 'Chawo VA', t('Встречи', 'Meetings'));
}

export function registerMeetingIpc(
  getWindow: () => BrowserWindow | null,
  settings: { get: () => SettingsData },
  files: { enqueue: (path: string) => void },
  opts?: { showWindow?: () => void; exec?: ExecLike },
): { dispose: () => void; controller: MeetingController; poller: MeetingDetectPoller } {
  let loopbackArmed = false;
  const push = () => getWindow()?.webContents.send('meeting:state', controller.state());
  const show = opts?.showWindow;
  const exec = opts?.exec ?? realExec;

  let poller!: MeetingDetectPoller;

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
    autoDetectChanged: () => syncPoller(),
  });

  // eslint-disable-next-line prefer-const -- callbacks above refer to it before it exists
  poller = new MeetingDetectPoller({
    settings: () => {
      const s = settings.get();
      return {
        MeetingAutoDetect: s.MeetingAutoDetect,
        MeetingAutoDetectApps: s.MeetingAutoDetectApps,
        MeetingAutoDetectCalendar: s.MeetingAutoDetectCalendar,
      };
    },
    recording: () => controller.recorder.recording,
    detect: () =>
      detectMeeting(
        {
          MeetingAutoDetect: settings.get().MeetingAutoDetect,
          MeetingAutoDetectApps: settings.get().MeetingAutoDetectApps,
          MeetingAutoDetectCalendar: settings.get().MeetingAutoDetectCalendar,
        },
        { exec, platform: process.platform },
      ),
    onOffer: (result, fingerprint) => {
      controller.setOffer({
        reasons: result.reasons,
        fingerprint,
        appsSupported: result.appsSupported,
      });
      Log.write(`meeting: auto-detect offer ${result.reasons.join(', ') || fingerprint}`);
      show?.();
    },
    onClear: () => {
      if (controller.state().offer) controller.setOffer(null);
    },
  });

  function syncPoller(): void {
    if (settings.get().MeetingAutoDetect) poller.start();
    else {
      poller.stop();
      controller.setOffer(null);
    }
  }

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
  ipcMain.handle('meeting:start', () => {
    const fp = controller.state().offer?.fingerprint ?? '';
    if (fp) poller.acknowledge(fp);
    controller.setOffer(null);
    return controller.start();
  });
  ipcMain.handle('meeting:systemOpened', (_e, ok: unknown, reason: unknown) =>
    controller.systemOpened(ok === true, typeof reason === 'string' ? reason : ''),
  );
  ipcMain.on('meeting:pcm', (_e, chunk: unknown) => {
    if (chunk instanceof Float32Array && chunk.length <= MAX_CHUNK) controller.pcm(chunk);
  });
  ipcMain.handle('meeting:stop', () => controller.stop());
  ipcMain.handle('meeting:cancel', () => controller.cancel());
  ipcMain.handle('meeting:failed', (_e, reason: unknown) => controller.failed(typeof reason === 'string' ? reason : 'Error'));
  ipcMain.handle('meeting:system', (_e, on: unknown) => controller.setSystem(on === true));
  ipcMain.handle('meeting:autoDetect', (_e, on: unknown) => controller.setAutoDetect(on === true));
  ipcMain.handle('meeting:autoDetectApps', (_e, on: unknown) => controller.setAutoDetectApps(on === true));
  ipcMain.handle('meeting:autoDetectCalendar', (_e, path: unknown) =>
    controller.setAutoDetectCalendar(typeof path === 'string' ? path : ''),
  );
  ipcMain.handle('meeting:pickCalendar', async () => {
    const win = getWindow();
    const opts = {
      title: t('Календарь (.ics)', 'Calendar (.ics)'),
      properties: ['openFile', 'openDirectory'] as Array<'openFile' | 'openDirectory'>,
      filters: [
        { name: 'iCalendar', extensions: ['ics'] },
        { name: t('Все файлы', 'All files'), extensions: ['*'] },
      ],
    };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || !r.filePaths[0]) return controller.state();
    return controller.setAutoDetectCalendar(r.filePaths[0]);
  });
  ipcMain.handle('meeting:offerSnooze', () => {
    const fp = controller.state().offer?.fingerprint ?? '';
    poller.snooze(SNOOZE_MS);
    if (fp) poller.acknowledge(fp);
    controller.setOffer(null);
    return controller.state();
  });
  ipcMain.handle('meeting:offerNever', () => {
    poller.clearOffer();
    return controller.setAutoDetect(false);
  });
  /** One-shot detect for tests / smoke (does not require the master switch). */
  ipcMain.handle('meeting:detectNow', async () => {
    const s = settings.get();
    return detectMeeting(
      {
        MeetingAutoDetect: true,
        MeetingAutoDetectApps: s.MeetingAutoDetectApps,
        MeetingAutoDetectCalendar: s.MeetingAutoDetectCalendar,
      },
      { exec, platform: process.platform },
    );
  });

  if (settings.get().MeetingAutoDetect) poller.start();

  return {
    dispose: () => {
      poller.stop();
      controller.dispose();
    },
    controller,
    poller,
  };
}
