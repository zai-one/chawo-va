// Shapes the main process pushes to the window that are not a page model of @chawo/engine. Page models
// (BrainStateDto, HistoryStateDto, …) stay next to their controllers and are re-exported by contract.ts.

import type { CallStats } from '@chawo/core/callStats';
import type { CueKind, CueTone } from '@chawo/core/cues';
import type { ScoreResult } from '@chawo/engine/brain/callScore';
import type { FileItemState } from '@chawo/engine/file/fileQueue';
import type { FileExtraFormat, SettingsFileParallelism } from '@chawo/engine/settings';

export interface FileOptionsDto {
  timestamps: boolean;
  srt: boolean;
  /** vtt / json / md / docx */
  extra: FileExtraFormat[];
  parallelism: SettingsFileParallelism;
  diarize: boolean;
  /** «Кратко и задачи» after transcription (MeetingBriefEnabled). */
  brief: boolean;
  /** «Проверка по чек-листу» after transcription (CallScoreEnabled). */
  score: boolean;
}

export interface FileEditorSegmentDto {
  start: number;
  end: number;
  text: string;
  speaker?: number;
}

export interface FileEditorDto {
  available: boolean;
  reason?: string;
  audioPath: string | null;
  txtPath: string | null;
  segments: FileEditorSegmentDto[];
  mediaUrl: string | null;
  /** Which timed file fed the phrases: srt | json | txt */
  sourceHint?: string;
  /** Result of the last phrase fix («Исправлено…»), empty before one. */
  note?: string;
  /** Changes when the phrases are read again; the same number = the same phrases. */
  rev?: number;
}

export interface FileItemDto {
  id: number;
  path: string;
  state: FileItemState;
  note: string;
  outputPath?: string;
}

export interface FileStateDto {
  items: FileItemDto[];
  status: string;
  /** The file being transcribed: percent of the current step (null = length unknown), when it started. */
  progress: { index: number; total: number; percent: number | null; startedAt: number } | null;
  /** The transcription or a Brain job runs («Остановить»); downloads are not counted here. */
  busy: boolean;
  options: FileOptionsDto;
  ffmpeg: { line: string; canDownload: boolean; installed: boolean; busy: boolean };
  /** «По ссылке»: yt-dlp state, where the audio is saved, whether a link (or yt-dlp itself) is downloading. */
  url: { line: string; canDownload: boolean; installed: boolean; managed: boolean; busy: boolean; downloading: boolean; folder: string };
  diarization: { onDisk: boolean; ready: boolean; downloading: boolean; line: string; canDownload: boolean };
  lastOutput: string | null;
  /** «Кратко и задачи» card on the File page. */
  brief: {
    enabled: boolean;
    instruction: string;
    /** Built-in default shown when the saved instruction is empty. */
    defaultInstruction: string;
    /** Selected template id ('' = own instruction). */
    template: string;
    templates: { id: string; name: string; builtin: boolean; instruction: string }[];
    /** Last save/delete problem, '' when fine. */
    templateNote: string;
    /** Where the Brain would run (empty when unavailable). */
    where: string;
    available: boolean;
    /** Last brief text shown in the card (from auto-run or «Составить»). */
    text: string;
    path: string | null;
    busy: boolean;
  };
  /** «Проверка по чек-листу» card on the File page. */
  score: {
    enabled: boolean;
    /** Selected checklist id (built-in id or custom name). */
    checklist: string;
    checklists: { id: string; name: string; builtin: boolean; items: string[] }[];
    /** Last save/delete problem, '' when fine. */
    note: string;
    where: string;
    available: boolean;
    result: ScoreResult | null;
    path: string | null;
    busy: boolean;
  };
  /** «Перевести» block on the File page (Brain-based, local by default). */
  translate: {
    /** Saved TranslateTarget (code, name or free text); empty = auto. */
    target: string;
    /** Common languages for the picker; free text is allowed too. */
    languages: { code: string; label: string }[];
    where: string;
    available: boolean;
    /** Last translation shown in the card. */
    text: string;
    path: string | null;
    busy: boolean;
  };
  /** UI language picked in main (Auto follows the OS locale), so the page matches status lines. */
  ru: boolean;
  /** Click-a-phrase transcript editor (timed segments + local audio). */
  editor: FileEditorDto;
  /** «Статистика разговора» for the editor's transcript (null = no timed phrases). */
  callStats: { stats: CallStats | null; trackers: string; defaultTrackers: string };
}

/** «MCP-сервер» block on the «Сеть» page. */
export interface McpStateDto {
  enabled: boolean;
  snippet: string;
  copied: boolean;
}

/** Sound cue for the window to play (Web Audio there). */
export interface CueEventDto {
  kind: CueKind;
  tones: CueTone[];
}

/** Global hold key (Windows helper): open the mic, stop and recognize, or drop the capture. */
export type HotEventDto = { kind: 'start'; micId: string } | { kind: 'stop' } | { kind: 'end' };

/** «Чаво»: whether the window should keep a microphone open for the word, and which one. */
export interface WakeWantDto {
  on: boolean;
  micId: string;
}
