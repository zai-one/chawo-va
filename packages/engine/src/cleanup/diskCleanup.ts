// «Место на диске»: what the app and older versions left on disk that is no longer needed, with sizes,
// and its removal. Shared by the «Распознавание» page and `chawo-va cleanup`. No Electron here.
//
// Safety, in this order:
//   - only known leftovers in the app's own folders are found (the folders below, fixed name patterns);
//   - nothing in use is touched: the selected speech model, the Brain model and engine, a download that
//     is still being written (a partial file changed within the last 10 minutes is left alone);
//   - remove() takes ids, not paths: it scans again and deletes only what that fresh scan found;
//   - recordings and downloaded audio are offered only when a transcript lies next to them, and are
//     never preselected.

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { SIBLING_AUDIO_EXTS } from '@chawo/core/localMedia';
import type { SpeechModelKind } from '@chawo/core/speechModels';
import { t } from '@chawo/core/strings';
import * as LocalBrain from '../brain/localBrain';
import { PROGRAM_EXE_NAMES } from '../dataMigration';
import * as Log from '../log';
import { deletableTargets, findComplete } from '../models/speechModelStore';
import { appDataDir, legacyLocalDir, legacyRoamingDir, localDataDir } from '../paths';
import { toSpeechModelKind, type SettingsData } from '../settings';

export type CleanupGroup = 'legacy' | 'partial' | 'unused' | 'privacy' | 'temp' | 'recordings' | 'downloads';

export interface CleanupItem {
  /** Stable for the same leftover: remove() matches it against a fresh scan. */
  id: string;
  group: CleanupGroup;
  label: string;
  detail: string;
  paths: string[];
  bytes: number;
  /** Ticked when the list opens: safe to delete, nothing of value is lost. */
  preselected: boolean;
}

export interface CleanupFolders {
  /** Meeting folders (both UI-language names; the env override). */
  meetings?: string[];
  /** Downloads/Chawo, where audio from links is saved. */
  downloads?: string | null;
}

export interface CleanupOptions extends CleanupFolders {
  settings: SettingsData;
  /** More paths in use (open sessions, a file in the queue): never offered, nor anything around them. */
  keep?: string[];
  /** Recordings and downloads are offered once transcribed and older than this. */
  olderThanDays?: number;
  now?: () => number;
}

export interface CleanupResult {
  removed: string[];
  failed: { path: string; error: string }[];
  freedBytes: number;
}

const ACTIVE_WRITE_MS = 10 * 60_000;
const TRANSCRIPT_EXTS = ['.txt', '.srt', '.vtt', '.docx', '.md', '.json'];
const SPEECH_KINDS: readonly SpeechModelKind[] = ['v3_e2e_rnnt', 'multilingual_large_ctc'];

const keyOf = (p: string): string => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));

function isInside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel));
}

/** Bytes on disk of a file or a folder tree (symlinks are not followed). */
export function sizeOf(path: string): number {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  let total = 0;
  try {
    for (const name of readdirSync(path)) total += sizeOf(join(path, name));
  } catch {
    /* unreadable: count what was seen */
  }
  return total;
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** «1,2 ГБ» / «340 МБ» / «12 КБ». */
export function sizeText(bytes: number): string {
  const unit = (ru: string, en: string) => t(ru, en);
  const fmt = (n: number) => (Math.round(n * 10) / 10).toLocaleString(t('ru-RU', 'en-US'));
  if (bytes >= 1024 ** 3) return `${fmt(bytes / 1024 ** 3)} ${unit('ГБ', 'GB')}`;
  if (bytes >= 1024 ** 2) return `${fmt(bytes / 1024 ** 2)} ${unit('МБ', 'MB')}`;
  return `${Math.max(1, Math.round(bytes / 1024))} ${unit('КБ', 'KB')}`;
}

/** What is in use now: never offered for removal, nor any folder that holds it. */
function inUse(s: SettingsData, extra: readonly string[]): string[] {
  const keep = [...extra];
  const found = findComplete(toSpeechModelKind(s.SpeechModel));
  if (found) keep.push(found);
  keep.push(LocalBrain.modelPath(s));
  keep.push(LocalBrain.engineDirFor(s.BrainDevice));
  return keep.filter(Boolean).map((p) => resolve(p));
}

/** Leftovers found now. Sizes are measured; nothing is changed. */
export function scan(o: CleanupOptions): CleanupItem[] {
  const now = (o.now ?? Date.now)();
  const keep = inUse(o.settings, o.keep ?? []);
  const touchesKept = (p: string) => keep.some((k) => isInside(k, p) || isInside(p, k));
  const items: CleanupItem[] = [];
  const seen = new Set<string>();
  const add = (group: CleanupGroup, label: string, detail: string, paths: string[], preselected: boolean) => {
    const fresh = paths.filter((p) => existsSync(p) && !touchesKept(p) && !seen.has(keyOf(p)));
    if (fresh.length === 0) return;
    for (const p of fresh) seen.add(keyOf(p));
    const id = createHash('sha256').update(group + '\0' + fresh.map(keyOf).sort().join('\0')).digest('hex').slice(0, 16);
    items.push({ id, group, label, detail, paths: fresh, bytes: fresh.reduce((n, p) => n + sizeOf(p), 0), preselected });
  };
  const local = localDataDir();
  const roaming = appDataDir();
  const brain = LocalBrain.dir();
  const settled = (p: string) => now - mtime(p) > ACTIVE_WRITE_MS;

  // Older versions: the GigaPisar folders (before 1.17). The app reads nothing from them any more
  // except an old speech model, and a model in use there is kept by inUse().
  for (const [dir, where] of [
    [legacyLocalDir(), t('локальные данные', 'local data')],
    [legacyRoamingDir(), t('настройки', 'settings')],
  ] as const) {
    if (isDir(dir) && !PROGRAM_EXE_NAMES.some((n) => existsSync(join(dir, n)))) {
      add('legacy', t(`Папка старой версии GigaPisar (${where})`, `Old GigaPisar folder (${where})`), dir, [dir], true);
    }
  }
  const staging = `${local}.migrating`;
  if (isDir(staging)) add('legacy', t('Незавершённый перенос данных старой версии', 'Unfinished move of old-version data'), staging, [staging], true);

  // Unfinished downloads (a file that is still being written is left alone).
  const partials: string[] = [];
  const consider = (p: string) => existsSync(p) && settled(p) && partials.push(p);
  consider(join(local, 'model.tar.gz.part'));
  for (const name of list(join(local, 'models'))) {
    const p = join(local, 'models', name);
    if (name.endsWith('.tmp') || name.endsWith('.part')) consider(p);
    else if (isDir(p)) for (const f of list(p)) if (f.endsWith('.part') || f.endsWith('.tmp')) consider(join(p, f));
  }
  for (const name of list(brain)) {
    if (name.endsWith('.part') || name.endsWith('.tmp')) consider(join(brain, name));
  }
  const tools = join(local, 'tools');
  for (const p of [join(tools, 'ffmpeg-download.zip'), join(tools, 'ffmpeg-staging'), join(tools, 'yt-dlp', 'yt-dlp.download'), join(tools, 'yt-dlp', 'yt-dlp.exe.download')]) consider(p);
  if (o.downloads) for (const name of list(o.downloads)) if (/\.(part|ytdl)$|\.part-Frag\d+/.test(name)) consider(join(o.downloads, name));
  // The Brain model being downloaded keeps its .part for resume: offered, not preselected.
  const brainPart = LocalBrain.modelPath(o.settings) + '.part';
  for (const p of partials) {
    const resume = keyOf(p) === keyOf(brainPart);
    add(
      'partial',
      resume ? t('Недокачанная модель Мозга (докачается при следующем скачивании)', 'Brain model download in progress (resumes next time)') : t('Недокачанный файл', 'Unfinished download'),
      p,
      [p],
      !resume,
    );
  }

  // Not used: old llama.cpp engines, the other engine variant, speech models that are not selected,
  // Brain models other than the chosen one, the last-take WAV of a setting that is off.
  const oldEngines = list(brain).filter((n) => /^engine-/.test(n) && !n.endsWith('.tmp') && !n.endsWith('.part') && !n.startsWith(`engine-${LocalBrain.EngineTag}`));
  if (oldEngines.length) add('unused', t('Старые версии движка Мозга (llama.cpp)', 'Old Brain engine versions (llama.cpp)'), oldEngines.join(', '), oldEngines.map((n) => join(brain, n)), true);
  const otherDevice = o.settings.BrainDevice === 'Gpu' ? 'Cpu' : 'Gpu';
  const otherEngine = LocalBrain.engineDirFor(otherDevice);
  if (isDir(otherEngine)) {
    add('unused', otherDevice === 'Gpu' ? t('Движок Мозга для видеокарты (сейчас выбран процессор)', 'Brain engine for the video card (the processor is selected)') : t('Движок Мозга для процессора (сейчас выбрана видеокарта)', 'Brain engine for the processor (the video card is selected)'), otherEngine, [otherEngine], false);
  }
  for (const g of LocalBrain.installedGgufs()) {
    add('unused', t(`Модель Мозга «${basename(g.path)}» (не выбрана)`, `Brain model «${basename(g.path)}» (not selected)`), g.path, [g.path], false);
  }
  for (const kind of SPEECH_KINDS) {
    if (kind === toSpeechModelKind(o.settings.SpeechModel)) continue;
    const targets = deletableTargets(kind);
    const label = kind === 'v3_e2e_rnnt' ? t('Русская модель v3 (не выбрана)', 'Russian v3 model (not selected)') : t('Большая модель распознавания (не выбрана)', 'Large speech model (not selected)');
    add('unused', label, targets.join('\n'), targets, false);
  }
  if (!o.settings.KeepLastRecording) {
    add('unused', t('Последняя запись диктовки (сохранение выключено)', 'Last dictation recording (keeping it is off)'), join(local, 'last.wav'), [join(local, 'last.wav')], true);
  }

  // Privacy: copies left by the move to chawo.db, and broken settings files kept for inspection.
  add('privacy', t('Копия истории диктовок после переноса в базу (открытым текстом)', 'Copy of the dictation history after the move to the database (plain text)'), join(local, 'history.jsonl.bak'), [join(local, 'history.jsonl.bak')], true);
  add('privacy', t('Копия журнала «В CRM» после переноса в базу', 'Copy of the «To CRM» journal after the move to the database'), join(local, 'crm-sent.json.bak'), [join(local, 'crm-sent.json.bak')], true);
  const bad = [...list(roaming).map((n) => join(roaming, n)), ...list(local).map((n) => join(local, n))].filter((p) => p.endsWith('.bad'));
  if (bad.length) add('privacy', t('Повреждённые файлы настроек, сохранённые для проверки', 'Damaged settings files kept for inspection'), bad.map((p) => basename(p)).join(', '), bad, false);

  // Temporary files of an interrupted write.
  const tmp = [...list(roaming).map((n) => join(roaming, n)), ...list(local).map((n) => join(local, n))].filter((p) => p.endsWith('.tmp') && !isDir(p) && settled(p));
  const firewall = join(tmpdir(), 'chawo-voice-assistant-firewall.cmd');
  if (existsSync(firewall) && settled(firewall)) tmp.push(firewall);
  if (tmp.length) add('temp', t('Временные файлы', 'Temporary files'), tmp.map((p) => basename(p)).join(', '), tmp, true);

  // Recordings and downloaded audio that already have a transcript next to them.
  const days = o.olderThanDays ?? 30;
  const old = (p: string) => now - mtime(p) > days * 86_400_000;
  const transcribed = (p: string) => {
    const stem = join(dirname(p), basename(p, extname(p)));
    return TRANSCRIPT_EXTS.some((e) => existsSync(stem + e));
  };
  const audio = (dir: string) => list(dir).map((n) => join(dir, n)).filter((p) => (SIBLING_AUDIO_EXTS as readonly string[]).includes(extname(p).toLowerCase()) && !isDir(p) && transcribed(p) && old(p));
  const recordings = [...new Set((o.meetings ?? []).map((d) => resolve(d)))].flatMap(audio);
  if (recordings.length) {
    add('recordings', t(`Записи встреч с готовой расшифровкой, старше ${days} дней (${recordings.length})`, `Meeting recordings with a transcript, older than ${days} days (${recordings.length})`), t('Расшифровки остаются.', 'Transcripts stay.'), recordings, false);
  }
  const downloaded = o.downloads ? audio(o.downloads) : [];
  if (downloaded.length) {
    add('downloads', t(`Аудио, скачанное по ссылкам, с готовой расшифровкой, старше ${days} дней (${downloaded.length})`, `Audio downloaded from links with a transcript, older than ${days} days (${downloaded.length})`), t('Расшифровки остаются.', 'Transcripts stay.'), downloaded, false);
  }
  return items;
}

/** Removes the items with these ids from a fresh scan (an id that is no longer found is skipped). */
export function remove(ids: readonly string[], o: CleanupOptions): CleanupResult {
  const want = new Set(ids);
  const result: CleanupResult = { removed: [], failed: [], freedBytes: 0 };
  for (const item of scan(o).filter((i) => want.has(i.id))) {
    for (const p of item.paths.slice().sort((a, b) => b.length - a.length)) {
      const bytes = sizeOf(p);
      try {
        rmSync(p, { recursive: true, force: true });
        result.removed.push(p);
        result.freedBytes += bytes;
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        result.failed.push({ path: p, error });
        Log.write(`cleanup: could not remove ${p}: ${error}`);
      }
    }
  }
  if (result.removed.length) Log.write(`cleanup: removed ${result.removed.length} path(s), ${result.freedBytes} bytes`);
  return result;
}
