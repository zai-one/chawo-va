// AudioWorklet for «Запись встречи». Two inputs: 0 = microphone, 1 = computer sound (may be
// unconnected). Each is mixed to mono, brought to 16 kHz like mic-processor.js (ratio 1 when the
// page got a 16 kHz context, else a box-filter decimator) and posted as interleaved stereo
// Float32Array chunks [mic, computer, …] of 4000 frames (250 ms). An input with no channels is
// silence, so the file stays two-channel and in sync. Plain JS: worklets load as module scripts.

const TARGET_RATE = 16000;
const FRAMES = 4000;

function mono(input, i) {
  if (!input || input.length === 0) return 0;
  let v = 0;
  for (let c = 0; c < input.length; c++) v += input[c][i];
  return v / input.length;
}

class MeetingProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.out = new Float32Array(FRAMES * 2);
    this.n = 0;
    this.accM = 0;
    this.accS = 0;
    this.cnt = 0;
    this.t = 0;
    this.next = this.ratio;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') {
        this.post();
        this.port.postMessage('flushed');
      }
    };
  }

  emit(m, s) {
    this.out[this.n * 2] = m;
    this.out[this.n * 2 + 1] = s;
    this.n++;
    if (this.n === FRAMES) this.post();
  }

  post() {
    if (this.n === 0) return;
    const chunk = this.out.slice(0, this.n * 2);
    this.n = 0;
    this.port.postMessage(chunk, [chunk.buffer]);
  }

  process(inputs) {
    const mic = inputs[0];
    const sys = inputs[1];
    const frames = (mic && mic[0] ? mic[0].length : 0) || (sys && sys[0] ? sys[0].length : 0);
    for (let i = 0; i < frames; i++) {
      const m = mono(mic, i);
      const s = mono(sys, i);
      if (this.ratio === 1) {
        this.emit(m, s);
        continue;
      }
      this.accM += m;
      this.accS += s;
      this.cnt++;
      this.t++;
      while (this.t >= this.next) {
        this.emit(this.cnt > 0 ? this.accM / this.cnt : m, this.cnt > 0 ? this.accS / this.cnt : s);
        this.accM = 0;
        this.accS = 0;
        this.cnt = 0;
        this.next += this.ratio;
      }
    }
    return true;
  }
}

registerProcessor('chawo-meeting', MeetingProcessor);
