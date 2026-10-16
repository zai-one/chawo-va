// Bridge for the sales card (salesCard.html): state in, its measured size and the × out. Nothing else.
import { contextBridge, ipcRenderer } from 'electron';
import type { SalesCardApi, SalesCardState } from '@chawo/ipc/contract';

const api: SalesCardApi = {
  onState: (listener) => {
    ipcRenderer.on('salesCard:state', (_e, state: SalesCardState) => listener(state));
  },
  size: (width, height) => ipcRenderer.send('salesCard:size', width, height),
  dismiss: () => ipcRenderer.send('salesCard:dismiss'),
};

contextBridge.exposeInMainWorld('chawoSalesCard', api);
