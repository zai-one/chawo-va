// Where the «computer sound» of a meeting comes from on each OS: Chromium's system-audio loopback
// through getDisplayMedia. Main answers that request with the first screen + `audio: 'loopback'`
// (WASAPI loopback on Windows, the default output's monitor on Linux PulseAudio/PipeWire) and the
// page drops the video track at once. Chromium hides monitor sources from getUserMedia on Linux,
// so loopback is the only way there too. macOS: not yet (needs ScreenCaptureKit flags and a Mac to
// test), so meetings record the microphone only there.

export type SystemAudioMode = 'loopback' | 'none';

export function systemAudioMode(platform: NodeJS.Platform = process.platform): SystemAudioMode {
  return platform === 'win32' || platform === 'linux' ? 'loopback' : 'none';
}
