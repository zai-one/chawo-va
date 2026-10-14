// Bridge for the floating pill (overlay.html): state and level in, its measured size out. Nothing else.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('chawoOverlay', {
  onState: (fn: (s: unknown) => void) => {
    ipcRenderer.on('overlay:state', (_e, s: unknown) => fn(s));
  },
  onLevel: (fn: (v: number) => void) => {
    ipcRenderer.on('overlay:level', (_e, v: number) => fn(v));
  },
  size: (w: number, h: number) => ipcRenderer.send('overlay:size', w, h),
});
