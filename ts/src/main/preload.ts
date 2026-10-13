// The only bridge between the sandboxed renderer and the main process. Keep it small and typed.
import { contextBridge } from 'electron';

const api = {
  versions: { app: process.env.npm_package_version ?? '', electron: process.versions.electron },
};

contextBridge.exposeInMainWorld('chawo', api);
export type ChawoApi = typeof api;
