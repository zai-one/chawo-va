// The main window's typed view of the preload bridge (window.chawo, contract in @chawo/ipc).
import type { ChawoApi } from '@chawo/ipc/contract';

export const chawo = (window as unknown as { chawo: ChawoApi }).chawo;

export const invoke: ChawoApi['invoke'] = (channel, ...args) => chawo.invoke(channel, ...args);
export const send: ChawoApi['send'] = (channel, ...args) => chawo.send(channel, ...args);
export const on: ChawoApi['on'] = (channel, listener) => chawo.on(channel, listener);
