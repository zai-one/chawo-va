// Sound cues: tones come from main (core/cues.ts) and are synthesised here — no audio files, no network.
import type { CueEventDto } from '@chawo/ipc/contract';

let cueCtx: AudioContext | null = null;
let cuesPlayed = 0;
export function playCue(cue: CueEventDto): void {
  if (!cue || !Array.isArray(cue.tones)) return;
  try {
    cueCtx ??= new AudioContext();
    if (cueCtx.state === 'suspended') void cueCtx.resume();
    const t0 = cueCtx.currentTime + 0.01;
    for (const tone of cue.tones.slice(0, 8)) {
      const freq = Math.min(4000, Math.max(80, Number(tone.freq) || 0));
      const at = Math.min(1000, Math.max(0, Number(tone.at) || 0)) / 1000;
      const len = Math.min(500, Math.max(10, Number(tone.ms) || 0)) / 1000;
      const peak = Math.min(0.1, Math.max(0, Number(tone.gain) || 0));
      const osc = cueCtx.createOscillator();
      const gain = cueCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      // 8 ms fade in and out: no clicks.
      const fade = Math.min(0.008, len / 3);
      gain.gain.setValueAtTime(0, t0 + at);
      gain.gain.linearRampToValueAtTime(peak, t0 + at + fade);
      gain.gain.setValueAtTime(peak, t0 + at + len - fade);
      gain.gain.linearRampToValueAtTime(0, t0 + at + len);
      osc.connect(gain).connect(cueCtx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + len + 0.02);
    }
    cuesPlayed++;
    document.documentElement.dataset.cues = `${cuesPlayed}:${cue.kind}:${cueCtx.state}`;
  } catch {
    /* no audio output: the cue is a nicety, the take goes on */
  }
}
