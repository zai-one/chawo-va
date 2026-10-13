// A take through the Brain and simple syntax (App.HandleReleaseAsync / RunBrainAsync) and the pill.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyLanguage } from '../src/core/strings';
import { SAMPLE_RATE } from '../src/core/takeBuffer';
import * as Settings from '../src/main/settings';
import * as LocalBrain from '../src/main/brain/localBrain';
import { DictationSession, defaultBrainUsable, type RecognizerLike, type SessionHooks } from '../src/main/dictation/dictationSession';
import { OverlayModel, type OverlaySink } from '../src/main/overlay/overlayModel';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'chawo-dictbrain-'));
  process.env.CHAWO_LOCALAPPDATA = join(dir, 'local');
  process.env.CHAWO_APPDATA = join(dir, 'roaming');
  applyLanguage('Russian');
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.CHAWO_LOCALAPPDATA;
  delete process.env.CHAWO_APPDATA;
});
afterEach(() => LocalBrain.resetRuntime());

class FakeRecognizer implements RecognizerLike {
  readonly kind = 'v3_e2e_rnnt' as const;
  readonly modelId = 'v3_e2e_rnnt';
  deviceActual = 'cpu';
  deviceNote: string | null = null;
  intraOpThreads = 4;
  calls = 0;
  reply = 'привет мир';
  async transcribeCancelable(_s: Float32Array, _r: number, stillWanted: (() => boolean) | null): Promise<string> {
    this.calls++;
    return stillWanted && !stillWanted() ? '' : this.reply;
  }
  cancelOwned(): void {}
  async dispose(): Promise<void> {}
}

function speech(seconds = 1, amp = 0.3): Float32Array {
  const n = Math.round(seconds * SAMPLE_RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const burst = i > n * 0.3 && i < n * 0.7 ? amp : 0;
    out[i] = burst * Math.sin(i * 0.2) + 0.001 * Math.sin(i * 1.3);
  }
  return out;
}

type Call = { url: string; auth: string | undefined; body: { model: string; messages: { role: string; content: string }[] } };

/** A fake OpenAI-compatible server: answers with `reply(call)` or a status. */
function server(reply: (c: Call) => string | { status: number; body: string }, gate?: (signal: AbortSignal) => Promise<void>) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const c: Call = { url: String(url), auth: headers.Authorization, body: JSON.parse(String(init?.body)) };
    calls.push(c);
    if (gate && init?.signal) await gate(init.signal);
    const r = reply(c);
    if (typeof r === 'string') return new Response(JSON.stringify({ choices: [{ message: { content: r } }] }), { status: 200 });
    return new Response(r.body, { status: r.status });
  };
  return { calls, fetch };
}

/** Records what the session tells the pill, and keeps a real OverlayModel behind it. */
class SpyOverlay implements OverlaySink {
  log: string[] = [];
  model = new OverlayModel(() => {}, { setTimeout: () => 0 });
  showListening() { this.log.push('listening'); this.model.showListening(); }
  showRecognizing() { this.log.push('recognizing'); this.model.showRecognizing(); }
  showPartial(t: string) { this.log.push(`partial:${t}`); this.model.showPartial(t); }
  showStatus(t: string) { this.log.push(`status:${t}`); this.model.showStatus(t); }
  showHint(t: string) { this.log.push(`hint:${t}`); this.model.showHint(t); }
  showCaption(t: string) { this.log.push(`caption:${t}`); this.model.showCaption(t); }
  hideNow() { this.log.push('hide'); this.model.hideNow(); }
}

function serverSettings(x: Settings.SettingsData) {
  x.Brain = 'Server';
  x.CleanupEndpointUrl = 'http://127.0.0.1:9/v1';
  x.CleanupModel = 'qwen';
  x.CleanupApiKey = '';
}

function make(over: Partial<SessionHooks> = {}, edit?: (s: Settings.SettingsData) => void) {
  const s = Settings.defaults();
  edit?.(s);
  const rec = new FakeRecognizer();
  const copied: string[] = [];
  const overlay = new SpyOverlay();
  const statuses: string[] = [];
  let sess!: DictationSession;
  sess = new DictationSession({
    settings: () => s,
    push: () => { const st = sess?.view().status; if (st && statuses[statuses.length - 1] !== st) statuses.push(st); },
    copy: (t) => void copied.push(t),
    micName: () => 'USB Mic',
    find: (k) => `/m/${k}`,
    open: async () => rec,
    platform: 'win32',
    overlay,
    partialMs: 0,
    ...over,
  });
  const take = async (reply: string) => {
    rec.reply = reply;
    expect(sess.startTake().ok).toBe(true);
    const x = speech(1);
    for (let i = 0; i < x.length; i += 640) sess.appendPcm(x.subarray(i, i + 640));
    return sess.stopTake();
  };
  return { s, sess, rec, copied, overlay, statuses, take };
}

describe('DictationSession + Brain + SimpleSyntax', () => {
  it('Brain off: «Чаво, …» is plain text, nothing goes to a server', async () => {
    const srv = server(() => 'X');
    const { take, copied } = make({ fetch: srv.fetch });
    // The built-in dictionary spells the brand; the command itself stays in the text.
    expect(await take('привет мир. Чаво, исправь')).toBe('привет мир. Chawo, исправь');
    expect(srv.calls).toHaveLength(0);
    expect(copied).toEqual(['привет мир. Chawo, исправь']);
  });

  it('Server without a model filled in is not usable: the take goes in as is', async () => {
    const srv = server(() => 'X');
    const { take } = make({ fetch: srv.fetch }, (x) => { serverSettings(x); x.CleanupModel = ''; x.BrainEveryTake = true; });
    expect(await take('привет мир')).toBe('привет мир');
    expect(srv.calls).toHaveLength(0);
  });

  it('Server + every take: the phrase is edited with the cleanup prompt, status on the page and the pill', async () => {
    const srv = server(() => 'Привет, мир!');
    const { take, copied, overlay, statuses, sess } = make({ fetch: srv.fetch }, (x) => { serverSettings(x); x.BrainEveryTake = true; });
    expect(await take('привет мир')).toBe('Привет, мир!');
    expect(copied).toEqual(['Привет, мир!']);
    expect(srv.calls).toHaveLength(1);
    expect(srv.calls[0].url).toBe('http://127.0.0.1:9/v1/chat/completions');
    expect(srv.calls[0].auth).toBeUndefined();
    expect(srv.calls[0].body.model).toBe('qwen');
    expect(srv.calls[0].body.messages[1]).toEqual({ role: 'user', content: 'привет мир' });
    expect(srv.calls[0].body.messages[0].role).toBe('system');
    expect(statuses).toContain('Причёсываю…');
    expect(overlay.log).toEqual(['listening', 'recognizing', 'status:Причёсываю…', 'hide']);
    expect(sess.view().status).toMatch(/^Готово\. Фраза в буфере обмена/);
    expect(sess.view().lastText).toBe('Привет, мир!');
  });

  it('a custom instruction replaces the cleanup prompt on every take', async () => {
    const srv = server(() => 'ok');
    const { take } = make({ fetch: srv.fetch }, (x) => { serverSettings(x); x.BrainEveryTake = true; x.BrainInstruction = 'Translate into English.'; });
    await take('привет мир');
    expect(srv.calls[0].body.messages[0].content).toBe('Translate into English.');
  });

  it('a «Чаво, …» command: body goes to the server with the command; no edit-every-take needed', async () => {
    const srv = server(() => 'Hello world.');
    const { take, statuses } = make({ fetch: srv.fetch }, (x) => { serverSettings(x); x.SimpleSyntax = true; });
    expect(await take('привет мир. Чаво, переведи на английский.')).toBe('Hello world.'); // command answer: no simple syntax
    expect(srv.calls[0].body.messages[1].content).toBe('привет мир.');
    expect(srv.calls[0].body.messages[0].content).toMatch(/Команда пользователя к тексту: переведи на английский\.$/);
    expect(statuses).toContain('Перевожу…');
  });

  it('dictionary runs before the Brain sees the phrase', async () => {
    const srv = server((c) => c.body.messages[1].content.toUpperCase());
    const { take } = make({ fetch: srv.fetch }, (x) => { serverSettings(x); x.BrainEveryTake = true; x.WordReplacementRules = 'чаво=Chawo'; });
    expect(await take('пишу в чаво')).toBe('ПИШУ В CHAWO');
    expect(srv.calls[0].body.messages[1].content).toBe('пишу в Chawo');
  });

  it('SimpleSyntax on plain dictation and on an every-take Brain edit', async () => {
    const a = make({}, (x) => { x.SimpleSyntax = true; });
    expect(await a.take('Привет мир.')).toBe('привет мир');
    expect(a.copied).toEqual(['привет мир']);

    const srv = server(() => 'Привет, мир.');
    const b = make({ fetch: srv.fetch }, (x) => { serverSettings(x); x.BrainEveryTake = true; x.SimpleSyntax = true; });
    expect(await b.take('привет мир')).toBe('привет, мир');

    const c = make({}, (x) => { x.SimpleSyntax = false; });
    expect(await c.take('Привет мир.')).toBe('Привет мир.');
  });

  it('server failure: the dictation goes in as recognized, without the command, and the reason is shown', async () => {
    const srv = server(() => ({ status: 401, body: JSON.stringify({ error: { message: 'bad key' } }) }));
    const { take, copied, overlay, sess } = make({ fetch: srv.fetch }, (x) => { serverSettings(x); x.SimpleSyntax = true; });
    expect(await take('Привет мир. Чаво, сократи')).toBe('Привет мир.'); // a failed command is still a command: as is
    expect(copied).toEqual(['Привет мир.']);
    expect(sess.view().status).toMatch(/^Мозг не справился: .+\. В буфере обмена текст без правки\.$/);
    expect(overlay.log[overlay.log.length - 1]).toMatch(/^hint:Мозг не справился/);
  });

  it('an empty answer is a failure, never an empty insert', async () => {
    const srv = server(() => '   ');
    const { take, sess } = make({ fetch: srv.fetch }, (x) => { serverSettings(x); x.BrainEveryTake = true; });
    expect(await take('привет мир')).toBe('привет мир');
    expect(sess.view().status).toBe('Мозг не справился: нейросеть вернула пустой ответ. В буфере обмена текст без правки.');
  });

  it('a network error says there is no connection to the server', async () => {
    const fetch: typeof globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
    const { take, sess } = make({ fetch }, (x) => { serverSettings(x); x.BrainEveryTake = true; });
    expect(await take('привет мир')).toBe('привет мир');
    expect(sess.view().status).toBe('Мозг не справился: нет связи с сервером, проверьте интернет. В буфере обмена текст без правки.');
  });

  it('Stop while the Brain works: the request is aborted, nothing is copied, no failure shown', async () => {
    let started!: () => void;
    const begun = new Promise<void>((r) => { started = r; });
    const srv = server(() => 'never', (signal) => new Promise<void>((_, reject) => {
      started();
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const { take, copied, overlay, sess } = make({ fetch: srv.fetch }, (x) => { serverSettings(x); x.BrainEveryTake = true; });
    const p = take('привет мир');
    await begun;
    expect(sess.phase).toBe('Recognizing');
    sess.cancelTake();
    expect(await p).toBeNull();
    expect(copied).toEqual([]);
    expect(sess.view().status).toBe('');
    expect(overlay.log[overlay.log.length - 1]).toBe('hide');
    expect(sess.phase).toBe('Idle');
  });

  it('Local with the model on disk but llama-server failing to start is a graceful Brain failure', async () => {
    LocalBrain.setRuntime(new LocalBrain.LlamaServerRuntime({ isReady: () => true, exeFor: () => '/nonexistent/llama-server' }));
    const { take, sess, s } = make({}, (x) => { x.Brain = 'Local'; x.BrainEveryTake = true; });
    expect(defaultBrainUsable(s)).toBe(true);
    expect(await take('привет мир')).toBe('привет мир');
    expect(sess.view().status).toBe('Мозг не справился: движок мозга не скачан. В буфере обмена текст без правки.');
  });

  it('Local with no model on disk is not usable (App.BrainUsable)', async () => {
    const { take, s } = make({}, (x) => { x.Brain = 'Local'; x.BrainEveryTake = true; });
    expect(defaultBrainUsable(s)).toBe(false);
    expect(await take('привет мир')).toBe('привет мир');
  });

  it('an injected transform is used as is (Local runtime later)', async () => {
    const seen: (string | null)[] = [];
    const { take } = make({
      brainUsable: () => true,
      transform: async (_s, body, command, status) => { seen.push(command); status('Сокращаю…'); return body + '!'; },
    }, (x) => { x.Brain = 'Local'; });
    expect(await take('коротко. Чаво, короче')).toBe('коротко.!');
    expect(seen).toEqual(['короче']);
  });
});

describe('DictationSession and the pill', () => {
  it('ShowOverlay off: the pill is never touched', async () => {
    const { take, overlay } = make({}, (x) => { x.ShowOverlay = false; });
    await take('привет');
    expect(overlay.log).toEqual([]);
  });

  it('silence and "could not make it out" are hints on the pill', async () => {
    const { sess, overlay, rec } = make();
    sess.startTake();
    sess.appendPcm(new Float32Array(SAMPLE_RATE));
    await sess.stopTake();
    expect(overlay.log).toEqual(['listening', 'recognizing', 'hint:Тишина на входе. Проверьте микрофон и его громкость: USB Mic']);
    rec.reply = '';
    overlay.log = [];
    sess.startTake();
    const x = speech(1);
    for (let i = 0; i < x.length; i += 640) sess.appendPcm(x.subarray(i, i + 640));
    await sess.stopTake();
    expect(overlay.log).toEqual(['listening', 'recognizing', 'hint:Не разобрал. Попробуйте ещё раз ближе к микрофону.']);
  });

  it('a short tap hides the pill; cancel while listening hides it', async () => {
    const { sess, overlay } = make();
    sess.startTake();
    sess.appendPcm(speech(0.2));
    await sess.stopTake();
    expect(overlay.log).toEqual(['listening', 'recognizing', 'hide']);
    overlay.log = [];
    sess.startTake();
    sess.cancelTake();
    expect(overlay.log).toEqual(['listening', 'hide']);
    expect(overlay.model.state.visible).toBe(false);
  });

  it('live draft: a pass over the audio so far goes to the pill only, not the clipboard', async () => {
    const { sess, overlay, rec, copied } = make();
    rec.reply = 'черновик';
    sess.startTake();
    await sess.ensureLoaded();
    const x = speech(1);
    for (let i = 0; i < x.length; i += 640) sess.appendPcm(x.subarray(i, i + 640));
    await sess.partialTick();
    expect(overlay.model.state.live).toBe('черновик');
    expect(copied).toEqual([]);
    rec.reply = 'финал';
    expect(await sess.stopTake()).toBe('финал');
    expect(rec.calls).toBe(2);
    expect(overlay.log).toEqual(['listening', 'partial:черновик', 'recognizing', 'hide']);
  });

  it('no draft for under 0.6 s of audio or without the pill', async () => {
    const { sess, overlay, rec, s } = make();
    sess.startTake();
    await sess.ensureLoaded();
    sess.appendPcm(speech(0.5));
    await sess.partialTick();
    expect(rec.calls).toBe(0);
    s.ShowOverlay = false;
    sess.appendPcm(speech(1));
    await sess.partialTick();
    expect(rec.calls).toBe(0);
    expect(overlay.log).toEqual(['listening']);
  });
});
