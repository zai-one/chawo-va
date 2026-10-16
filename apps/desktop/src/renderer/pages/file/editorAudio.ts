// The source audio of «Расшифровка», shared with the tracker phrases of «Статистика разговора».
// One element per mediaUrl, outside React, so the play position survives re-renders and page switches.

let editorAudio: HTMLAudioElement | null = null;
let editorAudioUrl: string | null = null;

export function ensureEditorAudio(mediaUrl: string): HTMLAudioElement {
  if (editorAudio && editorAudioUrl === mediaUrl) return editorAudio;
  const a = document.createElement('audio');
  a.controls = true;
  a.preload = 'metadata';
  a.className = 'transcript-audio';
  a.src = mediaUrl;
  editorAudio = a;
  editorAudioUrl = mediaUrl;
  return a;
}

/** Seek and play; a click on a phrase. */
export function playFrom(audio: HTMLAudioElement, seconds: number): void {
  audio.currentTime = Math.max(0, seconds);
  void audio.play().catch(() => {
    /* autoplay / decode */
  });
}

export function pauseAudio(audio: HTMLAudioElement): void {
  audio.pause();
}

/** timeupdate / play: what the active phrase highlight follows. */
export function subscribeAudio(audio: HTMLAudioElement, cb: () => void): () => void {
  audio.addEventListener('timeupdate', cb);
  audio.addEventListener('play', cb);
  return () => {
    audio.removeEventListener('timeupdate', cb);
    audio.removeEventListener('play', cb);
  };
}

/** Indices of the phrases under the play position, as one comparable string («3» or «3,4»). */
export function activePhrases(audio: HTMLAudioElement, segments: readonly { start: number; end: number }[]): string {
  const t = audio.currentTime;
  const on: number[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const next = segments[i + 1];
    const end = seg.end > seg.start ? seg.end : next ? next.start : seg.start + 0.5;
    if (t >= seg.start && t < end) on.push(i);
  }
  return on.join(',');
}
