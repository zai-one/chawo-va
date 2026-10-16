// Privileged local-audio URLs for the sandboxed renderer. CSP forbids arbitrary file:// media;
// main registers `chawo-media` and only serves paths that were explicitly allow-listed (queue audio).

export const MEDIA_SCHEME = 'chawo-media';

/** Encode an absolute filesystem path into a chawo-media:// URL the <audio> element can load. */
export function encodeMediaUrl(absolutePath: string): string {
  const p = (absolutePath ?? '').trim();
  if (!p) throw new Error('empty path');
  const b64 = Buffer.from(p, 'utf8').toString('base64url');
  return `${MEDIA_SCHEME}://local/${b64}`;
}

/** Absolute path from a chawo-media URL, or null when the URL is not ours / is malformed. */
export function decodeMediaUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${MEDIA_SCHEME}:`) return null;
  if (u.hostname !== 'local') return null;
  const b64 = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!b64) return null;
  try {
    const path = Buffer.from(b64, 'base64url').toString('utf8');
    return path.length > 0 ? path : null;
  } catch {
    return null;
  }
}

/** Common audio extensions written next to a finished .txt (queue item path is preferred when known). */
export const SIBLING_AUDIO_EXTS = ['.wav', '.mp3', '.m4a', '.ogg', '.opus', '.flac', '.webm', '.aac', '.wma', '.mp4', '.mkv'] as const;

export function siblingAudioCandidates(transcriptPath: string): string[] {
  const p = (transcriptPath ?? '').trim();
  if (!p) return [];
  const base = p.replace(/\.[^./\\]+$/, '');
  return SIBLING_AUDIO_EXTS.map((ext) => base + ext);
}
