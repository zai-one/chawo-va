// «Голос»: a speech service set up on the page reads text aloud in the floating player. The service
// here is a tiny local server with the OpenAI-compatible /v1/audio/speech that answers with a WAV.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { expect, openPage, test } from './fixtures';

/** Half a second of 16 kHz mono silence. */
function wav(): Buffer {
  const data = Buffer.alloc(16000);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

let server: Server;
let base = '';
const asked: { url: string; body: Record<string, unknown> }[] = [];

test.beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      asked.push({ url: req.url ?? '', body: JSON.parse(body || '{}') as Record<string, unknown> });
      res.writeHead(200, { 'content-type': 'audio/wav' }).end(wav());
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

test.afterAll(() => new Promise<void>((done) => server.close(() => done())));

test.use({ seed: { history: ['Проверка озвучки из истории.'] } });

async function playerWindow(app: import('@playwright/test').ElectronApplication): Promise<Page> {
  const isPlayer = (p: Page) => p.url().endsWith('/player.html');
  const page = app.windows().find(isPlayer) ?? (await app.waitForEvent('window', { predicate: isPlayer }));
  await page.waitForLoadState('domcontentloaded');
  return page;
}

test('a service set up on «Голос» reads text in the player; «Озвучить» in history uses it', async ({ app, win }) => {
  await openPage(win, 'Голос');
  await win.locator('[data-voice="provider"]').selectOption('tts-custom');
  const url = win.locator('[data-voice="url"]');
  await url.fill(base);
  await url.press('Enter');
  await win.locator('[data-voice="voice"]').fill('ru-RU-SvetlanaNeural');
  await win.locator('[data-voice="voice"]').press('Enter');

  await win.locator('[data-voice="test"]').click();
  await expect(win.locator('[data-voice="status"]')).toHaveText('Работает, звук пришёл.');
  expect(asked.at(-1)).toMatchObject({
    url: '/v1/audio/speech',
    body: { model: 'tts-1', voice: 'ru-RU-SvetlanaNeural', input: 'Привет! Так звучит этот голос в Чаво.' },
  });

  const player = await playerWindow(app);
  await expect(player.locator('#title')).toHaveText('Привет! Так звучит этот голос в Чаво.');
  await expect(player.locator('#controls')).toBeVisible();
  await expect.poll(() => player.locator('#audio').evaluate((a: HTMLAudioElement) => a.duration)).toBeCloseTo(0.5, 1);
  await expect(player.locator('#total')).toHaveText('0:00');
  // The player never takes the focus from the app the user reads in.
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Chawo — озвучка')?.isFocusable())).toBe(false);

  // A new speed is remembered for the next reading.
  await player.locator('#rate').selectOption('1.5');
  await expect.poll(() => player.locator('#audio').evaluate((a: HTMLAudioElement) => a.playbackRate)).toBe(1.5);

  await openPage(win, 'История');
  await win.locator('.hist-item').first().locator('[data-voice="speak"]').click();
  await expect.poll(() => asked.at(-1)?.body.input).toBe('Проверка озвучки из истории.');
  await expect(player.locator('#title')).toHaveText('Проверка озвучки из истории.');
  await expect(player.locator('#rate')).toHaveValue('1.5');

  // «Настройки голоса» brings the main window to «Голос»; × hides the player.
  await player.locator('#settings').click();
  await expect(win.locator('#page h1')).toHaveText('Голос');
  await expect(win.locator('[data-voice="provider"]')).toHaveValue('tts-custom');
  await player.locator('#close').click();
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Chawo — озвучка')?.isVisible())).toBe(false);
});
