// Typed ipcMain for the main window, after the contract in @chawo/ipc. Every handler checks that the
// call comes from the app's own page (chawo-app://bundle/index.html, or the dev server in `pnpm dev`): a
// frame that navigated elsewhere, a devtools snippet in another page or a stray window gets refused.
// Arguments stay `unknown` here on purpose — they cross a trust boundary and each handler checks them.
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';
import type { EventChannel, EventMap, InvokeChannel, InvokeResult, SendChannel } from '@chawo/ipc/contract';
import * as Log from '@chawo/engine/log';
import * as AppPaths from './appPaths';

type Sender = { senderFrame?: { url: string } | null };

/** The main window's page: chawo-app://bundle/index.html, or index.html on the dev server. */
export function isAppPage(url: string, devOrigin: string | null): boolean {
  try {
    const u = new URL(url);
    // URL.origin is 'null' for a custom scheme: compare its parts.
    if (u.protocol === `${AppPaths.APP_SCHEME}:`) return u.host === 'bundle' && u.pathname === '/index.html' && !u.username && !u.port;
    return devOrigin !== null && u.origin === devOrigin && (u.pathname === '/index.html' || u.pathname === '/');
  } catch {
    return false;
  }
}

function trusted(e: Sender, channel: string): boolean {
  const url = e.senderFrame?.url ?? '';
  if (isAppPage(url, AppPaths.devOrigin())) return true;
  Log.write(`ipc ${channel}: refused a call from ${url || 'a frame that is gone'}`);
  return false;
}

/** ipcMain.handle for a contract channel; the result type is checked against the contract. */
export function handle<C extends InvokeChannel>(
  channel: C,
  fn: (e: IpcMainInvokeEvent, ...args: unknown[]) => InvokeResult<C> | Promise<InvokeResult<C>>,
): void {
  ipcMain.handle(channel, (e, ...args: unknown[]) => {
    if (!trusted(e, channel)) throw new Error(`${channel}: not from the app window`);
    return fn(e, ...args);
  });
}

/** ipcMain.on for a fire-and-forget contract channel (audio chunks); untrusted senders are dropped. */
export function onSend<C extends SendChannel>(channel: C, fn: (e: IpcMainEvent, ...args: unknown[]) => void): void {
  ipcMain.on(channel, (e, ...args: unknown[]) => {
    if (trusted(e, channel)) fn(e, ...args);
  });
}

/** webContents.send for a contract push; no-op once the window is gone. */
export function emit<C extends EventChannel>(target: { webContents: WebContents; isDestroyed(): boolean } | null | undefined, channel: C, payload: EventMap[C]): void {
  if (target && !target.isDestroyed()) target.webContents.send(channel, payload);
}
