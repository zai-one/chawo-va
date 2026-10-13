#!/usr/bin/env node
// Skip-friendly real sherpa-onnx speaker diarization smoke.
// Downloads models + 0-four-speakers-zh.wav on demand into a temp dir (or CHAWO_DIAR_SMOKE_DIR).
// Exit 0 on success / intentional skip; non-zero on hard failure after models are present.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

function log(m) {
  console.log(`[smoke-diarize] ${m}`);
}

let sherpa;
try {
  sherpa = require('sherpa-onnx-node');
} catch (e) {
  log(`skip: sherpa-onnx-node not loadable (${e.message})`);
  process.exit(0);
}

const root =
  process.env.CHAWO_DIAR_SMOKE_DIR ||
  path.join(os.tmpdir(), 'chawo-diarize-smoke');
fs.mkdirSync(root, { recursive: true });

const segDir = path.join(root, 'sherpa-onnx-pyannote-segmentation-3-0');
const segModel = path.join(segDir, 'model.onnx');
const embModel = path.join(root, '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx');
const wav = path.join(root, '0-four-speakers-zh.wav');

const SEG_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2';
const EMB_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx';
const WAV_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/0-four-speakers-zh.wav';

function curl(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
    log(`have ${path.basename(dest)}`);
    return;
  }
  log(`download ${url}`);
  const r = spawnSync('curl', ['-fL', '--retry', '3', '-o', dest, url], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`curl failed for ${url}`);
}

try {
  if (!fs.existsSync(segModel) || fs.statSync(segModel).size < 1_000_000) {
    const arch = path.join(root, 'seg.tar.bz2');
    curl(SEG_URL, arch);
    log('unpack segmentation');
    const py = `
import tarfile, os, sys
root = sys.argv[1]
arch = sys.argv[2]
os.makedirs(root, exist_ok=True)
with tarfile.open(arch, 'r:bz2') as tf:
    tf.extractall(root)
`;
    const script = path.join(root, '_unpack.py');
    fs.writeFileSync(script, py);
    const u = spawnSync('python3', [script, root, arch], { stdio: 'inherit' });
    if (u.status !== 0) throw new Error('unpack failed');
  }
  curl(EMB_URL, embModel);
  curl(WAV_URL, wav);
} catch (e) {
  log(`skip: could not fetch models/wav (${e.message})`);
  process.exit(0);
}

if (!fs.existsSync(segModel) || !fs.existsSync(embModel) || !fs.existsSync(wav)) {
  log('skip: models or wav missing after download');
  process.exit(0);
}

const config = {
  segmentation: { pyannote: { model: segModel } },
  embedding: { model: embModel },
  clustering: { numClusters: -1, threshold: 0.5 },
  minDurationOn: 0.2,
  minDurationOff: 0.5,
};

log('create OfflineSpeakerDiarization');
const sd = new sherpa.OfflineSpeakerDiarization(config);
const wave = sherpa.readWave(wav);
log(`wave rate=${wave.sampleRate} samples=${wave.samples.length} sd.rate=${sd.sampleRate}`);
if (sd.sampleRate !== wave.sampleRate) {
  console.error('sample rate mismatch');
  process.exit(1);
}

const t0 = Date.now();
const segments = sd.process(wave.samples);
const ms = Date.now() - t0;
const speakers = new Set(segments.map((s) => s.speaker));
log(`segments=${segments.length} speakers=${speakers.size} in ${ms}ms`);
for (const s of segments.slice(0, 8)) {
  log(`  spk${s.speaker} ${s.start.toFixed(2)}-${s.end.toFixed(2)}`);
}
if (segments.length === 0) {
  console.error('no diarization segments');
  process.exit(1);
}
if (speakers.size < 2) {
  console.error(`expected ≥2 speakers, got ${speakers.size}`);
  process.exit(1);
}
log('ok');
process.exit(0);
