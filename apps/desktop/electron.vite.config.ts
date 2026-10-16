// One build for the whole desktop package: main (+ the chawo-va CLI, which the same exe runs in Node
// mode), the sandboxed preloads and the renderer pages. Workspace packages (@chawo/*) are bundled;
// native and runtime modules from "dependencies" stay external and ship in node_modules.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string };
const define = { __CHAWO_VERSION__: JSON.stringify(pkg.version) };
const repoRoot = resolve(__dirname, '../..');

/**
 * Dev server only: the pages' CSP must let the Vite client in (HMR socket, inline preamble, CSS injected
 * as <style>). The built pages keep the strict policy from the HTML untouched.
 */
function devCsp(): Plugin {
  const relax = (csp: string): string => {
    const dirs = new Map(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => [d.split(/\s+/)[0], d] as const));
    dirs.set('script-src', "script-src 'self' 'unsafe-inline'");
    dirs.set('style-src', "style-src 'self' 'unsafe-inline'");
    dirs.set('connect-src', "connect-src 'self' ws://localhost:* http://localhost:*");
    return [...dirs.values()].join('; ');
  };
  return {
    name: 'chawo-dev-csp',
    apply: 'serve',
    transformIndexHtml: (html) =>
      html.replace(/(<meta http-equiv="Content-Security-Policy" content=")([^"]*)(")/, (_m, a: string, csp: string, z: string) => a + relax(csp) + z),
  };
}

export default defineConfig({
  main: {
    define,
    build: {
      outDir: 'out/main',
      sourcemap: true,
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'src/main/main.ts'),
          cli: resolve(repoRoot, 'apps/cli/src/cli.ts'),
        },
        // One file per source module (out/main/<repo path>.js), entries at out/main/{main,cli}.js:
        // stack traces stay readable and the smoke scripts can load single modules of the built app.
        treeshake: false,
        output: { format: 'cjs', preserveModules: true, preserveModulesRoot: repoRoot, entryFileNames: '[name].js' },
      },
    },
  },
  preload: {
    define,
    build: {
      outDir: 'out/preload',
      sourcemap: true,
      rollupOptions: {
        input: {
          preload: resolve(__dirname, 'src/preload/preload.ts'),
          overlayPreload: resolve(__dirname, 'src/preload/overlayPreload.ts'),
          salesCardPreload: resolve(__dirname, 'src/preload/salesCardPreload.ts'),
          decoderPreload: resolve(__dirname, 'src/preload/decoderPreload.ts'),
        },
        // Sandboxed preloads: one CommonJS file each, nothing but 'electron' required at runtime.
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [devCsp()],
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay.html'),
          salesCard: resolve(__dirname, 'src/renderer/salesCard.html'),
          decoder: resolve(__dirname, 'src/renderer/decoder.html'),
        },
      },
    },
  },
});
