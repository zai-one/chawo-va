// Bridge for the sales card (salesCard.html): state in, its measured size and the × out. Nothing else.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('chawoSalesCard', {
  onState: (fn: (s: unknown) => void) => {
    ipcRenderer.on('salesCard:state', (_e, s: unknown) => fn(s));
  },
  size: (w: number, h: number) => ipcRenderer.send('salesCard:size', w, h),
  dismiss: () => ipcRenderer.send('salesCard:dismiss'),
});
