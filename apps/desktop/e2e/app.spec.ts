// The window as a whole: it starts, it is dark, every page opens from the nav (by mouse and by
// keyboard), and the page cannot reach Node, Electron or the network.
import { expect, openPage, test } from './fixtures';

const PAGES = ['Диктовка', 'Расшифровка файла', 'История', 'Распознавание', 'Словарь', 'Продажи', 'Мозг', 'Голос', 'Сеть'];

test('starts with a dark window and the page list', async ({ app, win }) => {
  expect(await win.title()).toMatch(/Chawo/);
  const bg = await win.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const [r, g, b] = (bg.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
  expect((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255, `body background ${bg}`).toBeLessThan(0.25);
  await expect(win.locator('.nav button[data-page]')).toHaveText(PAGES);
  await expect(win.locator('.nav button.active')).toHaveText('Диктовка');
  const shown = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((w) => w.isVisible())
      .map((w) => w.getTitle()),
  );
  expect(shown).toEqual([await win.title()]);
});

test('every page opens from the nav and has its heading', async ({ win }) => {
  for (const name of PAGES) {
    await openPage(win, name);
    await expect(win.locator('#page h1')).toHaveText(name);
    await expect(win.locator('.nav button.active')).toHaveText(name);
    await expect(win.locator('#page')).not.toContainText(/в разработке/);
  }
});

test('the nav works from the keyboard', async ({ win }) => {
  await win.locator('.nav button[data-page]').first().focus();
  await win.keyboard.press('Tab');
  await win.keyboard.press('Tab');
  await expect(win.locator('.nav button:focus')).toHaveText('История');
  await win.keyboard.press('Enter');
  await expect(win.locator('#page h1')).toHaveText('История');
  await win.keyboard.press('Shift+Tab');
  await win.keyboard.press('Space');
  await expect(win.locator('#page h1')).toHaveText('Расшифровка файла');
});

test('the page list folds to a rail of icons and back (button, Ctrl+B), and stays folded', async ({ win }) => {
  const nav = win.locator('.nav');
  const toggle = nav.getByRole('button', { name: /Свернуть меню/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect(nav).toHaveClass(/collapsed/);
  // Folded: icons only, but every page keeps its name for screen readers, tests and the tooltip.
  await expect(nav.locator('button[data-page="history"]')).toHaveAttribute('data-tip', 'История');
  // The width animates (--motion-base): wait for where it settles, not a frame of the way there.
  await expect.poll(() => nav.evaluate((el) => el.getBoundingClientRect().width)).toBeLessThan(80);
  await openPage(win, 'Мозг');
  await expect(win.locator('.nav button[aria-current="page"]')).toHaveAttribute('data-page', 'brain');
  // The choice belongs to this computer: a reload keeps it.
  await win.reload();
  await expect(win.locator('.nav')).toHaveClass(/collapsed/);
  await win.keyboard.press('Control+b');
  await expect(win.locator('.nav')).not.toHaveClass(/collapsed/);
  await expect(win.locator('.nav').getByRole('button', { name: /Свернуть меню/ })).toHaveAttribute('aria-expanded', 'true');
});

test('the page list is as wide as its edge is dragged; narrow folds it, double-click brings the usual width', async ({ win }) => {
  const nav = win.locator('.nav');
  const edge = win.getByRole('separator', { name: 'Ширина меню' });
  const navWidth = () => nav.evaluate((el) => Math.round(el.getBoundingClientRect().width));
  const dragEdgeTo = async (x: number) => {
    const box = (await edge.boundingBox())!;
    const y = box.y + box.height / 2;
    await win.mouse.move(box.x + box.width / 2, y);
    await win.mouse.down();
    await win.mouse.move(x, y, { steps: 6 });
    await win.mouse.up();
  };
  if (await nav.evaluate((el) => el.classList.contains('collapsed'))) await win.keyboard.press('Control+b');
  await expect.poll(navWidth).toBe(220);
  await dragEdgeTo(300);
  await expect.poll(navWidth).toBe(300);
  await expect(edge).toHaveAttribute('aria-valuenow', '300');
  // The width belongs to this computer: a reload keeps it.
  await win.reload();
  await expect.poll(navWidth).toBe(300);
  // Dragged narrow, the list folds to the rail; the arrow key on the edge opens it at the narrowest width.
  await dragEdgeTo(60);
  await expect(nav).toHaveClass(/collapsed/);
  await edge.focus();
  await win.keyboard.press('ArrowRight');
  await expect(nav).not.toHaveClass(/collapsed/);
  await expect.poll(navWidth).toBe(168);
  await edge.dblclick();
  await expect.poll(navWidth).toBe(220);
});

test('the page is isolated: no Node, no Electron, only the contract API', async ({ app, win }) => {
  const seen = await win.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return {
      require: typeof w.require,
      process: typeof w.process,
      module: typeof w.module,
      api: Object.keys(w.chawo as object).sort(),
    };
  });
  expect(seen).toEqual({
    require: 'undefined',
    process: 'undefined',
    module: 'undefined',
    api: ['invoke', 'on', 'pathForFile', 'send', 'versions'],
  });
  // A channel outside the contract is refused by the preload, before it reaches main.
  const unknownChannel = await win.evaluate(async () => {
    const api = (window as unknown as { chawo: { invoke: (ch: string) => Promise<unknown> } }).chawo;
    try {
      await api.invoke('shell:openExternal');
      return 'answered';
    } catch (e) {
      return String(e);
    }
  });
  expect(unknownChannel).not.toBe('answered');
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL() === 'chawo-app://bundle/index.html');
    // Not in Electron's typings, but present: the preferences the page actually runs with.
    const p = (
      w?.webContents as unknown as { getLastWebPreferences(): Electron.WebPreferences | null } | undefined
    )?.getLastWebPreferences();
    return { contextIsolation: p?.contextIsolation, sandbox: p?.sandbox, nodeIntegration: p?.nodeIntegration, webSecurity: p?.webSecurity };
  });
  expect(prefs).toEqual({ contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true });
});

test('the page cannot leave the app or reach the network', async ({ app, win, problems }) => {
  const before = win.url();
  const fetched = await win.evaluate(() =>
    fetch('https://example.com/').then(
      () => 'fetched',
      () => 'refused',
    ),
  );
  expect(fetched).toBe('refused');
  await win.evaluate(() => window.open('https://example.com/', '_blank'));
  await win.evaluate(() => {
    location.href = 'https://example.com/';
  });
  await win.waitForTimeout(500);
  expect(win.url()).toBe(before);
  expect(app.windows().filter((p) => p.url().startsWith('https:'))).toEqual([]);
  // The refused fetch is logged by the CSP check (connect-src 'none'): that is the expected outcome.
  const csp = problems.filter((p) => /Content Security Policy|connect-src/.test(p));
  expect(csp.length).toBeGreaterThan(0);
  problems.splice(0, problems.length, ...problems.filter((p) => !csp.includes(p) && !/Failed to fetch/.test(p)));
});
