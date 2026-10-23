// The whole window ↔ main process contract in one place. Each channel is written down once here:
//   InvokeMap  window asks, main answers (ipcRenderer.invoke / ipcMain.handle)
//   SendMap    window streams to main, no answer (ipcRenderer.send / ipcMain.on) — audio chunks
//   EventMap   main pushes to the window (webContents.send / ipcRenderer.on)
// The preload exposes only these channels (the runtime lists below), main registers handlers through
// a typed helper, and the window gets typed results. Arguments are typed for the caller; main still
// treats them as untrusted input and checks each one.

import type { CrmTarget } from '@chawo/core/crm';
import type { BrainStateDto } from '@chawo/engine/brain/brainPage';
import type { CleanupStateDto } from '@chawo/engine/cleanup/cleanupPage';
import type { CrmStateDto } from '@chawo/engine/crm/crmPage';
import type { DictationStateDto } from '@chawo/engine/dictation/dictationPage';
import type { DictionaryStateDto } from '@chawo/engine/dictionary/dictionaryPage';
import type { AskStateDto } from '@chawo/engine/history/askPage';
import type { HistoryStateDto } from '@chawo/engine/history/historyPage';
import type { MeetingStateDto, StartResult as MeetingStartResult } from '@chawo/engine/meeting/meetingController';
import type { MeetingDetectResult } from '@chawo/engine/meeting/meetingDetect';
import type { NetworkStateDto } from '@chawo/engine/network/networkPage';
import type { OverlayState } from '@chawo/engine/overlay/overlayModel';
import type { SalesCardState } from '@chawo/engine/sales/salesCard';
import type { PlayerState } from '@chawo/engine/tts/playerModel';
import type { SalesStateDto } from '@chawo/engine/sales/salesPage';
import type { SpeechStateDto } from '@chawo/engine/speech/speechPage';
import type { VoiceStateDto } from '@chawo/engine/tts/voicePage';
import type { CueEventDto, FileStateDto, HotEventDto, McpStateDto, WakeWantDto } from './dto';

export type * from './dto';
export type {
  AskStateDto,
  BrainStateDto,
  CleanupStateDto,
  CrmStateDto,
  CrmTarget,
  DictationStateDto,
  DictionaryStateDto,
  HistoryStateDto,
  MeetingDetectResult,
  MeetingStartResult,
  MeetingStateDto,
  NetworkStateDto,
  OverlayState,
  SalesCardState,
  SalesStateDto,
  SpeechStateDto,
  PlayerState,
  VoiceStateDto,
};

/** Main window: request → answer. */
export interface InvokeMap {
  'crm:state': () => CrmStateDto;
  'crm:setConfig': (target: CrmTarget, fields: Record<string, unknown>) => CrmStateDto;
  'crm:preview': (path: string, target: CrmTarget, id: string, score: boolean) => CrmStateDto;
  'crm:clearPreview': () => CrmStateDto;
  'crm:send': (force: boolean) => CrmStateDto;

  'file:state': () => FileStateDto;
  'file:pick': (kind: 'files' | 'folder') => FileStateDto;
  /** Absolute paths (drag-and-drop: from chawo.pathForFile); onlyAudio skips other files of a folder. */
  'file:add': (paths: string[], onlyAudio: boolean) => FileStateDto;
  'file:remove': (id: number) => FileStateDto;
  'file:clearFinished': () => FileStateDto;
  'file:run': () => FileStateDto;
  'file:stop': () => FileStateDto;
  'file:reveal': (path?: string) => boolean;
  'file:options': (options: Partial<Record<keyof FileStateDto['options'], unknown>>) => FileStateDto;
  'file:ffmpegDownload': () => FileStateDto;
  'file:url': (url: string) => FileStateDto;
  'file:ytdlpDownload': () => FileStateDto;
  'file:diarizeDownload': () => FileStateDto;
  /** «Отменить» in the ffmpeg / Speakers / link box. */
  'file:cancelDownload': (kind: 'ffmpeg' | 'diarize' | 'ytdlp') => FileStateDto;
  'file:briefInstruction': (text: string) => FileStateDto;
  'file:briefTemplate': (id: string) => FileStateDto;
  'file:saveBriefTemplate': (name: string, instruction: string) => FileStateDto;
  'file:deleteBriefTemplate': (name: string) => FileStateDto;
  'file:runBrief': (path?: string) => FileStateDto;
  'file:scoreChecklist': (id: string) => FileStateDto;
  'file:saveChecklist': (name: string, items: string) => FileStateDto;
  'file:deleteChecklist': (name: string) => FileStateDto;
  'file:runScore': (path?: string) => FileStateDto;
  'file:callTrackers': (text: string) => FileStateDto;
  'file:translateTarget': (text: string) => FileStateDto;
  'file:runTranslate': (to?: string, path?: string) => FileStateDto;
  'file:openEditor': (path?: string) => FileStateDto;
  'file:editPhrase': (index: number, text: string) => FileStateDto;
  'file:mediaUrl': (audioPath: string) => string | null;

  'meeting:state': () => MeetingStateDto;
  'meeting:start': () => MeetingStartResult;
  'meeting:systemOpened': (ok: boolean, reason: string) => MeetingStateDto;
  'meeting:stop': () => MeetingStateDto;
  'meeting:cancel': () => MeetingStateDto;
  'meeting:failed': (reason: string) => MeetingStateDto;
  'meeting:system': (on: boolean) => MeetingStateDto;
  'meeting:autoDetect': (on: boolean) => MeetingStateDto;
  'meeting:autoDetectApps': (on: boolean) => MeetingStateDto;
  'meeting:autoDetectCalendar': (path: string) => MeetingStateDto;
  'meeting:pickCalendar': () => MeetingStateDto;
  'meeting:offerSnooze': () => MeetingStateDto;
  'meeting:offerNever': () => MeetingStateDto;
  'meeting:detectNow': () => MeetingDetectResult;

  'speech:state': () => SpeechStateDto;
  'speech:select': (kind: string) => SpeechStateDto;
  'speech:device': (device: 'Gpu' | 'Cpu') => SpeechStateDto;
  'speech:threads': (n: number) => SpeechStateDto;
  'speech:idle': (minutes: number) => SpeechStateDto;
  'speech:download': (kind: string) => SpeechStateDto;
  'speech:cancel': () => SpeechStateDto;
  'speech:dismiss': () => SpeechStateDto;
  'speech:delete': (kind: string) => SpeechStateDto;
  'speech:vad': (on: boolean) => SpeechStateDto;
  'speech:vadDownload': () => SpeechStateDto;
  /** «Место на диске»: the last scan (none until «Найти лишнее»), a new scan, removal of ticked ids. */
  'cleanup:state': () => CleanupStateDto;
  'cleanup:scan': () => CleanupStateDto;
  'cleanup:remove': (ids: string[]) => CleanupStateDto;

  'dict:state': () => DictionaryStateDto;
  'dict:setRow': (id: number, from: string, to: string) => DictionaryStateDto;
  'dict:add': () => { id: number; state: DictionaryStateDto };
  'dict:remove': (id: number) => DictionaryStateDto;
  'dict:suggest': () => DictionaryStateDto;
  'dict:addSuggestion': (heard: string, written: string) => DictionaryStateDto;
  'dict:setSpoken': (kind: 'punctuation' | 'numbers', on: boolean) => DictionaryStateDto;
  'dict:setScript': (command: string) => DictionaryStateDto;
  'dict:setScriptFiles': (on: boolean) => DictionaryStateDto;
  'dict:setSnippet': (id: number, trigger: string, text: string) => DictionaryStateDto;
  'dict:addSnippet': () => { id: number; state: DictionaryStateDto };
  'dict:removeSnippet': (id: number) => DictionaryStateDto;
  'dict:testScript': () => DictionaryStateDto;
  'dict:acceptLearned': (from: string, to: string) => DictionaryStateDto;
  'dict:dismissLearned': (from: string, to: string) => DictionaryStateDto;
  'dict:setLearnAuto': (on: boolean) => DictionaryStateDto;

  'sales:state': () => SalesStateDto;
  'sales:setRow': (id: number, code: string, name: string, line: string, similar: string) => SalesStateDto;
  'sales:add': () => { id: number; state: SalesStateDto };
  'sales:remove': (id: number) => SalesStateDto;
  'sales:pickFolder': () => SalesStateDto;
  'sales:clearFolder': () => SalesStateDto;
  'sales:showCall': (extension: string, number: string, manager: string) => SalesStateDto;

  'dictation:state': () => DictationStateDto;
  'dictation:mode': (mode: string) => DictationStateDto;
  'dictation:hotkey': (vk: number) => DictationStateDto;
  'dictation:insert': (mode: string) => DictationStateDto;
  'dictation:overlay': (on: boolean) => DictationStateDto;
  'dictation:cues': (on: boolean) => DictationStateDto;
  'dictation:keepPhrase': (on: boolean) => DictationStateDto;
  'dictation:mic': (id: string) => DictationStateDto;
  'dictation:devices': (list: { id: string; label: string }[], defaultName: string) => DictationStateDto;
  'dictation:dismissStart': () => DictationStateDto;
  'dictation:start': () => { ok: boolean; micId: string; state: DictationStateDto };
  'dictation:stop': () => DictationStateDto;
  'dictation:cancel': () => DictationStateDto;
  'dictation:micFailed': (name: string, message: string) => DictationStateDto;
  'dictation:wake': (on: boolean) => DictationStateDto;
  'dictation:checkUpdates': () => DictationStateDto;
  'wake:want': () => WakeWantDto;
  'wake:micFailed': (name: string, message: string) => DictationStateDto;

  /** rebind: the window was reloaded and needs the provider list again. */
  'brain:state': (rebind: boolean) => BrainStateDto;
  'brain:source': (source: string) => BrainStateDto;
  'brain:everyTake': (on: boolean) => BrainStateDto;
  'brain:instruction': (text: string) => BrainStateDto;
  'brain:style': (style: string) => BrainStateDto;
  'brain:selection': (on: boolean) => BrainStateDto;
  'brain:context': (patch: { clipboard?: boolean; app?: boolean }) => BrainStateDto;
  'brain:device': (device: string) => BrainStateDto;
  'brain:localModel': (kind: string) => BrainStateDto;
  'brain:customUrl': (url: string) => BrainStateDto;
  /** A .gguf from the page's list (models folder or brain folder) becomes the model. */
  'brain:localFile': (path: string) => BrainStateDto;
  /** A native file dialog in main picks any .gguf; the renderer never names an arbitrary path. */
  'brain:pickFile': () => BrainStateDto;
  'brain:pickFolder': () => BrainStateDto;
  'brain:resetFolder': () => BrainStateDto;
  'brain:openFolder': () => boolean;
  'brain:provider': (id: string) => BrainStateDto;
  'brain:key': (key: string) => BrainStateDto;
  'brain:url': (url: string) => BrainStateDto;
  'brain:model': (model: string) => BrainStateDto;
  'brain:refresh': () => BrainStateDto;
  'brain:keysLink': () => boolean;
  'brain:deleteGguf': (path: string) => BrainStateDto;
  'brain:download': (kind: string) => BrainStateDto;
  'brain:cancelDownload': () => BrainStateDto;
  'brain:dismissDownload': () => BrainStateDto;
  'brain:close': () => boolean;
  'brain:addRule': (match: string) => BrainStateDto;
  'brain:updateRule': (index: number, patch: Record<string, string>) => BrainStateDto;
  'brain:removeRule': (index: number) => BrainStateDto;
  'brain:raiseRule': (index: number) => BrainStateDto;

  'ask:state': () => AskStateDto;
  'ask:run': (question: string) => AskStateDto;
  'ask:cancel': () => AskStateDto;
  'ask:history': (on: boolean) => AskStateDto;
  'ask:addFolder': () => AskStateDto;
  'ask:removeFolder': (path: string) => AskStateDto;
  'ask:copy': () => AskStateDto;
  'ask:open': (path: string) => AskStateDto;

  'history:state': () => HistoryStateDto;
  'history:query': (query: string) => HistoryStateDto;
  'history:keep': (keep: string) => HistoryStateDto;
  'history:copy': (id: string, which: 'final' | 'raw') => HistoryStateDto;
  'history:remove': (id: string) => HistoryStateDto;
  'history:clear': () => HistoryStateDto;
  'history:rerun': (id: string) => HistoryStateDto;
  'history:edit': (id: string, text: string) => HistoryStateDto;

  'mcp:state': () => McpStateDto;
  'mcp:enable': (on: boolean) => McpStateDto;
  'mcp:copy': () => McpStateDto;

  'network:state': () => NetworkStateDto;
  'network:role': (role: string) => NetworkStateDto;
  'network:remote': (host: string, port: string) => NetworkStateDto;
  'network:check': () => NetworkStateDto;
  'network:lan': () => NetworkStateDto;
  'network:keepAwake': (on: boolean) => NetworkStateDto;

  'voice:state': () => VoiceStateDto;
  /** '' turns reading aloud off. */
  'voice:provider': (id: string) => VoiceStateDto;
  'voice:url': (url: string) => VoiceStateDto;
  'voice:key': (key: string) => VoiceStateDto;
  'voice:model': (model: string) => VoiceStateDto;
  'voice:voice': (voice: string) => VoiceStateDto;
  'voice:speed': (speed: number) => VoiceStateDto;
  'voice:selection': (on: boolean) => VoiceStateDto;
  'voice:hotkey': (vk: number) => VoiceStateDto;
  'voice:test': () => VoiceStateDto;
  'voice:keysLink': () => boolean;
  /** «Озвучить» at a text in the window: reads it in the player. False when the text is empty. */
  'voice:speak': (text: string) => boolean;
}

/** Main window: audio streamed to main, 16 kHz mono chunks from the AudioWorklets. */
export interface SendMap {
  'dictation:pcm': (chunk: Float32Array) => void;
  'wake:pcm': (chunk: Float32Array) => void;
  'meeting:pcm': (chunk: Float32Array) => void;
}

/** Main → main window. */
export interface EventMap {
  'file:state': FileStateDto;
  'file:toast': string;
  'meeting:state': MeetingStateDto;
  'speech:state': SpeechStateDto;
  'dictation:state': DictationStateDto;
  'dictation:cue': CueEventDto;
  /** Input level 0…1 while a take records. */
  'dictation:level': number;
  'dictation:hot': HotEventDto;
  'wake:listen': WakeWantDto;
  'brain:state': BrainStateDto;
  'ask:state': AskStateDto;
  'history:state': HistoryStateDto;
  'network:state': NetworkStateDto;
  'crm:state': CrmStateDto;
  'voice:state': VoiceStateDto;
  /** Main asks the window to open a page (the player's «Настройки голоса»). */
  'app:page': string;
}

/** What overlayPreload puts on `window.chawoOverlay` in the floating pill. */
export interface OverlayApi {
  onState(listener: (state: OverlayState) => void): void;
  /** Input level 0…1 for the bars. */
  onLevel(listener: (level: number) => void): void;
  /** The pill's measured size, so main can fit the window to it. */
  size(width: number, height: number): void;
}

/** What salesCardPreload puts on `window.chawoSalesCard` in the always-on-top sales card. */
export interface SalesCardApi {
  onState(listener: (state: SalesCardState) => void): void;
  size(width: number, height: number): void;
  /** The × button. */
  dismiss(): void;
}

/** What playerPreload puts on `window.chawoPlayer` in the TTS player. */
export interface PlayerApi {
  onState(listener: (state: PlayerState) => void): void;
  /** The audio to play: bytes and their media type (played from a Blob, never fetched). */
  onAudio(listener: (audio: Uint8Array, mime: string) => void): void;
  size(width: number, height: number): void;
  /** The speed was changed in the player: remembered as the default. */
  rate(value: number): void;
  close(): void;
  /** «Настройки голоса»: opens the «Голос» page in the main window. */
  settings(): void;
}

/** What pillPreload puts on `window.chawoPill`: the «Озвучить» button next to a selection. */
export interface PillApi {
  onState(listener: (state: { label: string }) => void): void;
  size(width: number, height: number): void;
  speak(): void;
  /** The pointer left the button: main may hide it. */
  leave(): void;
}

export type InvokeChannel = keyof InvokeMap;
export type SendChannel = keyof SendMap;
export type EventChannel = keyof EventMap;
export type InvokeArgs<C extends InvokeChannel> = Parameters<InvokeMap[C]>;
export type InvokeResult<C extends InvokeChannel> = ReturnType<InvokeMap[C]>;

/** What the preload puts on `window.chawo` in the main window. */
export interface ChawoApi {
  invoke<C extends InvokeChannel>(channel: C, ...args: InvokeArgs<C>): Promise<InvokeResult<C>>;
  send<C extends SendChannel>(channel: C, ...args: Parameters<SendMap[C]>): void;
  /** Subscribes to a push; returns the unsubscribe function. */
  on<C extends EventChannel>(channel: C, listener: (payload: EventMap[C]) => void): () => void;
  /** Absolute path of a dropped file (File.path is gone in modern Electron). '' when it has none. */
  pathForFile(file: File): string;
  versions: { app: string; electron: string };
}

// Runtime allowlists: the preload refuses any other channel. `satisfies` keeps them equal to the maps.
const keys = <M>(o: Record<keyof M, true>): (keyof M)[] => Object.keys(o) as (keyof M)[];

export const INVOKE_CHANNELS: readonly InvokeChannel[] = keys<InvokeMap>({
  'crm:state': true, 'crm:setConfig': true, 'crm:preview': true, 'crm:clearPreview': true, 'crm:send': true,
  'file:state': true, 'file:pick': true, 'file:add': true, 'file:remove': true, 'file:clearFinished': true, 'file:run': true,
  'file:stop': true, 'file:reveal': true, 'file:options': true, 'file:ffmpegDownload': true, 'file:url': true,
  'file:ytdlpDownload': true, 'file:diarizeDownload': true, 'file:cancelDownload': true, 'file:briefInstruction': true, 'file:briefTemplate': true,
  'file:saveBriefTemplate': true, 'file:deleteBriefTemplate': true, 'file:runBrief': true, 'file:scoreChecklist': true,
  'file:saveChecklist': true, 'file:deleteChecklist': true, 'file:runScore': true, 'file:callTrackers': true,
  'file:translateTarget': true, 'file:runTranslate': true, 'file:openEditor': true, 'file:editPhrase': true, 'file:mediaUrl': true,
  'meeting:state': true, 'meeting:start': true, 'meeting:systemOpened': true, 'meeting:stop': true, 'meeting:cancel': true,
  'meeting:failed': true, 'meeting:system': true, 'meeting:autoDetect': true, 'meeting:autoDetectApps': true,
  'meeting:autoDetectCalendar': true, 'meeting:pickCalendar': true, 'meeting:offerSnooze': true, 'meeting:offerNever': true,
  'meeting:detectNow': true,
  'speech:state': true, 'speech:select': true, 'speech:device': true, 'speech:threads': true, 'speech:idle': true,
  'speech:download': true, 'speech:cancel': true, 'speech:dismiss': true, 'speech:delete': true, 'speech:vad': true,
  'speech:vadDownload': true,
  'cleanup:state': true, 'cleanup:scan': true, 'cleanup:remove': true,
  'dict:state': true, 'dict:setRow': true, 'dict:add': true, 'dict:remove': true, 'dict:suggest': true, 'dict:addSuggestion': true,
  'dict:setSpoken': true, 'dict:setScript': true, 'dict:setScriptFiles': true, 'dict:setSnippet': true, 'dict:addSnippet': true,
  'dict:removeSnippet': true, 'dict:testScript': true, 'dict:acceptLearned': true, 'dict:dismissLearned': true,
  'dict:setLearnAuto': true,
  'sales:state': true, 'sales:setRow': true, 'sales:add': true, 'sales:remove': true, 'sales:pickFolder': true,
  'sales:clearFolder': true, 'sales:showCall': true,
  'dictation:state': true, 'dictation:mode': true, 'dictation:hotkey': true, 'dictation:insert': true, 'dictation:overlay': true,
  'dictation:cues': true, 'dictation:keepPhrase': true, 'dictation:mic': true, 'dictation:devices': true, 'dictation:dismissStart': true, 'dictation:start': true,
  'dictation:stop': true, 'dictation:cancel': true, 'dictation:micFailed': true, 'dictation:wake': true,
  'dictation:checkUpdates': true, 'wake:want': true, 'wake:micFailed': true,
  'brain:state': true, 'brain:source': true, 'brain:everyTake': true, 'brain:instruction': true, 'brain:selection': true,
  'brain:style': true,
  'brain:context': true, 'brain:device': true, 'brain:localModel': true, 'brain:customUrl': true, 'brain:provider': true,
  'brain:localFile': true, 'brain:pickFile': true, 'brain:pickFolder': true, 'brain:resetFolder': true, 'brain:openFolder': true,
  'brain:key': true, 'brain:url': true, 'brain:model': true, 'brain:refresh': true, 'brain:keysLink': true,
  'brain:deleteGguf': true, 'brain:download': true, 'brain:cancelDownload': true, 'brain:dismissDownload': true,
  'brain:close': true, 'brain:addRule': true, 'brain:updateRule': true, 'brain:removeRule': true, 'brain:raiseRule': true,
  'ask:state': true, 'ask:run': true, 'ask:cancel': true, 'ask:history': true, 'ask:addFolder': true, 'ask:removeFolder': true,
  'ask:copy': true, 'ask:open': true,
  'history:state': true, 'history:query': true, 'history:keep': true, 'history:copy': true, 'history:remove': true,
  'history:clear': true, 'history:rerun': true, 'history:edit': true,
  'mcp:state': true, 'mcp:enable': true, 'mcp:copy': true,
  'network:state': true, 'network:role': true, 'network:remote': true, 'network:check': true, 'network:lan': true,
  'network:keepAwake': true,
  'voice:state': true, 'voice:provider': true, 'voice:url': true, 'voice:key': true, 'voice:model': true, 'voice:voice': true,
  'voice:speed': true, 'voice:selection': true, 'voice:hotkey': true, 'voice:test': true, 'voice:keysLink': true,
  'voice:speak': true,
});

export const SEND_CHANNELS: readonly SendChannel[] = keys<SendMap>({ 'dictation:pcm': true, 'wake:pcm': true, 'meeting:pcm': true });

export const EVENT_CHANNELS: readonly EventChannel[] = keys<EventMap>({
  'file:state': true, 'file:toast': true, 'meeting:state': true, 'speech:state': true, 'dictation:state': true,
  'dictation:cue': true, 'dictation:level': true, 'dictation:hot': true, 'wake:listen': true, 'brain:state': true,
  'ask:state': true, 'history:state': true, 'network:state': true, 'crm:state': true, 'voice:state': true, 'app:page': true,
});
