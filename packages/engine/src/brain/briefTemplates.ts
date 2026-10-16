// Templates for «Кратко и задачи»: built-in formats (разбор звонка продаж, протокол встречи, краткое
// резюме) plus the user's own, stored locally in brief-templates.json beside settings.json. The page
// and `chawo-va brief --template <name>` resolve the same way. No Electron imports, unit-tested.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { t } from '@chawo/core/strings';

export interface BriefTemplate {
  /** Stable id for built-ins ('sales-call'); the name itself for custom ones. */
  id: string;
  /** Shown in the picker. */
  name: string;
  instruction: string;
  builtin: boolean;
}

export interface CustomTemplate {
  name: string;
  instruction: string;
}

/** Saved selection meaning «my own instruction» (the free textarea, MeetingBriefInstruction). */
export const OWN = '';
export const MAX_NAME = 60;
export const MAX_INSTRUCTION = 8000;

export function builtinTemplates(): BriefTemplate[] {
  return [
    {
      id: 'standard',
      name: t('Кратко и задачи (стандарт)', 'Brief and tasks (standard)'),
      builtin: true,
      instruction: t(
        'Кратко перескажи встречу (3–7 пунктов) и отдельно перечисли задачи и поручения. Если названы ответственные или сроки — укажи их. Пиши на языке расшифровки. Заголовки: «Кратко» и «Задачи». Каждый пункт с новой строки, начиная с «- ».',
        'Write a short summary of the meeting (3–7 bullets) and a separate list of tasks and action items. Include owners and deadlines when the transcript mentions them. Write in the language of the transcript. Use the headings «Summary» and «Tasks». Every item on its own line starting with "- ".',
      ),
    },
    {
      id: 'sales-call',
      name: t('Разбор звонка продаж', 'Sales call review'),
      builtin: true,
      instruction: t(
        'Это звонок менеджера по продажам с клиентом. Составь разбор строго по разделам с заголовками: «Клиент» (компания, роль собеседника, если названы), «Потребность» (что нужно клиенту и зачем), «Бюджет и сроки», «Кто принимает решение», «Возражения» (каждое возражение и как ответил менеджер), «Договорённости», «Следующий шаг» (что, кто, когда), «Что улучшить менеджеру» (1–3 пункта). Каждый пункт с новой строки, начиная с «- ». Если о чём-то не говорили — пиши «- не обсуждали». Ничего не придумывай. Пиши на языке расшифровки.',
        'This is a sales rep talking to a customer. Write a review with exactly these headings: «Customer» (company, the person\'s role if named), «Need» (what they want and why), «Budget and timing», «Decision maker», «Objections» (each objection and how the rep answered), «Agreements», «Next step» (what, who, when), «What the rep could improve» (1–3 items). Every item on its own line starting with "- ". If something was not discussed, write "- not discussed". Do not invent anything. Write in the language of the transcript.',
      ),
    },
    {
      id: 'minutes',
      name: t('Протокол встречи', 'Meeting minutes'),
      builtin: true,
      instruction: t(
        'Составь протокол встречи с заголовками: «Участники» (кто упоминается по имени), «Повестка» (обсуждённые темы), «Обсуждение» (по каждой теме 1–3 пункта: позиции и аргументы), «Решения» (что решили), «Поручения» (в формате «- Кто — что — срок»; если ответственный или срок не названы, пиши «не назначен» / «без срока»), «Открытые вопросы». Каждый пункт с новой строки, начиная с «- ». Только то, что есть в расшифровке. Пиши на языке расшифровки.',
        'Write meeting minutes with the headings: «Participants» (people named), «Agenda» (topics discussed), «Discussion» (1–3 items per topic: positions and arguments), «Decisions», «Action items» (as "- Who — what — due"; if an owner or date is not named, write "unassigned" / "no date"), «Open questions». Every item on its own line starting with "- ". Only what is in the transcript. Write in the language of the transcript.',
      ),
    },
    {
      id: 'summary',
      name: t('Краткое резюме', 'Short summary'),
      builtin: true,
      instruction: t(
        'Напиши краткое резюме записи: одна строка сути, затем 3–5 пунктов с главным, каждый с новой строки, начиная с «- ». Без заголовков и без списка задач. Не больше 80 слов. Пиши на языке расшифровки.',
        'Write a short summary of the recording: one line with the gist, then 3–5 key bullets, each on its own line starting with "- ". No headings and no task list. At most 80 words. Write in the language of the transcript.',
      ),
    },
  ];
}

/** CLI aliases for built-ins (Russian and English). */
const ALIASES: Record<string, string> = {
  standard: 'standard', default: 'standard', стандарт: 'standard', кратко: 'standard',
  'sales-call': 'sales-call', sales: 'sales-call', call: 'sales-call', продажи: 'sales-call', звонок: 'sales-call',
  minutes: 'minutes', protocol: 'minutes', протокол: 'minutes',
  summary: 'summary', резюме: 'summary',
};

const key = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

export function cleanCustom(list: readonly unknown[]): CustomTemplate[] {
  const out = new Map<string, CustomTemplate>();
  const builtinNames = new Set(builtinTemplates().flatMap((b) => [key(b.name), b.id]));
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) : '';
    const instruction = typeof r.instruction === 'string' ? r.instruction.replace(/\r\n?/g, '\n').trim().slice(0, MAX_INSTRUCTION) : '';
    if (!name || !instruction || builtinNames.has(key(name)) || ALIASES[key(name)]) continue;
    out.delete(key(name));
    out.set(key(name), { name, instruction });
  }
  return [...out.values()];
}

/** Built-ins first, then custom templates in saved order. */
export function allTemplates(custom: readonly CustomTemplate[]): BriefTemplate[] {
  return [...builtinTemplates(), ...cleanCustom(custom).map((c) => ({ id: c.name, name: c.name, instruction: c.instruction, builtin: false }))];
}

/** Finds a template by id, alias, shown name or custom name (case and ё insensitive). */
export function findTemplate(nameOrId: string, custom: readonly CustomTemplate[]): BriefTemplate | null {
  const k = key(nameOrId);
  if (!k) return null;
  const all = allTemplates(custom);
  const alias = ALIASES[k];
  return all.find((x) => x.id === (alias ?? k)) ?? all.find((x) => key(x.name) === k || key(x.id) === k) ?? null;
}

/**
 * What the Brain gets: the selected template's instruction, or (selection blank / gone) the
 * user's own instruction, or the standard default.
 */
export function resolveInstruction(selected: string, ownInstruction: string, custom: readonly CustomTemplate[]): { id: string; instruction: string } {
  if ((selected ?? '').trim()) {
    const tpl = findTemplate(selected, custom);
    if (tpl) return { id: tpl.id, instruction: tpl.instruction };
  }
  const own = (ownInstruction ?? '').trim();
  return { id: OWN, instruction: own || builtinTemplates()[0].instruction };
}

export function upsertCustom(list: readonly CustomTemplate[], tpl: CustomTemplate): CustomTemplate[] {
  const k = key(tpl.name);
  const next = list.filter((x) => key(x.name) !== k);
  const at = list.findIndex((x) => key(x.name) === k);
  if (at >= 0) next.splice(at, 0, tpl);
  else next.push(tpl);
  return cleanCustom(next);
}

export function removeCustom(list: readonly CustomTemplate[], name: string): CustomTemplate[] {
  const k = key(name);
  return list.filter((x) => key(x.name) !== k);
}

/** Why a name cannot be used for a custom template, or null. */
export function nameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return t('Введите название шаблона.', 'Type a template name.');
  if (n.length > MAX_NAME) return t(`Название длиннее ${MAX_NAME} знаков.`, `The name is longer than ${MAX_NAME} characters.`);
  if (ALIASES[key(n)] || builtinTemplates().some((b) => key(b.name) === key(n) || b.id === key(n)))
    return t('Так называется встроенный шаблон — выберите другое название.', 'A built-in template has this name — pick another one.');
  return null;
}

export function loadCustom(path: string): CustomTemplate[] {
  try {
    if (!existsSync(path)) return [];
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const arr = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { templates?: unknown }).templates) ? (raw as { templates: unknown[] }).templates : [];
    return cleanCustom(arr);
  } catch {
    return [];
  }
}

export function saveCustom(path: string, list: readonly CustomTemplate[]): CustomTemplate[] {
  const clean = cleanCustom(list);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, templates: clean }, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
  return clean;
}
