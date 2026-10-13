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
  meeting: {
    state: () => ipcRenderer.invoke('meeting:state'),
    start: () => ipcRenderer.invoke('meeting:start'),
    systemOpened: (ok: boolean, reason?: string) => ipcRenderer.invoke('meeting:systemOpened', ok, reason ?? ''),
    pcm: (chunk: Float32Array) => ipcRenderer.send('meeting:pcm', chunk),
    stop: () => ipcRenderer.invoke('meeting:stop'),
    cancel: () => ipcRenderer.invoke('meeting:cancel'),
    failed: (reason: string) => ipcRenderer.invoke('meeting:failed', reason),
    setSystem: (on: boolean) => ipcRenderer.invoke('meeting:system', on),
    onState: (fn: (s: unknown) => void) => {
      const h = (_e: unknown, s: unknown) => fn(s);
      ipcRenderer.on('meeting:state', h);
      return () => ipcRenderer.removeListener('meeting:state', h);
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
  dictation: {
    state: () => ipcRenderer.invoke('dictation:state'),
    setMode: (v: string) => ipcRenderer.invoke('dictation:mode', v),
    setHotkey: (vk: number) => ipcRenderer.invoke('dictation:hotkey', vk),
    setInsertMode: (v: string) => ipcRenderer.invoke('dictation:insert', v),
    setOverlay: (v: boolean) => ipcRenderer.invoke('dictation:overlay', v),
    setMic: (id: string) => ipcRenderer.invoke('dictation:mic', id),
    setDevices: (list: { id: string; label: string }[], defaultName: string) => ipcRenderer.invoke('dictation:devices', list, defaultName),
    dismissStartCard: () => ipcRenderer.invoke('dictation:dismissStart'),
    startTake: () => ipcRenderer.invoke('dictation:start'),
    /** 16 kHz mono float chunk from the capture worklet; fire-and-forget, ordered before stopTake. */
    appendPcm: (chunk: Float32Array) => ipcRenderer.send('dictation:pcm', chunk),
    stopTake: () => ipcRenderer.invoke('dictation:stop'),
    cancelTake: () => ipcRenderer.invoke('dictation:cancel'),
    micFailed: (name: string, message: string) => ipcRenderer.invoke('dictation:micFailed', name, message),
    onState: (fn: (s: unknown) => void) => {
      const h = (_e: unknown, s: unknown) => fn(s);
      ipcRenderer.on('dictation:state', h);
      return () => ipcRenderer.removeListener('dictation:state', h);
    },
    onLevel: (fn: (v: number) => void) => {
      const h = (_e: unknown, v: number) => fn(v);
      ipcRenderer.on('dictation:level', h);
      return () => ipcRenderer.removeListener('dictation:level', h);
    },
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
    download: (kind: string) => ipcRenderer.invoke('brain:download', kind),
    cancelDownload: () => ipcRenderer.invoke('brain:cancelDownload'),
    dismissDownload: () => ipcRenderer.invoke('brain:dismissDownload'),
    close: () => ipcRenderer.invoke('brain:close'),
    onState: (fn: (s: unknown) => void) => {
      const h = (_e: unknown, s: unknown) => fn(s);
      ipcRenderer.on('brain:state', h);
      return () => ipcRenderer.removeListener('brain:state', h);
    },
  },
  network: {
    state: () => ipcRenderer.invoke('network:state'),
    setRole: (v: string) => ipcRenderer.invoke('network:role', v),
    setRemote: (host: string, port: string) => ipcRenderer.invoke('network:remote', host, port),
    checkHost: () => ipcRenderer.invoke('network:check'),
    toggleLan: () => ipcRenderer.invoke('network:lan'),
    setKeepAwake: (v: boolean) => ipcRenderer.invoke('network:keepAwake', v),
    onState: (fn: (s: unknown) => void) => {
      const h = (_e: unknown, s: unknown) => fn(s);
      ipcRenderer.on('network:state', h);
      return () => ipcRenderer.removeListener('network:state', h);
    },
  },
};

contextBridge.exposeInMainWorld('chawo', api);
export type ChawoApi = typeof api;
