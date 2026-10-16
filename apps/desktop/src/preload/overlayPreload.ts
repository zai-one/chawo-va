// Bridge for the floating pill (overlay.html): state and level in, its measured size out. Nothing else.
import { contextBridge, ipcRenderer } from 'electron';
import type { OverlayApi, OverlayState } from '@chawo/ipc/contract';

const api: OverlayApi = {
  onState: (listener) => {
    ipcRenderer.on('overlay:state', (_e, state: OverlayState) => listener(state));
  },
  onLevel: (listener) => {
    ipcRenderer.on('overlay:level', (_e, level: number) => listener(level));
  },
  size: (width, height) => ipcRenderer.send('overlay:size', width, height),
};

contextBridge.exposeInMainWorld('chawoOverlay', api);
