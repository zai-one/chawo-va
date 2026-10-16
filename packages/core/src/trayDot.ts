// A status dot painted onto the tray glyph while a take runs: red = recording, amber = recognizing.
// Works on the raw BGRA bitmap Electron's nativeImage.toBitmap() returns, so no extra icon files are
// needed (the iconset belongs to the WPF app and stays untouched). Pure function, no Electron.

export interface Rgb { r: number; g: number; b: number }

export const DOT_RECORDING: Rgb = { r: 0xef, g: 0x51, b: 0x43 };
export const DOT_RECOGNIZING: Rgb = { r: 0xff, g: 0xb2, b: 0x61 };

/**
 * Copy of `bgra` (width×height, 4 bytes per pixel, BGRA order) with a filled dot in the bottom-right
 * corner and a thin dark ring around it so it reads on light and dark taskbars. Edges are anti-aliased.
 */
export function paintDot(bgra: Uint8Array, width: number, height: number, color: Rgb): Uint8Array {
  if (bgra.length < width * height * 4) throw new Error('bitmap too small');
  const out = new Uint8Array(bgra);
  const size = Math.min(width, height);
  const radius = size * 0.24;
  const ring = Math.max(1, size / 16);
  const cx = width - radius - ring;
  const cy = height - radius - ring;
  const ringColor: Rgb = { r: 0x14, g: 0x16, b: 0x1a };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const outer = clamp01(radius + ring - d + 0.5);
      if (outer <= 0) continue;
      const inner = clamp01(radius - d + 0.5);
      const i = (y * width + x) * 4;
      // ring first (over the glyph), then the dot over the ring
      blend(out, i, ringColor, outer);
      blend(out, i, color, inner);
    }
  }
  return out;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Source-over of an opaque colour with coverage `a` onto a straight-alpha BGRA pixel. */
function blend(px: Uint8Array, i: number, c: Rgb, a: number): void {
  if (a <= 0) return;
  const da = px[i + 3] / 255;
  const oa = a + da * (1 - a);
  const mix = (src: number, dst: number) => Math.round((src * a + dst * da * (1 - a)) / oa);
  px[i] = mix(c.b, px[i]);
  px[i + 1] = mix(c.g, px[i + 1]);
  px[i + 2] = mix(c.r, px[i + 2]);
  px[i + 3] = Math.round(oa * 255);
}
