// «Свой скрипт»: the user's post-processing command. The finished text goes to its stdin (UTF-8),
// whatever it prints to stdout replaces the text. Idea from nerd-dictation / voxtype. Runs only on
// this computer, only when the user typed a command into «Словарь» (or passed --post-script).
//
// Soft by design: a crash, a non-zero exit, a timeout or an empty answer leaves the original text,
// so a broken script never eats a phrase or a transcript. The text itself is never logged.

import { spawn, spawnSync } from 'node:child_process';

export type PostScriptSource = 'dictation' | 'command' | 'selection' | 'file';

/** Dictation waits a little (the user is waiting for the phrase); a file transcript may take longer. */
export const DICTATION_TIMEOUT_MS = 5_000;
export const FILE_TIMEOUT_MS = 60_000;
/** Answer cap: a runaway script must not fill memory. */
export const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface PostScriptRun {
  /** Command line as the user typed it; run through the system shell (cmd.exe / sh). */
  command: string;
  text: string;
  source: PostScriptSource;
  /** Source audio for file transcripts (CHAWO_FILE). */
  file?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Tests: another environment base (default process.env). */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export type PostScriptResult =
  | { ok: true; text: string; ms: number }
  | { ok: false; reason: PostScriptFailure; detail: string; ms: number };

export type PostScriptFailure = 'start' | 'exit' | 'timeout' | 'empty' | 'tooLong' | 'aborted';

/** The command from settings, or null when the hook is off (blank). */
export function scriptCommand(raw: string | null | undefined): string | null {
  const c = (raw ?? '').trim();
  return c.length > 0 ? c : null;
}

/** Trailing newlines from print()/echo are not part of the text; inner ones stay. */
export function cleanOutput(out: string): string {
  return out.replace(/^\uFEFF/, '').replace(/[\r\n]+$/, '');
}

/** Environment for the script: the app's own plus CHAWO_* and UTF-8 for Python on Windows. */
export function scriptEnv(base: NodeJS.ProcessEnv, source: PostScriptSource, file?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, CHAWO_SOURCE: source, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
  if (file) env.CHAWO_FILE = file;
  else delete env.CHAWO_FILE;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function killTree(pid: number | undefined, platform: NodeJS.Platform, kill: () => void): void {
  if (pid === undefined) return;
  if (platform === 'win32') {
    // cmd.exe /c python … : killing cmd alone leaves python running.
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      return;
    } catch {
      /* fall through */
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
      return;
    } catch {
      /* fall through */
    }
  }
  kill();
}

/** Runs the command once. Never throws: the caller keeps the original text on { ok: false }. */
export function runPostScript(r: PostScriptRun): Promise<PostScriptResult> {
  const started = Date.now();
  const platform = r.platform ?? process.platform;
  const timeoutMs = r.timeoutMs ?? DICTATION_TIMEOUT_MS;
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => undefined;
    const finish = (res: PostScriptResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      r.signal?.removeEventListener('abort', onAbort);
      resolve(res);
    };
    const fail = (reason: PostScriptFailure, detail: string) => finish({ ok: false, reason, detail, ms: Date.now() - started });

    if (r.signal?.aborted) {
      fail('aborted', '');
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(r.command, {
        shell: true,
        windowsHide: true,
        detached: platform !== 'win32', // own process group, so a timeout kills the whole pipeline
        env: scriptEnv(r.env ?? process.env, r.source, r.file),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      fail('start', e instanceof Error ? e.message : String(e));
      return;
    }
    const stop = () => killTree(child.pid, platform, () => child.kill('SIGKILL'));
    timer = setTimeout(() => {
      stop();
      fail('timeout', String(timeoutMs));
    }, timeoutMs);
    onAbort = () => {
      stop();
      fail('aborted', '');
    };
    r.signal?.addEventListener('abort', onAbort);

    const out: Buffer[] = [];
    let outBytes = 0;
    let err = '';
    child.stdout?.on('data', (b: Buffer) => {
      outBytes += b.length;
      if (outBytes > MAX_OUTPUT_BYTES) {
        stop();
        fail('tooLong', String(MAX_OUTPUT_BYTES));
        return;
      }
      out.push(b);
    });
    child.stderr?.on('data', (b: Buffer) => {
      if (err.length < 2000) err += b.toString('utf8');
    });
    child.on('error', (e) => fail('start', e.message));
    child.on('close', (code, sig) => {
      if (code !== 0) {
        const lastErr = err.trim().split(/\r?\n/).pop() ?? '';
        fail('exit', `${code ?? sig}${lastErr ? ': ' + lastErr.slice(0, 200) : ''}`);
        return;
      }
      const text = cleanOutput(Buffer.concat(out).toString('utf8'));
      if (text.trim().length === 0) {
        fail('empty', '');
        return;
      }
      finish({ ok: true, text, ms: Date.now() - started });
    });
    // A script that never reads stdin closes the pipe early: that is fine, not a failure.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(r.text, 'utf8');
  });
}

/** One line for the status / queue row, without the text. */
export function failureText(res: Extract<PostScriptResult, { ok: false }>, t: (ru: string, en: string) => string): string {
  switch (res.reason) {
    case 'start':
      return t(`не запустился (${res.detail})`, `did not start (${res.detail})`);
    case 'exit':
      return t(`код выхода ${res.detail}`, `exit code ${res.detail}`);
    case 'timeout':
      return t(`не ответил за ${Math.round(Number(res.detail) / 1000)} с`, `no answer in ${Math.round(Number(res.detail) / 1000)} s`);
    case 'empty':
      return t('пустой ответ', 'empty answer');
    case 'tooLong':
      return t('слишком длинный ответ', 'answer too long');
    case 'aborted':
      return t('прерван', 'cancelled');
  }
}

/** Log line: what ran and how it ended, never the text. */
export function logLine(res: PostScriptResult, source: PostScriptSource, inChars: number): string {
  return res.ok
    ? `post script (${source}): ok ${inChars} -> ${res.text.length} chars, ${res.ms} ms`
    : `post script (${source}): ${res.reason} ${res.detail} after ${res.ms} ms; kept the text`;
}
