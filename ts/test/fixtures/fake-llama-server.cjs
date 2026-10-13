#!/usr/bin/env node
// Poses as llama-server for LocalBrain runtime tests: records its argv, answers /health once listening.
// The model path picks the behaviour: *crash* exits at once, *mute* never listens, *slow* waits 3.2 s.
const http = require('node:http');
const fs = require('node:fs');
const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
const model = arg('-m') || '';
const port = Number(arg('--port'));
const key = arg('--api-key');
if (process.env.FAKE_LLAMA_ARGS) fs.appendFileSync(process.env.FAKE_LLAMA_ARGS, JSON.stringify({ pid: process.pid, args, exe: __filename }) + '\n');
console.log('fake llama-server starting ' + model);
if (model.includes('crash')) {
  console.error('ggml_vulkan: no device');
  process.exit(1);
}
if (model.includes('mute')) {
  setInterval(() => {}, 1000);
} else {
  const delay = model.includes('slow') ? 3200 : 0;
  setTimeout(() => {
    http
      .createServer((req, res) => {
        if (req.url === '/health') return res.end('{"status":"ok"}');
        if (req.headers.authorization !== 'Bearer ' + key) {
          res.statusCode = 401;
          return res.end('{}');
        }
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
      })
      .listen(port, '127.0.0.1');
  }, delay);
}
process.on('SIGTERM', () => process.exit(0));
