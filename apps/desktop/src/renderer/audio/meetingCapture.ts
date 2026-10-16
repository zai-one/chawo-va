// «Запись встречи»: mic + computer sound → meeting worklet (public/meeting-processor.js) → main.
import type { MeetingStartResult } from '@chawo/ipc/contract';
import { L } from '../app/i18n';
import { invoke, send } from '../bridge';

type SystemPlan = MeetingStartResult['system'];

/** Mic + computer sound → meeting worklet (16 kHz, interleaved stereo) → main writes the WAV. */
export class MeetingCapture {
  private streams: MediaStream[] = [];
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private flushed: (() => void) | null = null;
  /** Peaks of the last chunk: [mic, computer]. */
  levels: [number, number] = [0, 0];

  private static async mic(id: string): Promise<MediaStream> {
    const ask = (d: string) => navigator.mediaDevices.getUserMedia({
      audio: { deviceId: d ? { exact: d } : undefined, channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
    try {
      return await ask(id);
    } catch (e) {
      const name = (e as DOMException)?.name;
      if (!id || (name !== 'OverconstrainedError' && name !== 'NotFoundError' && name !== 'NotReadableError')) throw e;
      return ask('');
    }
  }

  /** Opens the computer sound; null (and the reason to main) when it cannot be had. */
  private static async system(plan: SystemPlan): Promise<MediaStream | null> {
    if (plan.kind === 'none') return null;
    try {
      // Raw like the mic: Chromium's AGC would otherwise turn the output monitor's volume down (seen on Linux).
      const st = await navigator.mediaDevices.getDisplayMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: true,
      });
      // Only the sound is wanted: the screen track is stopped before any frame is used.
      for (const v of st.getVideoTracks()) { v.stop(); st.removeTrack(v); }
      if (st.getAudioTracks().length === 0) {
        await invoke('meeting:systemOpened', false, L('нет звуковой дорожки', 'no audio track'));
        return null;
      }
      await invoke('meeting:systemOpened', true, '');
      return st;
    } catch (e) {
      await invoke('meeting:systemOpened', false, (e as DOMException)?.name ?? String(e));
      return null;
    }
  }

  async start(micId: string, plan: SystemPlan): Promise<void> {
    const mic = await MeetingCapture.mic(micId);
    this.streams.push(mic);
    const sys = await MeetingCapture.system(plan);
    if (sys) this.streams.push(sys);
    try {
      this.ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'playback' });
    } catch {
      this.ctx = new AudioContext({ latencyHint: 'playback' });
    }
    await this.ctx.audioWorklet.addModule('meeting-processor.js');
    this.node = new AudioWorkletNode(this.ctx, 'chawo-meeting', { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1] });
    this.node.port.onmessage = (e: MessageEvent) => {
      if (e.data instanceof Float32Array) {
        const c = e.data;
        let a = 0;
        let b = 0;
        for (let k = 0; k + 1 < c.length; k += 2) {
          const x = Math.abs(c[k]);
          const y = Math.abs(c[k + 1]);
          if (x > a) a = x;
          if (y > b) b = y;
        }
        this.levels = [a, b];
        send('meeting:pcm', c);
      } else if (e.data === 'flushed') this.flushed?.();
    };
    this.ctx.createMediaStreamSource(mic).connect(this.node, 0, 0);
    if (sys) this.ctx.createMediaStreamSource(sys).connect(this.node, 0, 1);
    // The worklet outputs silence; the connection only keeps the graph running.
    this.node.connect(this.ctx.destination);
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  async stop(): Promise<void> {
    if (this.node) {
      const done = new Promise<void>((r) => { this.flushed = r; setTimeout(r, 500); });
      this.node.port.postMessage('flush');
      await done;
      this.node.port.onmessage = null;
      this.node.disconnect();
    }
    for (const st of this.streams) st.getTracks().forEach((t) => t.stop());
    if (this.ctx && this.ctx.state !== 'closed') await this.ctx.close().catch(() => undefined);
    this.node = null;
    this.ctx = null;
    this.streams = [];
  }
}
