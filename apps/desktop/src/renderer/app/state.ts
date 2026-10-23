// Page models as main pushes them. Every apply also follows the UI language that came with the state.
import type {
  AskStateDto,
  BrainStateDto,
  CrmStateDto,
  DictationStateDto,
  DictionaryStateDto,
  FileStateDto,
  HistoryStateDto,
  McpStateDto,
  MeetingStateDto,
  NetworkStateDto,
  SalesStateDto,
  SpeechStateDto,
  VoiceStateDto,
} from '@chawo/ipc/contract';
import { lang } from './i18n';
import { createStore, type Store } from './store';

const tracked = <T extends { ru: boolean }>(store: Store<T | null>) => (state: T): void => {
  store.set(state);
  lang.set(state.ru);
};

export const fileStore = createStore<FileStateDto | null>(null);
export const meetingStore = createStore<MeetingStateDto | null>(null);
export const speechStore = createStore<SpeechStateDto | null>(null);
export const dictStore = createStore<DictionaryStateDto | null>(null);
export const brainStore = createStore<BrainStateDto | null>(null);
export const dictationStore = createStore<DictationStateDto | null>(null);
export const networkStore = createStore<NetworkStateDto | null>(null);
export const historyStore = createStore<HistoryStateDto | null>(null);
export const askStore = createStore<AskStateDto | null>(null);
export const salesStore = createStore<SalesStateDto | null>(null);
export const mcpStore = createStore<McpStateDto | null>(null);
export const crmStore = createStore<CrmStateDto | null>(null);
export const voiceStore = createStore<VoiceStateDto | null>(null);

/**
 * A long run pushes the file state several times a second. The phrase list (and its stats) is kept as the
 * same object while main says it did not change, so the page does not rebuild thousands of rows each time.
 */
export const applyFile = (next: FileStateDto): void => {
  const prev = fileStore.get();
  if (prev && next.editor.rev !== undefined && prev.editor.rev === next.editor.rev) {
    const editor = prev.editor.note === next.editor.note ? prev.editor : { ...prev.editor, note: next.editor.note };
    const same = prev.callStats.trackers === next.callStats.trackers && prev.callStats.defaultTrackers === next.callStats.defaultTrackers;
    next = { ...next, editor, callStats: same ? prev.callStats : next.callStats };
  }
  fileStore.set(next);
  lang.set(next.ru);
};
export const applyMeeting = tracked(meetingStore);
export const applySpeech = tracked(speechStore);
export const applyDict = tracked(dictStore);
export const applyBrain = tracked(brainStore);
export const applyDictation = tracked(dictationStore);
export const applyNetwork = tracked(networkStore);
export const applyHistory = tracked(historyStore);
export const applySales = tracked(salesStore);
export const applyVoice = tracked(voiceStore);
export const applyAsk = (s: AskStateDto): void => askStore.set(s);
export const applyMcp = (s: McpStateDto): void => mcpStore.set(s);
export const applyCrm = (s: CrmStateDto): void => crmStore.set(s);
