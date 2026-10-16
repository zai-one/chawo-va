// Knip: unused files, exports and dependencies across the workspace (`pnpm knip`).
import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  workspaces: {
    '.': {
      // Spawned by tests through a path, not imported.
      entry: ['fixtures/**/*.cjs'],
    },
    'packages/core': {},
    'packages/engine': {},
    'apps/cli': {},
    'apps/desktop': {
      // AudioWorklets are loaded by URL (audioWorklet.addModule), the smoke scripts are run by hand / CI.
      entry: ['src/preload/*.ts', 'src/renderer/*.html', 'src/renderer/public/*.js', 'scripts/*.cjs', 'scripts/*.mjs'],
      // Runtime modules of the bundled @chawo packages: listed here so electron-builder ships them in
      // node_modules. @chawo/cli is an extra build input (electron.vite.config.ts), not an import.
      ignoreDependencies: ['onnxruntime-node', 'opus-decoder', '@napi-rs/keyring', '@chawo/cli'],
    },
  },
};

export default config;
