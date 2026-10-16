// AudioWorklet for dictation capture. Mixes the input to mono, brings it to 16 kHz and posts
// ~40 ms Float32Array chunks (640 samples) to the page, which forwards them to the main process.
// The page asks for a 16 kHz AudioContext first, so Chromium's own resampler does the work and the
// ratio here is 1. If that context is refused, the device rate is used and this box-filter
// decimator averages each output sample's span of input (enough anti-aliasing for speech).
// Plain JS on purpose: worklets load as separate module scripts and there is no bundler.

const TARGET_RATE = 16000;
const CHUNK = 640;

class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is the AudioWorkletGlobalScope rate of the context.
    this.ratio = sampleRate / TARGET_RATE;
    this.out = new Float32Array(CHUNK);
    this.n = 0;
    this.acc = 0;
    this.cnt = 0;
    this.t = 0; // input samples consumed
    this.next = this.ratio; // input position where the next output sample ends
    this.port.onmessage = (e) => {
      if (e.data === 'flush') {
        this.post();
        this.port.postMessage('flushed');
      }
    };
  }

  emit(v) {
    this.out[this.n++] = v;
    if (this.n === CHUNK) this.post();
  }

  post() {
    if (this.n === 0) return;
    const chunk = this.out.slice(0, this.n);
    this.n = 0;
    this.port.postMessage(chunk, [chunk.buffer]);
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channels = input.length;
    const frames = input[0].length;
    for (let i = 0; i < frames; i++) {
      let v = 0;
      for (let c = 0; c < channels; c++) v += input[c][i];
      v /= channels;
      if (this.ratio === 1) {
        this.emit(v);
        continue;
      }
      this.acc += v;
      this.cnt++;
      this.t++;
      // Downsampling emits at most once per input; a sub-16 kHz device repeats the sample (hold).
      while (this.t >= this.next) {
        this.emit(this.cnt > 0 ? this.acc / this.cnt : v);
        this.acc = 0;
        this.cnt = 0;
        this.next += this.ratio;
      }
    }
    return true;
  }
}

registerProcessor('chawo-mic', MicProcessor);
