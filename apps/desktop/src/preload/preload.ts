// The only bridge between the sandboxed main window and the main process: the contract channels of
// @chawo/ipc and nothing else. Calls on any other channel are refused here, before they reach main.
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { EVENT_CHANNELS, INVOKE_CHANNELS, SEND_CHANNELS, type ChawoApi } from '@chawo/ipc/contract';

const invokeOk = new Set<string>(INVOKE_CHANNELS);
const sendOk = new Set<string>(SEND_CHANNELS);
const eventOk = new Set<string>(EVENT_CHANNELS);

const api: ChawoApi = {
  invoke: (channel, ...args) => {
    if (!invokeOk.has(channel)) return Promise.reject(new Error(`unknown channel ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  send: (channel, ...args) => {
    if (sendOk.has(channel)) ipcRenderer.send(channel, ...args);
  },
  on: (channel, listener) => {
    if (!eventOk.has(channel)) return () => undefined;
    const h = (_e: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]) => listener(payload);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
  versions: { app: __CHAWO_VERSION__, electron: process.versions.electron },
};

contextBridge.exposeInMainWorld('chawo', api);
