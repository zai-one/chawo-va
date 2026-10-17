// What the user types is kept: the dictionary survives a restart, history search and delete work on
// chawo.db (and a deleted take is gone from the file).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

test.describe('Brain on this computer', () => {
  test.use({ seed: { settings: { Brain: 'Local' } } });

  test('any .gguf in the models folder is a choice of its own; the engine is fetched only by its button', async ({ profile, win }) => {
    const brain = join(profile.env.CHAWO_LOCALAPPDATA, 'ChawoVoiceAssistant', 'brain');
    const model = join(brain, 'Qwen3.5-9B-Q4_K_M.gguf');
    mkdirSync(brain, { recursive: true });
    writeFileSync(model, Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(4092)]));
    await openPage(win, 'Мозг');
    const row = win.locator('[data-brain-row="File"]');
    await expect(row).toContainText('Qwen3.5-9B-Q4_K_M.gguf');
    await expect(win.locator('[data-brain="modelsDir"]')).toHaveText(brain);
    await row.getByRole('radio').check();
    const saved = () => profile.use(() => JSON.parse(readFileSync(profile.settingsPath, 'utf8')) as Record<string, unknown>);
    await expect.poll(() => saved().BrainModel).toBe('File');
    expect(saved().BrainModelFile).toBe(model);
    await expect(row.getByRole('button', { name: 'Скачать движок' })).toBeVisible();
  });
});
