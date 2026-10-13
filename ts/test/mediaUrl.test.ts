import { describe, expect, it } from 'vitest';
import { FILE_TAG, PROGRESS_TAG, downloadsFolder, isLinkInput, parseMediaUrl, parseYtDlpLine, shaFromSums, ytDlpArgs, ytDlpAsset, ytDlpError } from '../src/core/mediaUrl';

describe('parseMediaUrl', () => {
  it.each([
    ['https://www.youtube.com/watch?v=jNQXAC9IVRw', 'https://www.youtube.com/watch?v=jNQXAC9IVRw'],
    ['  http://example.com/a.mp3  ', 'http://example.com/a.mp3'],
    ['youtube.com/watch?v=abc', 'https://youtube.com/watch?v=abc'],
    ['youtu.be/abc', 'https://youtu.be/abc'],
    ['<https://vk.com/video1_2>', 'https://vk.com/video1_2'],
    ['https://ru.wikipedia.org/wiki/Москва', 'https://ru.wikipedia.org/wiki/%D0%9C%D0%BE%D1%81%D0%BA%D0%B2%D0%B0'],
  ])('accepts %s', (input, url) => {
    expect(parseMediaUrl(input)).toEqual({ ok: true, url });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['file:///etc/passwd', 'scheme'],
    ['javascript:alert(1)', 'scheme'],
    ['ftp://example.com/a.mp3', 'scheme'],
    ['data:audio/wav;base64,AAAA', 'scheme'],
    ['просто текст', 'invalid'],
    ['-o /tmp/x', 'invalid'],
    ['https://' + 'a'.repeat(2100) + '.com', 'long'],
  ])('refuses %s', (input, reason) => {
    expect(parseMediaUrl(input)).toEqual({ ok: false, reason });
  });
});

describe('ytDlpArgs', () => {
  it('keeps the URL after -- and adds optional tools', () => {
    const a = ytDlpArgs({ url: 'https://x.test/v', outDir: '/out', ffmpeg: '/bin/ffmpeg', jsRuntime: '/opt/electron' });
    expect(a.slice(-2)).toEqual(['--', 'https://x.test/v']);
    expect(a).toContain('--ignore-config');
    expect(a).toContain('--no-playlist');
    expect(a[a.indexOf('-P') + 1]).toBe('/out');
    expect(a[a.indexOf('--ffmpeg-location') + 1]).toBe('/bin/ffmpeg');
    expect(a[a.indexOf('--js-runtimes') + 1]).toBe('node:/opt/electron');
    expect(a.some((x) => x.includes('cookies'))).toBe(false);
  });
  it('omits ffmpeg and the runtime when absent', () => {
    const a = ytDlpArgs({ url: 'https://x.test/v', outDir: '/out' });
    expect(a).not.toContain('--ffmpeg-location');
    expect(a).not.toContain('--js-runtimes');
  });
});

describe('parseYtDlpLine', () => {
  it('reads progress, the saved file and ignores the rest', () => {
    expect(parseYtDlpLine(PROGRESS_TAG + '  42.0%')).toEqual({ kind: 'progress', percent: 42 });
    expect(parseYtDlpLine(PROGRESS_TAG + '100.0%\r')).toEqual({ kind: 'progress', percent: 100 });
    expect(parseYtDlpLine(PROGRESS_TAG + 'N/A')).toBeNull();
    expect(parseYtDlpLine(FILE_TAG + '/tmp/Встреча [abc].m4a')).toEqual({ kind: 'file', path: '/tmp/Встреча [abc].m4a' });
    expect(parseYtDlpLine('[youtube] Extracting URL')).toBeNull();
    expect(parseYtDlpLine(FILE_TAG)).toBeNull();
  });
});

describe('ytDlpAsset / shaFromSums / ytDlpError', () => {
  it('maps OS and arch to the release asset', () => {
    expect(ytDlpAsset('win32', 'x64')).toBe('yt-dlp.exe');
    expect(ytDlpAsset('linux', 'x64')).toBe('yt-dlp_linux');
    expect(ytDlpAsset('linux', 'arm64')).toBe('yt-dlp_linux_aarch64');
    expect(ytDlpAsset('darwin', 'arm64')).toBe('yt-dlp_macos');
    expect(ytDlpAsset('linux', 'ia32')).toBeNull();
    expect(ytDlpAsset('freebsd', 'x64')).toBeNull();
  });
  it('finds the exact name in SHA2-256SUMS', () => {
    const a = 'a'.repeat(64);
    const b = 'B'.repeat(64);
    const sums = `${a}  yt-dlp\n${b}  yt-dlp_linux\n${'c'.repeat(64)}  yt-dlp_linux.zip\n`;
    expect(shaFromSums(sums, 'yt-dlp_linux')).toBe('b'.repeat(64));
    expect(shaFromSums(sums, 'yt-dlp')).toBe(a);
    expect(shaFromSums(sums, 'yt-dlp.exe')).toBeNull();
  });
  it('picks the last ERROR line', () => {
    expect(ytDlpError('WARNING: x\nERROR: [youtube] abc: Video unavailable\n')).toBe('[youtube] abc: Video unavailable');
    expect(ytDlpError('something odd\n')).toBe('something odd');
    expect(ytDlpError('')).toBe('');
  });
});

describe('isLinkInput (CLI)', () => {
  it('only an explicit http(s):// prefix is a link', () => {
    expect(isLinkInput('https://youtu.be/x')).toBe(true);
    expect(isLinkInput('HTTP://a.test')).toBe(true);
    expect(isLinkInput('<https://a.test>')).toBe(true);
    expect(isLinkInput('youtube.com.mp3')).toBe(false);
    expect(isLinkInput('youtube.com/watch?v=1')).toBe(false);
    expect(isLinkInput('file:///etc/passwd')).toBe(false);
    expect(isLinkInput('/home/u/https://x')).toBe(false);
    expect(isLinkInput('C:\\rec.wav')).toBe(false);
  });
});

describe('downloadsFolder (CLI, no Electron)', () => {
  const j = (...p: string[]) => p.join('/');
  it('Linux: XDG_DOWNLOAD_DIR from user-dirs.dirs, $HOME expanded; else ~/Downloads', () => {
    const dirs = '# comment\nXDG_DESKTOP_DIR="$HOME/Desktop"\nXDG_DOWNLOAD_DIR="$HOME/Загрузки"\n';
    expect(downloadsFolder('linux', '/home/u', dirs, j)).toBe('/home/u/Загрузки');
    expect(downloadsFolder('linux', '/home/u', 'XDG_DOWNLOAD_DIR="/data/dl/"', j)).toBe('/data/dl');
    expect(downloadsFolder('linux', '/home/u', 'XDG_DOWNLOAD_DIR="$HOME/"', j)).toBe('/home/u/Downloads');
    expect(downloadsFolder('linux', '/home/u', 'XDG_DOWNLOAD_DIR="rel"', j)).toBe('/home/u/Downloads');
    expect(downloadsFolder('linux', '/home/u', null, j)).toBe('/home/u/Downloads');
  });
  it('Windows and macOS: <home>/Downloads (user-dirs ignored)', () => {
    expect(downloadsFolder('win32', 'C:/Users/u', 'XDG_DOWNLOAD_DIR="/x"', j)).toBe('C:/Users/u/Downloads');
    expect(downloadsFolder('darwin', '/Users/u', null, j)).toBe('/Users/u/Downloads');
  });
});
