import { describe, expect, it } from 'vitest';
import { decodeMediaUrl, encodeMediaUrl, siblingAudioCandidates } from '../src/localMedia';

describe('localMedia URL', () => {
  it('round-trips absolute paths including spaces and non-ASCII', () => {
    for (const p of ['/tmp/a.wav', '/home/u/Записи/встреча 1.wav', 'C:\\Users\\a\\b.mp3']) {
      expect(decodeMediaUrl(encodeMediaUrl(p))).toBe(p);
    }
  });
  it('refuses foreign schemes and bad payloads', () => {
    expect(decodeMediaUrl('file:///tmp/a.wav')).toBeNull();
    expect(decodeMediaUrl('chawo-media://other/x')).toBeNull();
    expect(decodeMediaUrl('chawo-media://local/!!!')).toBeNull();
    expect(() => encodeMediaUrl('')).toThrow(/empty/);
  });
  it('lists sibling audio candidates beside a transcript', () => {
    expect(siblingAudioCandidates('/rec/talk.txt')[0]).toBe('/rec/talk.wav');
    expect(siblingAudioCandidates('/rec/talk.srt')).toContain('/rec/talk.mp3');
    expect(siblingAudioCandidates('')).toEqual([]);
  });
});
