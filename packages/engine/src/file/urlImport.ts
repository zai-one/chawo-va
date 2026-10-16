// «Расшифровать по ссылке»: link → yt-dlp → the saved audio joins the normal file queue and the
// run starts (or the running one picks it up). One link at a time; Stop cancels the download.
// Electron-free so it is unit-tested with fakes.

import { basename } from 'node:path';
import { parseMediaUrl } from '@chawo/core/mediaUrl';
import { t } from '@chawo/core/strings';

export interface UrlImportDeps {
  findYtDlp: () => string | null;
  fetchAudio: (url: string, outDir: string, progress: (percent: number) => void, signal: AbortSignal) => Promise<string>;
  outDir: () => string;
  /** Adds the saved file to the queue. */
  enqueue: (path: string) => void;
  /** Starts the queue unless it is already running (a running queue takes the new file itself). */
  runQueue: () => void;
  changed: () => void;
}

export class UrlImport {
  private ctrl: AbortController | null = null;
  status = '';

  constructor(private readonly d: UrlImportDeps) {}

  get busy(): boolean {
    return this.ctrl !== null;
  }

  stop(): void {
    this.ctrl?.abort();
  }

  private say(s: string): void {
    this.status = s;
    this.d.changed();
  }

  /** Resolves with the saved path, or null when refused, failed or stopped (the status says why). */
  async start(input: string): Promise<string | null> {
    if (this.ctrl) return null;
    const check = parseMediaUrl(input);
    if (!check.ok) {
      this.say(
        check.reason === 'empty'
          ? t('Вставьте ссылку на видео или запись.', 'Paste a link to a video or recording.')
          : t('Нужна ссылка http(s)://…', 'An http(s)://… link is needed.'),
      );
      return null;
    }
    if (!this.d.findYtDlp()) {
      this.say(t('Для ссылок нужен yt-dlp — скачайте его кнопкой ниже.', 'Links need yt-dlp — download it with the button below.'));
      return null;
    }
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    const host = new URL(check.url).hostname;
    this.say(t(`Скачиваю звук с ${host}…`, `Downloading audio from ${host}…`));
    let lastShown = -5;
    try {
      const path = await this.d.fetchAudio(
        check.url,
        this.d.outDir(),
        (p) => {
          if (p - lastShown < 1 && p < 100) return;
          lastShown = p;
          this.say(t(`Скачиваю звук с ${host}… ${Math.floor(p)}%`, `Downloading audio from ${host}… ${Math.floor(p)}%`));
        },
        ctrl.signal,
      );
      this.ctrl = null;
      this.d.enqueue(path);
      this.say(t(`Скачано: ${basename(path)}. Расшифровываю локально.`, `Downloaded: ${basename(path)}. Transcribing locally.`));
      this.d.runQueue();
      return path;
    } catch (e) {
      this.ctrl = null;
      if (ctrl.signal.aborted) this.say(t('Скачивание по ссылке остановлено.', 'Link download stopped.'));
      else this.say(t(`Не скачалось: ${(e as Error).message}`, `Download failed: ${(e as Error).message}`));
      return null;
    }
  }
}
