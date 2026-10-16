// «Место на диске» on «Распознавание»: find what is not needed, the safe items are ticked, delete them.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, openPage, test } from './fixtures';

test.use({
  seed: {
    files: {
      'local/GigaPisar/models/v3/encoder.onnx': 3 * 1024 * 1024,
      'local/ChawoVoiceAssistant/history.jsonl.bak': '{"final":"старая диктовка"}\n',
      'local/ChawoVoiceAssistant/brain/other.gguf': 4096,
    },
  },
});

test('finds old leftovers, ticks only the safe ones and deletes them after confirmation', async ({ app, win, profile }) => {
  await openPage(win, 'Распознавание');
  const box = win.locator('[data-cleanup="box"]');
  await expect(box).toContainText('Место на диске');
  await box.getByRole('button', { name: 'Найти лишнее' }).click();

  const legacy = box.getByRole('checkbox', { name: /GigaPisar/ });
  const bak = box.getByRole('checkbox', { name: /Копия истории/ });
  const gguf = box.getByRole('checkbox', { name: /other\.gguf/ });
  await expect(legacy).toBeChecked();
  await expect(bak).toBeChecked();
  await expect(gguf).not.toBeChecked();
  await expect(box.locator('[data-cleanup-group="legacy"]')).toContainText('3 МБ');
  await expect(box.locator('[data-cleanup="status"]')).toContainText('Найдено');

  // The native confirmation answers «Удалить».
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false });
  });
  await box.getByRole('button', { name: 'Удалить выбранное' }).click();
  await expect(box.locator('[data-cleanup="status"]')).toContainText('Освобождено 3 МБ');
  await expect(legacy).toHaveCount(0);
  await expect(gguf).not.toBeChecked();
  expect(existsSync(join(profile.dir, 'local', 'GigaPisar'))).toBe(false);
  expect(existsSync(join(profile.dir, 'local', 'ChawoVoiceAssistant', 'history.jsonl.bak'))).toBe(false);
  expect(existsSync(join(profile.dir, 'local', 'ChawoVoiceAssistant', 'brain', 'other.gguf'))).toBe(true);
});
