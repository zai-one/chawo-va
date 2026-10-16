// Pushes from main into the stores, wired once at startup (pages may be closed when they arrive).
import { on } from '../bridge';
import { initDictation } from './dictation';
import { applyMeeting } from './meeting';
import { applyAsk, applyBrain, applyCrm, applyFile, applyHistory, applyNetwork, applySpeech, fileStore } from './state';

export function initEvents(): void {
  on('file:state', applyFile);
  on('file:toast', (msg) => {
    const s = fileStore.get();
    if (s) fileStore.set({ ...s, status: msg });
  });
  on('meeting:state', applyMeeting);
  on('speech:state', applySpeech);
  on('brain:state', applyBrain);
  on('network:state', applyNetwork);
  on('history:state', applyHistory);
  on('ask:state', applyAsk);
  on('crm:state', applyCrm);
  initDictation();
}
