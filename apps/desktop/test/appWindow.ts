// For tests that call ipcMain handlers directly: the app root is set the way main.ts sets it, and the
// event looks like a call from the app's main window, which is what main's sender check asks for.
import { join } from 'node:path';
import * as AppPaths from '../src/main/appPaths';

const APP_ROOT = join('/opt', 'chawo-test-app');
AppPaths.init(join(APP_ROOT, 'out', 'main'));

export function appEvent(): { senderFrame: { url: string } } {
  return { senderFrame: { url: 'chawo-app://bundle/index.html' } };
}
