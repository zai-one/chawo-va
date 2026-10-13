// The only bridge between the sandboxed renderer and the main process. Keep it small and typed.
import { contextBridge, ipcRenderer, webUtils } from 'electron';

const api = {
  versions: { app: process.env.npm_package_version ?? '', electron: process.versions.electron },
  file: {
    state: () => ipcRenderer.invoke('file:state'),
    pick: (kind: 'files' | 'folder') => ipcRenderer.invoke('file:pick', kind),
    /** Drag-and-drop: File objects → absolute paths (File.path is gone in modern Electron). */
    addDropped: (files: File[]) =>
      ipcRenderer.invoke('file:add', files.map((f) => webUtils.getPathForFile(f)).filter(Boolean), true),
    remove: (id: number) => ipcRenderer.invoke('file:remove', id),
    clearFinished: () => ipcRenderer.invoke('file:clearFinished'),
    run: () => ipcRenderer.invoke('file:run'),
    stop: () => ipcRenderer.invoke('file:stop'),
    reveal: (path?: string) => ipcRenderer.invoke('file:reveal', path),
    setOptions: (o: Record<string, unknown>) => ipcRenderer.invoke('file:options', o),
    downloadFfmpeg: () => ipcRenderer.invoke('file:ffmpegDownload'),
    onState: (fn: (s: unknown) => void) => {
      const h = (_e: unknown, s: unknown) => fn(s);
      ipcRenderer.on('file:state', h);
      return () => ipcRenderer.removeListener('file:state', h);
    },
    onToast: (fn: (s: string) => void) => {
      const h = (_e: unknown, s: string) => fn(s);
      ipcRenderer.on('file:toast', h);
      return () => ipcRenderer.removeListener('file:toast', h);
    },
  },
};

contextBridge.exposeInMainWorld('chawo', api);
export type ChawoApi = typeof api;
