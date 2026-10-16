#!/usr/bin/env node
// Starts a packaged app (fuses on: no --inspect, so Playwright's _electron cannot drive it) in a temp
// profile with Chromium's remote debugging, attaches Playwright over CDP and checks that the main
// window really runs: served from chawo-app://bundle inside app.asar, a secure context (microphone,
// AudioWorklet), every page in the nav, dark, no errors in the console. Then quits it.
//   node scripts/check-packaged.mjs release/win-unpacked/ChawoVoiceAssistant.exe
//   xvfb-run -a node scripts/check-packaged.mjs release/linux-unpacked/ChawoVoiceAssistant   (Linux)
/* global document, getComputedStyle, isSecureContext -- the page.evaluate() callback runs in the window */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const exe = process.argv[2];
if (!exe) {
  console.error('usage: check-packaged.mjs <packaged exe>');
  process.exit(2);
}
const port = 9500 + Math.floor(Math.random() * 400);
const dir = mkdtempSync(join(tmpdir(), 'chawo-pkg-'));
const home = join(dir, 'home');
mkdirSync(home, { recursive: true });
// The app's own data goes to the temp profile through CHAWO_*; Chromium's profile through --user-data-dir
// (the OS profile variables stay as they are: Windows resolves its folders without them).
const env = { ...process.env, CHAWO_APPDATA: join(dir, 'roaming'), CHAWO_LOCALAPPDATA: join(dir, 'local'), CHAWO_SECRETS: 'file' };
if (process.platform !== 'win32') Object.assign(env, { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share') });
delete env.ELECTRON_RUN_AS_NODE;
const args = [`--user-data-dir=${join(dir, 'chromium')}`, `--remote-debugging-port=${port}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])];
const app = spawn(exe, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
app.stdout.on('data', (c) => (log += c));
app.stderr.on('data', (c) => (log += c));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

try {
  let browser = null;
  for (let i = 0; i < 60 && !browser && app.exitCode === null; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch {
      await sleep(500);
    }
  }
  if (!browser) {
    const code = app.exitCode === null ? 'still running' : `exit 0x${(app.exitCode >>> 0).toString(16)}`;
    const appLog = join(dir, 'local', 'ChawoVoiceAssistant', 'chawo-va.log');
    const tail = existsSync(appLog) ? readFileSync(appLog, 'utf8').slice(-1500) : '(no app log)';
    throw new Error(`no DevTools endpoint (${code}); output: ${log.slice(-800)}; app log: ${tail}`);
  }
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('chawo-app://bundle/index.html'));
    if (!page) await sleep(500);
  }
  if (!page) throw new Error('the main window did not open chawo-app://bundle/index.html');
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForSelector('.nav button', { timeout: 20_000 });
  const info = await page.evaluate(() => ({
    secure: isSecureContext,
    worklet: typeof AudioWorkletNode,
    node: typeof (globalThis).require,
    pages: Array.from(document.querySelectorAll('.nav button'), (b) => b.getAttribute('data-page')),
    bg: getComputedStyle(document.body).backgroundColor,
  }));
  check('main window from chawo-app://bundle', true, page.url());
  check('secure context (microphone, AudioWorklet)', info.secure && info.worklet === 'function');
  check('no Node in the page', info.node === 'undefined');
  const rgb = (info.bg.match(/\d+/g) ?? []).slice(0, 3).map(Number);
  check('dark window', rgb.length === 3 && (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 < 0.25, info.bg);
  for (const p of info.pages) {
    await page.click(`.nav button[data-page="${p}"]`);
    await page.waitForSelector('#page h1');
  }
  check('every page opens', info.pages.length >= 8, info.pages.join(', '));
  await sleep(500);
  check('no errors in the console', errors.length === 0, errors.join(' | '));
  await browser.close();
} catch (e) {
  check('packaged app runs', false, e instanceof Error ? e.message : String(e));
} finally {
  app.kill();
  await sleep(1000);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows may still hold a file for a moment */
  }
}
process.exit(failures.length ? 1 : 0);
