// All unit tests of the workspace, one project per package (`pnpm test`, or `vitest --project engine`).
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const { version } = JSON.parse(readFileSync(new URL('./apps/desktop/package.json', import.meta.url), 'utf8')) as { version: string };

const project = (name: string, root: string) => ({
  extends: true as const,
  test: { name, root, include: ['test/**/*.test.ts'], environment: 'node' as const },
});

export default defineConfig({
  define: { __CHAWO_VERSION__: JSON.stringify(version) },
  test: {
    projects: [
      project('core', './packages/core'),
      project('engine', './packages/engine'),
      project('cli', './apps/cli'),
      project('ipc', './packages/ipc'),
      project('desktop', './apps/desktop'),
    ],
  },
});
