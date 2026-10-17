// Bridge for the «Озвучить» button next to a selection (pill.html): label in; size, click, leave out.
import { contextBridge, ipcRenderer } from 'electron';
import type { PillApi } from '@chawo/ipc/contract';

const api: PillApi = {
  onState: (listener) => {
    ipcRenderer.on('pill:state', (_e, state: { label: string }) => listener(state));
  },
  size: (width, height) => ipcRenderer.send('pill:size', width, height),
  speak: () => ipcRenderer.send('pill:speak'),
  leave: () => ipcRenderer.send('pill:leave'),
};

contextBridge.exposeInMainWorld('chawoPill', api);
