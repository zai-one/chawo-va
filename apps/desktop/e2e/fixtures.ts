// Playwright fixtures: the built app (out/main/main.js) on the electron binary, in a temp profile.
// Each test gets its own profile (settings, chawo.db, secrets.json, HOME): nothing touches the real
// one, the OS credential store is not used, and nothing leaves the machine (the app blocks it).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { _electron as electron, expect, test as base, type ElectronApplication, type Page } from '@playwright/test';

const root = join(__dirname, '..');
const outMain = join(root, 'out', 'main');
const load = createRequire(join(outMain, 'main.js'));

interface BuiltSettings {
  defaults(): Record<string, unknown>;
  toJsonObject(s: Record<string, unknown>): unknown;
}
interface BuiltPaths {
  databasePath(): string;
  settingsPath(): string;
}
interface BuiltHistory {
  HistoryStore: new (dbPath: string) => { add(take: Record<string, unknown>, keep: string): void };
}

export interface Profile {
  dir: string;
  env: Record<string, string>;
  /** Runs `fn` with this profile's env, so the app's own modules (from out/) read and write it. */
  use<T>(fn: () => T): T;
  /** Writes settings.json: the defaults with the Russian interface, changed by `edit`. */
  settings(edit: (s: Record<string, unknown>) => void): void;
  /** Whether settings.json was written (else the app starts with Russian defaults written by `launch`). */
  readonly seeded: boolean;
  /** chawo.db and settings.json of this profile. */
  readonly db: string;
  readonly settingsPath: string;
  /** Adds dictation takes to chawo.db (newest last). */
  history(takes: string[]): void;
}

function makeProfile(): Profile {
  const dir = mkdtempSync(join(tmpdir(), 'chawo-pw-'));
  const home = join(dir, 'home');
  const env: Record<string, string> = {
    CHAWO_APPDATA: join(dir, 'roaming'),
    CHAWO_LOCALAPPDATA: join(dir, 'local'),
    CHAWO_MEETINGS_DIR: join(dir, 'meetings'),
    CHAWO_SECRETS: 'file',
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
  };
  for (const d of [env.CHAWO_APPDATA, env.CHAWO_LOCALAPPDATA, env.XDG_CACHE_HOME]) mkdirSync(d, { recursive: true });
  const use = <T>(fn: () => T): T => {
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    try {
      return fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
  // The app's own modules as built (out/), so the profile is written exactly the way the app writes it.
  const Settings = load('./packages/engine/src/settings.js') as BuiltSettings;
  const Paths = load('./packages/engine/src/paths.js') as BuiltPaths;
  let seeded = false;
  return {
    dir,
    env,
    use,
    db: use(() => Paths.databasePath()),
    settingsPath: use(() => Paths.settingsPath()),
    get seeded() {
      return seeded;
    },
    settings: (edit) =>
      use(() => {
        const s = Settings.defaults();
        s.Language = 'Russian';
        edit(s);
        seeded = true;
        mkdirSync(dirname(Paths.settingsPath()), { recursive: true });
        writeFileSync(Paths.settingsPath(), JSON.stringify(Settings.toJsonObject(s), null, 2));
      }),
    history: (takes) =>
      use(() => {
        const { HistoryStore } = load('./packages/engine/src/history/historyStore.js') as BuiltHistory;
        const store = new HistoryStore(Paths.databasePath());
        const now = Date.now();
        // The connection stays open in this worker (idle, it blocks neither the app's writes nor its WAL checkpoints).
        takes.forEach((t, i) =>
          store.add(
            { raw: t, final: t, command: null, brain: false, brainFailed: false, seconds: 1, ts: now - (takes.length - i) * 1000 },
            'Week',
          ),
        );
      }),
  };
}

/** Starts the app in `profile` and returns it with its main window (the hidden decoder window is skipped). */
export async function launch(profile: Profile): Promise<{ app: ElectronApplication; win: Page; problems: string[] }> {
  if (!profile.seeded) profile.settings(() => undefined);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('CHAWO_') && !k.startsWith('PISAR_')) env[k] = v;
  Object.assign(env, profile.env);
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['--no-sandbox', join(outMain, 'main.js')], env, timeout: 30_000 });
  const problems: string[] = [];
  const watch = (p: Page) => {
    p.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console error: ${m.text()}`);
    });
    p.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    p.on('crash', () => problems.push('renderer crashed'));
  };
  app.windows().forEach(watch);
  app.on('window', watch);
  const isMain = (p: Page) => p.url().endsWith('/renderer/index.html');
  const win = app.windows().find(isMain) ?? (await app.waitForEvent('window', { predicate: isMain }));
  await win.waitForLoadState('domcontentloaded');
  await expect(win.locator('.nav button').first()).toBeVisible();
  return { app, win, problems };
}

interface Seed {
  /** settings.json fields over the defaults (Russian interface). */
  settings?: Record<string, unknown>;
  /** Dictation takes in chawo.db, oldest first. */
  history?: string[];
}

interface Options {
  /** What the profile holds before the app starts: `test.use({ seed: { settings: {…}, history: […] } })`. */
  seed: Seed;
}

interface Fixtures {
  /** The temp profile (already seeded and in use by the app). */
  profile: Profile;
  /** The running app (started on first use of `app` or `win`). */
  app: ElectronApplication;
  win: Page;
  /** Console errors, uncaught page errors and crashes of the app's windows; a test fails on any. */
  problems: string[];
}

export const test = base.extend<Options & Fixtures & { started: Awaited<ReturnType<typeof launch>> }>({
  seed: [{}, { option: true }],
  profile: async ({ seed }, use) => {
    const p = makeProfile();
    if (seed.settings) p.settings((s) => Object.assign(s, seed.settings));
    if (seed.history) p.history(seed.history);
    await use(p);
    rmSync(p.dir, { recursive: true, force: true });
  },
  started: async ({ profile }, use, info) => {
    const s = await launch(profile);
    let closed = false;
    s.app.on('close', () => (closed = true));
    await s.app.context().tracing.start({ screenshots: true, snapshots: true });
    await use(s);
    // A test may close the app itself (e.g. to start it again in the same profile).
    if (closed) return;
    const failed = info.status !== info.expectedStatus;
    if (failed && !s.win.isClosed()) await info.attach('window', { body: await s.win.screenshot(), contentType: 'image/png' });
    await s.app.context().tracing.stop(failed ? { path: info.outputPath('trace.zip') } : {});
    await s.app.close();
  },
  app: async ({ started }, use) => use(started.app),
  win: async ({ started }, use) => {
    await use(started.win);
    expect(started.problems, 'the app logged no errors').toEqual([]);
  },
  problems: async ({ started }, use) => use(started.problems),
});

export { expect };

/** Opens a page from the nav by its visible name. */
export async function openPage(win: Page, name: string | RegExp): Promise<void> {
  await win
    .locator('.nav')
    .getByRole('button', { name, exact: typeof name === 'string' })
    .click();
  await expect(win.locator('#page h1')).toBeVisible();
}
