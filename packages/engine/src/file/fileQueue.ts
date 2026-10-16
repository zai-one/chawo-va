// The list on the File transcription page. Files and folders come from the buttons or
// from drag-and-drop onto the window; the runner takes queued items one by one, so
// files dropped during a run are picked up by the same run. Port of src/App/FileQueue.cs.

import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { collectFromFolder, hasSupportedExtension } from './fileTranscript';

export type FileItemState = 'Queued' | 'Running' | 'Done' | 'Failed' | 'Stopped';

export interface FileQueueItem {
  readonly id: number;
  readonly path: string;
  state: FileItemState;
  /** Short per-file note: error, "мозг пропущен", elapsed time. */
  note: string;
  /** The raw .txt once written. */
  outputPath?: string;
}

const pending = (s: FileItemState) => s === 'Queued' || s === 'Running';

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Paths compare case-insensitively on Windows/macOS, exactly on Linux. */
export function samePath(a: string, b: string, platform = process.platform): boolean {
  return platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase();
}

export class FileQueue {
  private items: FileQueueItem[] = [];
  private nextId = 1;
  private listeners = new Set<() => void>();

  /** The .txt of the file that finished last; «Открыть папку» selects it. */
  lastOutput: string | null = null;

  onChanged(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  snapshot(): FileQueueItem[] {
    return this.items.map((i) => ({ ...i }));
  }

  get queuedCount(): number {
    return this.items.filter((i) => i.state === 'Queued').length;
  }

  /**
   * Adds files; folders are expanded (top level, supported extensions only).
   * onlyAudio drops files with an unknown extension (used for drag-and-drop).
   * A path already waiting or running is not added twice.
   */
  add(paths: Iterable<string>, onlyAudio: boolean): { added: number; skipped: number } {
    let added = 0;
    let skipped = 0;
    for (const raw of paths) {
      const p = (raw ?? '').trim().replace(/^"+|"+$/g, '');
      if (p.length === 0) continue;
      let files: string[];
      if (isDir(p)) {
        files = collectFromFolder(p);
        if (files.length === 0) {
          skipped++;
          continue;
        }
      } else if (onlyAudio && !hasSupportedExtension(p)) {
        skipped++;
        continue;
      } else files = [p];

      for (const f of files) {
        const full = resolve(f);
        if (this.items.some((i) => pending(i.state) && samePath(i.path, full))) {
          skipped++;
          continue;
        }
        // A finished row for the same file is replaced, so the list does not grow with repeats.
        this.items = this.items.filter((i) => pending(i.state) || !samePath(i.path, full));
        this.items.push({ id: this.nextId++, path: full, state: 'Queued', note: '' });
        added++;
      }
    }
    if (added > 0 || skipped > 0) this.changed();
    return { added, skipped };
  }

  private byId(id: number): FileQueueItem | undefined {
    return this.items.find((i) => i.id === id);
  }

  /** Removes a row unless it is the one running now. */
  remove(id: number): boolean {
    const item = this.byId(id);
    if (!item || item.state === 'Running') return false;
    this.items = this.items.filter((i) => i !== item);
    this.changed();
    return true;
  }

  /** Next queued item, marked Running; null when nothing waits. */
  takeNext(): FileQueueItem | null {
    const next = this.items.find((i) => i.state === 'Queued');
    if (!next) return null;
    next.state = 'Running';
    next.note = '';
    this.changed();
    return { ...next };
  }

  /** The item takeNext would return, without taking it (for decoding ahead). */
  peekNext(): FileQueueItem | null {
    const next = this.items.find((i) => i.state === 'Queued');
    return next ? { ...next } : null;
  }

  finish(id: number, state: FileItemState, note: string, output?: string): void {
    const item = this.byId(id);
    if (!item) return;
    item.state = state;
    item.note = note;
    if (output !== undefined) {
      item.outputPath = output;
      this.lastOutput = output;
    }
    this.changed();
  }

  /** After Stop: the running row becomes Stopped; queued rows stay queued for the next run. */
  markRunningStopped(note: string): void {
    let any = false;
    for (const i of this.items) {
      if (i.state === 'Running') {
        i.state = 'Stopped';
        i.note = note;
        any = true;
      }
    }
    if (any) this.changed();
  }
}
