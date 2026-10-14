// Finds complete GigaAM weights on disk. Port of src/App/SpeechModelStore.cs.

import {
  existsSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Recognizer } from '../../core/recognizer';
import type { SpeechModelKind } from '../../core/speechModels';
import { modelFolder } from '../../core/speechModels';
import { PROGRAM_EXE_NAMES } from '../dataMigration';
import { write as logWrite } from '../log';
import {
  appDataDir,
  localDataDir,
  legacyLocalDir,
  legacyRoamingDir,
  modelDirectory,
  modelDirOverride,
} from '../paths';

export function canonicalDirectory(kind: SpeechModelKind): string {
  return modelDirectory(kind);
}

/** Directory of a complete copy, or null when this model has to be downloaded. */
export function findComplete(kind: SpeechModelKind): string | null {
  const seen = new Set<string>();
  for (const dir of candidateDirectories(kind)) {
    let full: string;
    try {
      full = resolve(dir);
    } catch {
      continue;
    }
    const key = process.platform === 'win32' ? full.toLowerCase() : full;
    if (seen.has(key)) continue;
    seen.add(key);
    if (looksComplete(full, kind)) return full;
  }
  return null;
}

export function looksComplete(dir: string, kind: SpeechModelKind): boolean {
  try {
    if (!Recognizer.modelExists(dir, kind)) return false;
    if (kind === 'v3_e2e_rnnt') {
      return (
        big(dir, 'v3_e2e_rnnt_encoder.onnx', 20 << 20) &&
        big(dir, 'v3_e2e_rnnt_decoder.onnx', 100 << 10) &&
        big(dir, 'v3_e2e_rnnt_joint.onnx', 100 << 10) &&
        big(dir, 'v3_e2e_rnnt_tokenizer.model', 10 << 10) &&
        big(dir, 'v3_e2e_rnnt.yaml', 100)
      );
    }
    return (
      big(dir, 'multilingual_large_ctc.onnx', 500 << 10) &&
      big(dir, 'multilingual_large_ctc.onnx.data', 2_000_000_000) &&
      big(dir, 'multilingual_large_ctc.yaml', 200) &&
      big(dir, 'multilingual_vocab.txt', 50)
    );
  } catch {
    return false;
  }
}

export function searchSummary(exeDir?: string): string {
  const local = localDataDir();
  const roaming = appDataDir();
  const exe = (exeDir ?? process.cwd()).replace(/[/\\]+$/, '');
  return [
    join(local, 'models'),
    join(local, 'model'),
    join(roaming, 'models'),
    join(roaming, 'model'),
    join(exe, 'models'),
    join(exe, 'model'),
    exe,
  ].join('\n');
}

function big(dir: string, name: string, minBytes: number): boolean {
  try {
    const info = statSync(join(dir, name));
    return info.isFile() && info.size >= minBytes;
  } catch {
    return false;
  }
}

export function* candidateDirectories(kind: SpeechModelKind, exeDir?: string): Generator<string> {
  const folder = modelFolder(kind);
  const local = localDataDir();
  const roaming = appDataDir();
  const exe = (exeDir ?? process.cwd()).replace(/[/\\]+$/, '');

  yield join(local, 'models', folder);
  yield join(local, 'model');
  yield join(local, 'models');
  yield local;

  yield join(roaming, 'models', folder);
  yield join(roaming, 'model');
  yield join(roaming, 'models');
  yield roaming;

  yield join(exe, 'models', folder);
  yield join(exe, 'model');
  yield join(exe, 'models');
  yield join(exe, folder);
  yield exe;

  const parent = dirname(exe);
  if (parent && parent !== exe) {
    yield join(parent, 'models', folder);
    yield join(parent, 'model');
    yield join(parent, 'models');
    yield parent;
  }

  const envDir = modelDirOverride();
  if (envDir) yield envDir;

  for (const legacy of [legacyLocalDir(), legacyRoamingDir()]) {
    yield join(legacy, 'models', folder);
    yield join(legacy, 'model');
  }

  for (const root of [
    join(local, 'models'),
    join(local, 'model'),
    local,
    join(roaming, 'models'),
    join(roaming, 'model'),
    join(exe, 'models'),
    join(exe, 'model'),
    exe,
  ]) {
    if (!existsSync(root)) continue;
    let children: string[];
    try {
      children = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => join(root, d.name));
    } catch {
      continue;
    }
    for (const child of children) yield child;
  }
}

export function deleteButtonLabel(kind: SpeechModelKind): string {
  return kind === 'v3_e2e_rnnt' ? 'Удалить русскую модель v3' : 'Удалить большую модель, 2,4 ГБ';
}

export function hasDeletable(kind: SpeechModelKind): boolean {
  return deletableTargets(kind).length > 0;
}

export function deletableTargets(kind: SpeechModelKind): string[] {
  const root = resolve(localDataDir());
  const list: string[] = [];
  const seen = new Set<string>();

  const keyOf = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

  const add = (path: string): void => {
    let full: string;
    try {
      full = resolve(path);
    } catch {
      return;
    }
    if (seen.has(keyOf(full))) return;
    seen.add(keyOf(full));
    if (!isUnder(full, root)) return;
    const dir = existsSync(full) && statSync(full).isDirectory() ? full : dirname(full);
    if (dir && PROGRAM_EXE_NAMES.some((n) => existsSync(join(dir, n)))) return;
    list.push(full);
  };

  const considerDirectory = (dir: string): void => {
    if (!existsSync(dir)) return;
    let full: string;
    try {
      full = resolve(dir);
    } catch {
      return;
    }
    if (!isUnder(full, root) || keyOf(full) === keyOf(root)) return;
    if (PROGRAM_EXE_NAMES.some((n) => existsSync(join(full, n)))) return;
    if (!directoryHasModelBits(full, kind) && !looksComplete(full, kind)) return;
    if (onlyThisModel(full, kind)) {
      add(full);
    } else {
      for (const name of filesOf(kind)) {
        const file = join(full, name);
        if (existsSync(file)) add(file);
      }
    }
  };

  considerDirectory(modelDirectory(kind));
  considerDirectory(modelDirectory(kind) + '.tmp');
  considerDirectory(join(root, 'model'));
  const models = join(root, 'models');
  if (existsSync(models)) {
    try {
      for (const child of readdirSync(models, { withFileTypes: true })) {
        if (child.isDirectory()) considerDirectory(join(models, child.name));
      }
    } catch {
      /* ignore */
    }
  }
  if (kind === 'v3_e2e_rnnt') {
    const part = join(root, 'model.tar.gz.part');
    if (existsSync(part)) add(part);
  }
  return list;
}

export function deleteInstalled(kind: SpeechModelKind): void {
  const errors: string[] = [];
  const targets = deletableTargets(kind).slice().sort((a, b) => b.length - a.length);
  for (const target of targets) {
    try {
      if (existsSync(target) && statSync(target).isDirectory()) {
        rmSync(target, { recursive: true, force: true });
      } else if (existsSync(target)) {
        rmSync(target, { force: true });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(msg);
      logWrite(`speech model delete failed: ${target}: ${msg}`);
    }
  }
  if (errors.length > 0) throw new Error(errors.join('\n'));
}

function isUnder(full: string, root: string): boolean {
  const rel = relative(root, full);
  if (!rel || rel === '..') return false;
  if (rel.startsWith('..' + sep) || rel.startsWith('..\\')) return false;
  // Path.isPathRooted equivalent: absolute relative means escaped
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return false;
  return true;
}

function filesOf(kind: SpeechModelKind): string[] {
  return kind === 'v3_e2e_rnnt'
    ? [
        'v3_e2e_rnnt_encoder.onnx',
        'v3_e2e_rnnt_decoder.onnx',
        'v3_e2e_rnnt_joint.onnx',
        'v3_e2e_rnnt_tokenizer.model',
        'v3_e2e_rnnt.yaml',
      ]
    : [
        'multilingual_large_ctc.onnx',
        'multilingual_large_ctc.onnx.data',
        'multilingual_large_ctc.yaml',
        'multilingual_vocab.txt',
      ];
}

function directoryHasModelBits(dir: string, kind: SpeechModelKind): boolean {
  try {
    for (const name of filesOf(kind)) {
      try {
        const info = statSync(join(dir, name));
        if (info.isFile() && info.size > 0) return true;
      } catch {
        /* missing */
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

function onlyThisModel(dir: string, kind: SpeechModelKind): boolean {
  try {
    const allowed = new Set(filesOf(kind).map((n) => n.toLowerCase()));
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) return false;
      if (st.isFile() && !allowed.has(name.toLowerCase())) return false;
    }
    return directoryHasModelBits(dir, kind);
  } catch {
    return false;
  }
}
