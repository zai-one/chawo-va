import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SpeechModelKind } from '../src/core/speechModels';
import { applyLanguage } from '../src/core/strings';
import { ModelDownloadException } from '../src/main/models';
import * as Settings from '../src/main/settings';
import { SpeechController, failureText, gpuLabel, progressText, type SpeechHooks } from '../src/main/speech/speechPage';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'chawo-speech-'));
  process.env.CHAWO_LOCALAPPDATA = join(dir, 'local');
  process.env.CHAWO_APPDATA = join(dir, 'roaming');
  applyLanguage('Russian');
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.CHAWO_LOCALAPPDATA;
  delete process.env.CHAWO_APPDATA;
});

function make(over: Partial<SpeechHooks> = {}) {
  const s = Settings.defaults();
  const onDisk = new Set<SpeechModelKind>();
  let saves = 0;
  let changes = 0;
  const ctl = new SpeechController({
    settings: () => s,
    save: () => void saves++,
    changed: () => void changes++,
    find: (k) => (onDisk.has(k) ? `/m/${k}` : null),
    deletable: (k) => onDisk.has(k),
    targets: (k) => [`/m/${k}`],
    remove: (k) => void onDisk.delete(k),
    cores: 8,
    platform: 'linux',
    ...over,
  });
  return { s, ctl, onDisk, saves: () => saves, changes: () => changes };
}

describe('speech page texts', () => {
  it('progress lines match the WPF download window', () => {
    expect(progressText({ stage: 'download', received: 50 << 20, total: 200 << 20 })).toEqual({ percent: 25, text: 'Скачано 50 из 200 МБ' });
    expect(progressText({ stage: 'download', received: 3 << 20, total: -1 }).percent).toBeNull();
    expect(progressText({ stage: 'unpack', received: 0, total: 0 }).text).toBe('Распаковываю…');
    expect(progressText({ stage: 'verify', received: 0, total: 0 }).text).toBe('Проверяю файл…');
  });
  it('failure lines', () => {
    expect(failureText('noSpace', '', '1 ГБ')).toContain('около 1 ГБ');
    expect(failureText('corrupt', '', '')).toContain('повреждён');
    expect(failureText('rejected', 'HTTP 403', '')).toBe('HTTP 403');
    expect(failureText('network', '', '')).toContain('интернет');
  });
  it('gpu label follows the onnxruntime provider per platform', () => {
    expect(gpuLabel('win32')).toContain('DirectML');
    expect(gpuLabel('linux')).toContain('CUDA');
  });
});

describe('SpeechController', () => {
  it('lists both models with the selected one and clamps threads', () => {
    const { s, ctl, onDisk } = make();
    s.CpuThreads = 64;
    onDisk.add('v3_e2e_rnnt');
    const st = ctl.state();
    expect(st.models.map((m) => m.kind)).toEqual(['v3_e2e_rnnt', 'multilingual_large_ctc']);
    expect(st.models[0]).toMatchObject({ selected: true, onDisk: true, canDelete: true });
    expect(st.models[1]).toMatchObject({ selected: false, onDisk: false });
    expect(st.cpuThreads).toBe(0);
    expect(st.status).toContain('Уже на диске: /m/v3_e2e_rnnt');
    expect(st.ru).toBe(true);
  });

  it('select, device and threads save only real changes', () => {
    const { s, ctl, saves } = make();
    ctl.select('v3_e2e_rnnt');
    expect(saves()).toBe(0);
    ctl.select('multilingual_large_ctc');
    expect(s.SpeechModel).toBe('MultilingualLargeCtc');
    ctl.setDevice('Cpu');
    ctl.setDevice('Bogus' as never);
    ctl.setThreads(4);
    ctl.setThreads(99);
    ctl.setThreads(1.5);
    expect(s.SpeechDevice).toBe('Cpu');
    expect(s.CpuThreads).toBe(4);
    expect(saves()).toBe(3);
  });

  it('download selects the model, streams progress and refreshes on success', async () => {
    const seen: (number | null)[] = [];
    const h = make({
      download: async (_k, _d, progress) => {
        progress({ stage: 'download', received: 1 << 20, total: 4 << 20 });
        seen.push(h.ctl.state().download!.percent);
        progress({ stage: 'unpack', received: 0, total: 0 });
        seen.push(h.ctl.state().download!.percent);
        h.onDisk.add('multilingual_large_ctc');
      },
    });
    await h.ctl.download('multilingual_large_ctc');
    expect(h.s.SpeechModel).toBe('MultilingualLargeCtc');
    expect(seen).toEqual([25, null]);
    expect(h.ctl.state().download).toBeNull();
    expect(h.ctl.state().models[1].onDisk).toBe(true);
    expect(h.changes()).toBeGreaterThanOrEqual(2);
  });

  it('download failure keeps a retry card; cancel clears it silently', async () => {
    const h = make({ download: async () => { throw new ModelDownloadException('noSpace', 'only 3 MB free'); } });
    await h.ctl.download('v3_e2e_rnnt');
    expect(h.ctl.state().download).toMatchObject({ failed: true, running: false });
    expect(h.ctl.state().download?.text).toContain('1 ГБ');
    h.ctl.dismissDownload();
    expect(h.ctl.state().download).toBeNull();

    const c = make({
      download: (_k, _d, _p, signal) =>
        new Promise((_r, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
    });
    const run = c.ctl.download('v3_e2e_rnnt');
    expect(c.ctl.downloading).toBe(true);
    void c.ctl.download('multilingual_large_ctc'); // ignored while one runs
    c.ctl.cancelDownload();
    await run;
    expect(c.ctl.state().download).toBeNull();
    expect(c.s.SpeechModel).toBe('V3E2eRnnt');
  });

  it('never downloads on a client or when the model is already on disk', async () => {
    let calls = 0;
    const h = make({ download: async () => void calls++ });
    h.s.NetworkRole = 'Client';
    await h.ctl.download('v3_e2e_rnnt');
    expect(h.ctl.state().download?.failed).toBe(true);
    expect(h.ctl.state().intro).toContain('клиент');
    expect(h.ctl.state().status).toBe('Укажите адрес хоста в разделе «Сеть». Модель здесь не скачивается.');
    h.s.RemoteHost = '192.168.1.20';
    expect(h.ctl.state().status).toBe('Клиент. Звук уходит на http://192.168.1.20:17831/v1/transcribe. Местная речевая модель не запускается и не скачивается.');
    h.s.NetworkRole = 'Host';
    h.onDisk.add('v3_e2e_rnnt');
    await h.ctl.download('v3_e2e_rnnt');
    expect(calls).toBe(0);
    expect(h.ctl.state().download?.text).toContain('уже на диске');
  });

  it('delete refuses while files are transcribing and removes otherwise', () => {
    let busy = true;
    const h = make({ busy: () => busy });
    h.onDisk.add('v3_e2e_rnnt');
    expect(h.ctl.confirmText('v3_e2e_rnnt')).toContain('/m/v3_e2e_rnnt');
    expect(h.ctl.delete('v3_e2e_rnnt')).toContain('занята');
    expect(h.onDisk.has('v3_e2e_rnnt')).toBe(true);
    busy = false;
    expect(h.ctl.delete('v3_e2e_rnnt')).toBeNull();
    expect(h.onDisk.has('v3_e2e_rnnt')).toBe(false);
  });
});

describe('speech page: «Выгружать модели при простое»', () => {
  it('offers never/5/15/30/60 with 15 selected; saves only real choices and re-arms the timers', () => {
    let rearm = 0;
    const { s, ctl, saves } = make({ idleChanged: () => void rearm++ });
    const st = ctl.state();
    expect(st.idleMinutes).toBe(15);
    expect(st.idleChoices.map((c) => c.value)).toEqual([0, 5, 15, 30, 60]);
    expect(st.idleChoices.map((c) => c.label)).toEqual(['Не выгружать', 'Через 5 мин', 'Через 15 мин', 'Через 30 мин', 'Через 1 час']);
    expect(st.idleHint).toMatch(/локальный Мозг/);
    ctl.setIdleMinutes(15);
    ctl.setIdleMinutes(7);
    ctl.setIdleMinutes(Number.NaN);
    expect(saves()).toBe(0);
    expect(rearm).toBe(0);
    ctl.setIdleMinutes(0);
    expect(s.IdleUnloadMinutes).toBe(0);
    expect(saves()).toBe(1);
    expect(rearm).toBe(1);
    expect(ctl.state().idleMinutes).toBe(0);
  });
});

describe('speech page: «Обрезать тишину (VAD)»', () => {
  function fakeVad(opts: { fail?: string } = {}) {
    const v = {
      onDisk: false,
      isDownloading: false,
      error: '',
      downloads: 0,
      download: async () => {
        v.downloads++;
        v.isDownloading = true;
        await Promise.resolve();
        v.isDownloading = false;
        if (opts.fail) {
          v.error = opts.fail;
          throw new Error(opts.fail);
        }
        v.onDisk = true;
        return '/m/silero_vad.onnx';
      },
    };
    return v;
  }

  it('no VAD runtime → no section', () => {
    expect(make().ctl.state().vad).toBeNull();
  });

  it('on by default; missing model offers the 2 MB download; on disk says so', async () => {
    const vad = fakeVad();
    const h = make({ vad });
    expect(h.ctl.state().vad).toMatchObject({ enabled: true, onDisk: false, canDownload: true });
    expect(h.ctl.state().vad!.note).toContain('2 МБ');
    await h.ctl.downloadVad();
    expect(vad.downloads).toBe(1);
    expect(h.ctl.state().vad).toMatchObject({ onDisk: true, canDownload: false });
    expect(h.ctl.state().vad!.note).toMatch(/^Silero VAD на диске/);
    await h.ctl.downloadVad();
    expect(vad.downloads).toBe(1);
  });

  it('the checkbox saves VadEnabled; off hides the download', () => {
    const h = make({ vad: fakeVad() });
    h.ctl.setVad(false);
    expect(h.s.VadEnabled).toBe(false);
    expect(h.saves()).toBe(1);
    expect(h.ctl.state().vad).toMatchObject({ enabled: false, canDownload: false });
    expect(h.ctl.state().vad!.note).toMatch(/^Выключено/);
    h.ctl.setVad(false);
    expect(h.saves()).toBe(1);
  });

  it('a failed VAD download is shown, nothing breaks', async () => {
    const h = make({ vad: fakeVad({ fail: 'HTTP 404' }) });
    await h.ctl.downloadVad();
    expect(h.ctl.state().vad!.note).toContain('HTTP 404');
    expect(h.ctl.state().vad!.canDownload).toBe(true);
  });

  it('a speech-model download the user asked for brings the VAD model along (only when VAD is on)', async () => {
    const vad = fakeVad();
    const h = make({ vad, download: async () => void h.onDisk.add('v3_e2e_rnnt') });
    await h.ctl.download('v3_e2e_rnnt');
    await new Promise((r) => setTimeout(r, 0));
    expect(vad.downloads).toBe(1);

    const off = fakeVad();
    const o = make({ vad: off, download: async () => void o.onDisk.add('v3_e2e_rnnt') });
    o.s.VadEnabled = false;
    await o.ctl.download('v3_e2e_rnnt');
    await new Promise((r) => setTimeout(r, 0));
    expect(off.downloads).toBe(0);
  });
});
