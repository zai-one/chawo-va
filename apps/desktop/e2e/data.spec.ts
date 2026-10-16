// What the user types is kept: the dictionary survives a restart, history search and delete work on
// chawo.db (and a deleted take is gone from the file).
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { expect, launch, openPage, test } from './fixtures';

test('a dictionary replacement typed in the window is there after a restart', async ({ profile, app, win }) => {
  await openPage(win, 'Словарь');
  const rows = win.locator('.dict-row');
  const before = await rows.count();
  await win.getByRole('button', { name: 'Добавить', exact: true }).click();
  await expect(rows).toHaveCount(before + 1);
  // The new row's first field has the focus: type the way a user does.
  await expect(win.getByRole('textbox', { name: 'Как слышно' }).last()).toBeFocused();
  await win.keyboard.type('чаво');
  await win.keyboard.press('Tab');
  await win.keyboard.type('Chawo');
  await expect(win.getByRole('textbox', { name: 'Как писать' }).last()).toHaveValue('Chawo');
  await win.waitForTimeout(300);
  await app.close();

  const again = await launch(profile);
  try {
    await openPage(again.win, 'Словарь');
    const pairs = await again.win
      .locator('.dict-row')
      .evaluateAll((els) => els.map((el) => Array.from(el.querySelectorAll('input'), (i) => i.value).join('→')));
    expect(pairs).toContain('чаво→Chawo');
    expect(again.problems).toEqual([]);
  } finally {
    await again.app.close();
  }
});

test.describe('history', () => {
  test.use({ seed: { history: ['Совещание в пятницу.', 'Ёжик в тумане.', 'Лес в тумане.'] } });

  test('search by a word (ё = е) and delete a take', async ({ profile, win }) => {
    await openPage(win, 'История');
    const texts = win.locator('.hist-item .hist-text');
    await expect(texts).toHaveText(['Лес в тумане.', 'Ёжик в тумане.', 'Совещание в пятницу.']);

    await win.getByPlaceholder('Поиск по тексту').fill('еж');
    await expect(texts).toHaveText(['Ёжик в тумане.']);
    await win.getByPlaceholder('Поиск по тексту').fill('тумане');
    await expect(texts).toHaveCount(2);
    await win.getByPlaceholder('Поиск по тексту').fill('');
    await expect(texts).toHaveCount(3);

    await win.locator('.hist-item', { hasText: 'Ёжик' }).getByRole('button', { name: 'Удалить' }).click();
    await expect(texts).toHaveText(['Лес в тумане.', 'Совещание в пятницу.']);
    const db = new DatabaseSync(profile.db, { readOnly: true });
    try {
      const left = db
        .prepare('SELECT final FROM history ORDER BY ts')
        .all()
        .map((r) => r.final);
      expect(left).toEqual(['Совещание в пятницу.', 'Лес в тумане.']);
    } finally {
      db.close();
    }
  });
});

test.describe('Brain', () => {
  test.use({ seed: { settings: { Brain: 'Server', CleanupEndpointUrl: 'http://127.0.0.1:9/v1', CleanupModel: 'local' } } });

  test('«Контекст для Мозга» is off until the user turns it on, and the choice is saved', async ({ profile, win }) => {
    await openPage(win, 'Мозг');
    const clip = win.getByRole('checkbox', { name: 'Текст из буфера обмена' });
    const appTitle = win.getByRole('checkbox', { name: 'Программа и заголовок окна' });
    await expect(clip).not.toBeChecked();
    await expect(appTitle).not.toBeChecked();
    await clip.check();
    await expect(clip).toBeChecked();
    const saved = () => profile.use(() => JSON.parse(readFileSync(profile.settingsPath, 'utf8')) as Record<string, unknown>);
    await expect.poll(() => saved().BrainContextClipboard).toBe(true);
    expect(saved().BrainContextApp).toBe(false);
    await openPage(win, 'Диктовка');
    await openPage(win, 'Мозг');
    await expect(clip).toBeChecked();
  });
});
