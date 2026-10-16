#!/usr/bin/env node
// Reads the fuses burnt into a packaged exe and compares them with "build.electronFuses" in
// package.json (electron-builder flips them while packaging). Exit 1 on any difference.
//   node scripts/check-fuses.mjs release/win-unpacked/ChawoVoiceAssistant.exe
import { readFileSync } from 'node:fs';
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';

const exe = process.argv[2];
if (!exe) {
  console.error('usage: check-fuses.mjs <packaged exe>');
  process.exit(2);
}
const want = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).build.electronFuses;
const wire = await getCurrentFuseWire(exe);
let bad = 0;
for (const [key, on] of Object.entries(want)) {
  const name = key[0].toUpperCase() + key.slice(1);
  const index = FuseV1Options[name];
  if (index === undefined) {
    console.error(`unknown fuse in package.json: ${key}`);
    bad++;
    continue;
  }
  const state = wire[index];
  const ok = state === (on ? FuseState.ENABLE : FuseState.DISABLE);
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${state === FuseState.ENABLE ? 'on' : state === FuseState.DISABLE ? 'off' : 'removed'} (want ${on ? 'on' : 'off'})`);
}
process.exit(bad ? 1 : 0);
