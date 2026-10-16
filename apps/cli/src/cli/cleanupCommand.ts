// `chawo-va cleanup [--yes] [--all] [--days N] [--json]`: the same «Место на диске» as on the
// «Распознавание» page. Without --yes it only lists; with --yes it deletes what the page ticks by itself
// (older versions, unfinished downloads, old engines, plain-text copies, temporary files); --all adds
// the rest (models that are not selected, transcribed recordings and downloads).
import type { CleanupOptions } from '@chawo/engine/cleanup/diskCleanup';
import { remove, scan, sizeText } from '@chawo/engine/cleanup/diskCleanup';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, type CliDeps } from './run';

interface Parsed { yes: boolean; all: boolean; json: boolean; days: number }

function parse(args: readonly string[]): Parsed | string {
  const p: Parsed = { yes: false, all: false, json: false, days: 30 };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--yes' || a === '-y') p.yes = true;
    else if (a === '--all') p.all = true;
    else if (a === '--json') p.json = true;
    else if (a === '--lang') i++;
    else if (a.startsWith('--lang=')) continue;
    else if (a === '--days' || a.startsWith('--days=')) {
      const v = a === '--days' ? args[++i] : a.slice('--days='.length);
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 3650) return '--days needs a whole number of days (0…3650)';
      p.days = n;
    } else return `unknown option: ${a}`;
  }
  return p;
}

export function cleanupCommand(args: readonly string[], d: CliDeps): number {
  const t = d.t;
  const p = parse(args);
  if (typeof p === 'string') {
    d.err(`chawo-va cleanup: ${p}\n`);
    return EXIT_USAGE;
  }
  if (!d.cleanupOptions) {
    d.err(t('chawo-va cleanup: недоступно в этой сборке\n', 'chawo-va cleanup: not available in this build\n'));
    return EXIT_FAILED;
  }
  const o: CleanupOptions = { ...d.cleanupOptions(), olderThanDays: p.days };
  const items = scan(o);
  const chosen = items.filter((i) => p.all || i.preselected);
  if (p.json && !p.yes) {
    d.out(JSON.stringify(items.map((i) => ({ group: i.group, label: i.label, bytes: i.bytes, preselected: i.preselected, paths: i.paths }))) + '\n');
    return EXIT_OK;
  }
  if (!p.json) {
    if (items.length === 0) d.out(t('Лишнего не найдено.\n', 'Nothing to clean up.\n'));
    for (const i of items) d.out(`${chosen.includes(i) ? '[x]' : '[ ]'} ${i.label} — ${sizeText(i.bytes)}\n      ${i.paths.join('\n      ')}\n`);
  }
  if (!p.yes) {
    if (items.length && !p.json) {
      const size = sizeText(chosen.reduce((n, i) => n + i.bytes, 0));
      d.out(t(`\nУдалить отмеченное [x] (${size}): chawo-va cleanup --yes; всё: --yes --all\n`, `\nDelete the items marked [x] (${size}): chawo-va cleanup --yes; everything: --yes --all\n`));
    }
    return EXIT_OK;
  }
  const r = remove(chosen.map((i) => i.id), o);
  if (p.json) d.out(JSON.stringify(r) + '\n');
  else {
    d.out(t(`Освобождено ${sizeText(r.freedBytes)}.\n`, `Freed ${sizeText(r.freedBytes)}.\n`));
    for (const f of r.failed) d.err(t(`Не удалено: ${f.path}: ${f.error}\n`, `Not deleted: ${f.path}: ${f.error}\n`));
  }
  return r.failed.length ? EXIT_FAILED : EXIT_OK;
}
