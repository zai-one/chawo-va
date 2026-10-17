// Bridge for the TTS player (player.html): state and audio bytes in; size, speed, close, settings out.
import { contextBridge, ipcRenderer } from 'electron';
import type { PlayerApi, PlayerState } from '@chawo/ipc/contract';

const api: PlayerApi = {
  onState: (listener) => {
    ipcRenderer.on('player:state', (_e, state: PlayerState) => listener(state));
  },
  onAudio: (listener) => {
    ipcRenderer.on('player:audio', (_e, audio: Uint8Array, mime: string) => listener(audio, mime));
  },
  size: (width, height) => ipcRenderer.send('player:size', width, height),
  rate: (value) => ipcRenderer.send('player:rate', value),
  close: () => ipcRenderer.send('player:close'),
  settings: () => ipcRenderer.send('player:settings'),
};

contextBridge.exposeInMainWorld('chawoPlayer', api);
