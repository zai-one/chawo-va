import { beforeAll, describe, expect, it } from 'vitest';
import { applyLanguage } from '@chawo/core/strings';
import { UrlImport, type UrlImportDeps } from '../src/file/urlImport';

beforeAll(() => applyLanguage('Russian'));

function make(over: Partial<UrlImportDeps> = {}) {
  const log: string[] = [];
  const queued: string[] = [];
  let runs = 0;
  const deps: UrlImportDeps = {
    findYtDlp: () => '/bin/yt-dlp',
    fetchAudio: async (_u, dir, progress) => {
      progress(10);
      progress(10.4);
      progress(55);
      progress(100);
      return dir + '/Ролик [id].m4a';
    },
    outDir: () => '/dl/Chawo',
    enqueue: (p) => queued.push(p),
    runQueue: () => runs++,
    changed: () => log.push(imp.status),
    ...over,
  };
  const imp = new UrlImport(deps);
  return { imp, log, queued, runs: () => runs };
}

describe('UrlImport', () => {
  it('downloads, queues the file and starts the run', async () => {
    const { imp, log, queued, runs } = make();
    const p = await imp.start(' https://www.youtube.com/watch?v=abc ');
    expect(p).toBe('/dl/Chawo/Ролик [id].m4a');
    expect(queued).toEqual(['/dl/Chawo/Ролик [id].m4a']);
    expect(runs()).toBe(1);
    expect(imp.busy).toBe(false);
    expect(log[0]).toBe('Скачиваю звук с www.youtube.com…');
    expect(log).toContain('Скачиваю звук с www.youtube.com… 55%');
    expect(log.filter((l) => l.endsWith('10%'))).toHaveLength(1);
    expect(imp.status).toBe('Скачано: Ролик [id].m4a. Расшифровываю локально.');
  });

  it('refuses non-links and a missing yt-dlp without fetching', async () => {
    let fetched = 0;
    const fetchAudio = async () => {
      fetched++;
      return '/x';
    };
    const a = make({ fetchAudio });
    expect(await a.imp.start('')).toBeNull();
    expect(a.imp.status).toBe('Вставьте ссылку на видео или запись.');
    expect(await a.imp.start('file:///etc/passwd')).toBeNull();
    expect(a.imp.status).toBe('Нужна ссылка http(s)://…');
    const b = make({ fetchAudio, findYtDlp: () => null });
    expect(await b.imp.start('https://x.test/a')).toBeNull();
    expect(b.imp.status).toContain('нужен yt-dlp');
    expect(fetched).toBe(0);
  });

  it('reports a failure and queues nothing', async () => {
    const a = make({ fetchAudio: async () => Promise.reject(new Error('[youtube] abc: Video unavailable')) });
    expect(await a.imp.start('https://youtu.be/abc')).toBeNull();
    expect(a.imp.status).toBe('Не скачалось: [youtube] abc: Video unavailable');
    expect(a.queued).toEqual([]);
    expect(a.runs()).toBe(0);
  });

  it('stop aborts the download; one link at a time', async () => {
    const a = make({
      fetchAudio: (_u, _d, _p, signal) =>
        new Promise((_res, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))),
    });
    const first = a.imp.start('https://x.test/a');
    expect(a.imp.busy).toBe(true);
    expect(await a.imp.start('https://x.test/b')).toBeNull();
    a.imp.stop();
    expect(await first).toBeNull();
    expect(a.imp.status).toBe('Скачивание по ссылке остановлено.');
    expect(a.imp.busy).toBe(false);
    expect(a.queued).toEqual([]);
  });
});
