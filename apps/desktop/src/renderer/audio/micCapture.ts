// Microphone capture for a take and for the wake word: getUserMedia → 16 kHz AudioContext →
// AudioWorklet (public/mic-processor.js, 16 kHz mono) → chunks handed to the caller.

/** One take's capture: mic stream → 16 kHz AudioContext → worklet → chunks to main. */
export class MicCapture {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private flushed: (() => void) | null = null;

  async start(deviceId: string, onChunk: (c: Float32Array) => void): Promise<void> {
    const ask = (id: string) => navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: id ? { exact: id } : undefined,
        channelCount: 1,
        // Raw input like WPF waveIn: recognition normalizes the level itself.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
    try {
      this.stream = await ask(deviceId);
    } catch (e) {
      // A saved device that is gone: fall back to the default input like Recorder.StartAsync.
      const name = (e as DOMException)?.name;
      if (!deviceId || (name !== 'OverconstrainedError' && name !== 'NotFoundError' && name !== 'NotReadableError')) throw e;
      this.stream = await ask('');
    }
    try {
      this.ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
    } catch {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
    }
    await this.ctx.audioWorklet.addModule('mic-processor.js');
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'chawo-mic', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    this.node.port.onmessage = (e: MessageEvent) => {
      if (e.data instanceof Float32Array) onChunk(e.data);
      else if (e.data === 'flushed') this.flushed?.();
    };
    source.connect(this.node);
    // The worklet writes nothing to its output, so this only keeps the graph pulling: no sound plays.
    this.node.connect(this.ctx.destination);
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  /** Sends the last partial chunk, then releases the mic (its indicator goes off between takes). */
  async stop(): Promise<void> {
    if (this.node) {
      const done = new Promise<void>((r) => { this.flushed = r; setTimeout(r, 250); });
      this.node.port.postMessage('flush');
      await done;
      this.node.port.onmessage = null;
      this.node.disconnect();
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.ctx && this.ctx.state !== 'closed') await this.ctx.close().catch(() => undefined);
    this.node = null;
    this.stream = null;
    this.ctx = null;
  }
}
