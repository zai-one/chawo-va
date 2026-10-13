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
  speech: {
    state: () => ipcRenderer.invoke('speech:state'),
    select: (kind: string) => ipcRenderer.invoke('speech:select', kind),
    setDevice: (d: 'Gpu' | 'Cpu') => ipcRenderer.invoke('speech:device', d),
    setThreads: (n: number) => ipcRenderer.invoke('speech:threads', n),
    download: (kind: string) => ipcRenderer.invoke('speech:download', kind),
    cancel: () => ipcRenderer.invoke('speech:cancel'),
    dismiss: () => ipcRenderer.invoke('speech:dismiss'),
    remove: (kind: string) => ipcRenderer.invoke('speech:delete', kind),
    onState: (fn: (s: unknown) => void) => {
      const h = (_e: unknown, s: unknown) => fn(s);
      ipcRenderer.on('speech:state', h);
      return () => ipcRenderer.removeListener('speech:state', h);
    },
  },
  dict: {
    state: () => ipcRenderer.invoke('dict:state'),
    setRow: (id: number, from: string, to: string) => ipcRenderer.invoke('dict:setRow', id, from, to),
    add: () => ipcRenderer.invoke('dict:add'),
    remove: (id: number) => ipcRenderer.invoke('dict:remove', id),
    suggest: () => ipcRenderer.invoke('dict:suggest'),
    addSuggestion: (heard: string, written: string) => ipcRenderer.invoke('dict:addSuggestion', heard, written),
  },
  brain: {
    state: (rebind = false) => ipcRenderer.invoke('brain:state', rebind),
    setSource: (v: string) => ipcRenderer.invoke('brain:source', v),
    setEveryTake: (v: boolean) => ipcRenderer.invoke('brain:everyTake', v),
    setInstruction: (v: string) => ipcRenderer.invoke('brain:instruction', v),
    setSelection: (v: boolean) => ipcRenderer.invoke('brain:selection', v),
    setDevice: (v: string) => ipcRenderer.invoke('brain:device', v),
    setLocalModel: (v: string) => ipcRenderer.invoke('brain:localModel', v),
    setCustomUrl: (v: string) => ipcRenderer.invoke('brain:customUrl', v),
    setProvider: (id: string) => ipcRenderer.invoke('brain:provider', id),
    setKey: (key: string) => ipcRenderer.invoke('brain:key', key),
    setUrl: (url: string) => ipcRenderer.invoke('brain:url', url),
    setModel: (model: string) => ipcRenderer.invoke('brain:model', model),
    refresh: () => ipcRenderer.invoke('brain:refresh'),
    openKeysLink: () => ipcRenderer.invoke('brain:keysLink'),
    deleteGguf: (path: string) => ipcRenderer.invoke('brain:deleteGguf', path),
    close: () => ipcRenderer.invoke('brain:close'),
    onState: (fn: (s: unknown) => void) => {
      const h = (_e: unknown, s: unknown) => fn(s);
      ipcRenderer.on('brain:state', h);
      return () => ipcRenderer.removeListener('brain:state', h);
    },
  },
};

contextBridge.exposeInMainWorld('chawo', api);
export type ChawoApi = typeof api;
