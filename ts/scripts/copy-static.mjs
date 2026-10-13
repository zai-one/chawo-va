// Copies renderer HTML/CSS, the mic AudioWorklet and icons next to the compiled JS. No bundler needed yet.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'dist/renderer'), { recursive: true });
for (const f of ['index.html', 'style.css', 'decoder.html', 'mic-processor.js', 'overlay.html', 'overlay.css']) cpSync(join(root, 'src/renderer', f), join(root, 'dist/renderer', f));
cpSync(join(root, '../src/Assets/iconset'), join(root, 'dist/assets/iconset'), { recursive: true });
// The Windows helper, when it was built (npm run build:native; needs the .NET SDK, any OS).
const helper = join(root, 'native/win/bin/out/ChawoNative.exe');
if (existsSync(helper)) {
  mkdirSync(join(root, 'dist/native'), { recursive: true });
  cpSync(helper, join(root, 'dist/native/ChawoNative.exe'));
  cpSync(helper + '.config', join(root, 'dist/native/ChawoNative.exe.config'));
}
