#!/usr/bin/env python3
"""Build src/Assets/app.ico: the same mark as tray-dark.ico for the .exe,
every window's title bar and the taskbar button.

Dark tile #171717, cream bars #FFF3E2, 3rd bar coral #EF5143 — identical colours
to tray-dark.ico. A 1 px (2 px at 256) #3A3A3A edge keeps the dark tile readable
on a dark Windows 11 taskbar. No coral tile anywhere.

Windows 11 app icons leave a small margin: the tile fills 87.5–90 % of the frame
(16→14, 20→18, 24→22, 32→28, 40→36, 48→42, 64→56, 256→224). Every size has its own
hand-tuned pixel grid (bar rows/columns snapped to whole pixels), so nothing is a
blurry downscale. 256 follows the brand geometry (7 px per SVG unit).

    python3 tools/make_app_icon.py            # writes app.ico + iconset/app/*.png
    python3 tools/make_app_icon.py --preview /workspace/chawo-icons-1.17.4

Needs Pillow. Entries < 256 are 32-bit DIB (with AND mask), 256 is PNG — the layout
Windows itself uses, and what WPF's IconBitmapDecoder picks frames from.
"""
from __future__ import annotations

import io
import struct
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "src" / "Assets"
# Same palette as tray-dark.ico (sampled from iconset/tray-dark/*.png).
TILE = (0x17, 0x17, 0x17, 255)
CREAM = (0xFF, 0xF3, 0xE2, 255)
CORAL = (0xEF, 0x51, 0x43, 255)
EDGE = (0x3A, 0x3A, 0x3A, 255)
SS = 16  # supersampling; all straight edges sit on whole pixels so only corners get AA

# size: pad, tile corner radius, bar radius, edge width (tile px),
#        rows [(y, h)] x4, cols [(x0, x1)] x4 (tile px, including the edge ring)
# Brand (32-unit SVG): inset 1, bar h 6, gap 2; bar1/4 x 5→31, bar2 1→12, bar3 1→14;
# tile rx 7, bar rx 3. Tray-dark fills the frame; here a pad leaves Win11 margin.
SPECS: dict[int, dict] = {
    16: dict(pad=1, rx=3, br=0, edge=1, rows=[(1, 3), (5, 2), (8, 2), (11, 3)],
             cols=[(2, 13), (1, 6), (1, 7), (2, 13)]),
    20: dict(pad=1, rx=4, br=0, edge=1, rows=[(1, 4), (6, 3), (10, 3), (14, 4)],
             cols=[(3, 17), (1, 7), (1, 8), (3, 17)]),
    24: dict(pad=1, rx=5, br=0, edge=1, rows=[(1, 5), (7, 4), (12, 4), (17, 5)],
             cols=[(3, 21), (1, 8), (1, 10), (3, 21)]),
    32: dict(pad=2, rx=6, br=1, edge=1, rows=[(1, 5), (8, 5), (15, 5), (22, 5)],
             cols=[(4, 27), (1, 10), (1, 12), (4, 27)]),
    40: dict(pad=2, rx=8, br=3, edge=1, rows=[(1, 7), (10, 7), (19, 7), (28, 7)],
             cols=[(6, 35), (1, 14), (1, 16), (6, 35)]),
    48: dict(pad=3, rx=9, br=4, edge=1, rows=[(2, 8), (12, 8), (22, 8), (32, 8)],
             cols=[(7, 41), (1, 16), (1, 18), (7, 41)]),
    64: dict(pad=4, rx=12, br=5, edge=1, rows=[(2, 10), (16, 10), (30, 10), (44, 10)],
             cols=[(9, 54), (2, 21), (2, 25), (9, 54)]),
    256: dict(pad=16, rx=49, br=21, edge=2, rows=[(7, 42), (63, 42), (119, 42), (175, 42)],
              cols=[(35, 217), (7, 84), (7, 98), (35, 217)]),
}
BAR_COLORS = [CREAM, CREAM, CORAL, CREAM]


def render(size: int) -> Image.Image:
    s = SPECS[size]
    t = size - 2 * s["pad"]
    edge = s["edge"]
    for y, h in s["rows"]:
        assert 0 <= y and y + h <= t, (size, y, h)
    for x0, x1 in s["cols"]:
        assert 0 <= x0 < x1 <= t, (size, x0, x1)
    tile = Image.new("RGBA", (t * SS, t * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(tile)
    box = (0, 0, t * SS - 1, t * SS - 1)
    # Outer ring #3A3A3A, then dark fill inset — thin edge so the tile reads on a dark taskbar.
    d.rounded_rectangle(box, radius=s["rx"] * SS, fill=EDGE)
    inset = edge * SS
    inner = (inset, inset, t * SS - 1 - inset, t * SS - 1 - inset)
    inner_rx = max(0, (s["rx"] - edge) * SS)
    d.rounded_rectangle(inner, radius=inner_rx, fill=TILE)
    for (y, h), (x0, x1), c in zip(s["rows"], s["cols"], BAR_COLORS):
        r = min(s["br"] * SS, h * SS // 2)
        d.rounded_rectangle(
            (x0 * SS, y * SS, x1 * SS - 1, (y + h) * SS - 1), radius=r, fill=c
        )
    mask = Image.new("L", tile.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, radius=s["rx"] * SS, fill=255)
    alpha = Image.composite(tile.getchannel("A"), Image.new("L", tile.size, 0), mask)
    tile.putalpha(alpha)
    big = Image.new("RGBA", (size * SS, size * SS), (0, 0, 0, 0))
    big.alpha_composite(tile, (s["pad"] * SS, s["pad"] * SS))
    return big.resize((size, size), Image.BOX)


def dib(img: Image.Image) -> bytes:
    w, h = img.size
    px = img.load()
    header = struct.pack("<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    xor = bytearray()
    for y in range(h - 1, -1, -1):
        for x in range(w):
            r, g, b, a = px[x, y]
            xor += bytes((b, g, r, a))
    stride = ((w + 31) // 32) * 4
    andmask = bytearray()
    for y in range(h - 1, -1, -1):
        row = bytearray(stride)
        for x in range(w):
            if px[x, y][3] == 0:
                row[x // 8] |= 0x80 >> (x % 8)
        andmask += row
    return header + bytes(xor) + bytes(andmask)


def write_ico(images: dict[int, Image.Image], dst: Path) -> None:
    blobs = []
    for size in sorted(images):
        if size >= 256:
            buf = io.BytesIO()
            images[size].save(buf, "PNG", optimize=True)
            blobs.append((size, buf.getvalue()))
        else:
            blobs.append((size, dib(images[size])))
    head = struct.pack("<HHH", 0, 1, len(blobs))
    offset = 6 + 16 * len(blobs)
    entries, data = b"", b""
    for size, blob in blobs:
        dim = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(blob), offset)
        data += blob
        offset += len(blob)
    dst.write_bytes(head + entries + data)


def preview(images: dict[int, Image.Image], prefix: str) -> list[str]:
    out = []
    bgs = [("dark", (0x1C, 0x1C, 0x1C, 255)), ("light", (0xF3, 0xF3, 0xF3, 255))]
    for size, scale in ((16, 8), (32, 8), (48, 4), (256, 1)):
        side = size * scale
        sheet = Image.new("RGBA", (side * 2 + 48, side + 32), (0x0A, 0x0A, 0x0A, 255))
        for i, (_, bg) in enumerate(bgs):
            tile = Image.new("RGBA", (size, size), bg)
            tile.alpha_composite(images[size])
            sheet.paste(tile.resize((side, side), Image.NEAREST), (16 + i * (side + 16), 16))
        path = f"{prefix}-{size}{'-x%d' % scale if scale > 1 else ''}.png"
        sheet.save(path)
        out.append(path)
    # Taskbar mock: every size at 1:1 on dark and light bars.
    sizes = sorted(images)
    w = sum(sizes) + 16 * (len(sizes) + 1)
    sheet = Image.new("RGBA", (w, 2 * (256 + 32)), (0, 0, 0, 255))
    for row, (_, bg) in enumerate(bgs):
        band = Image.new("RGBA", (w, 256 + 32), bg)
        x = 16
        for s in sizes:
            band.alpha_composite(images[s], (x, 16 + (256 - s) // 2))
            x += s + 16
        sheet.paste(band, (0, row * (256 + 32)))
    path = f"{prefix}-all-1x.png"
    sheet.save(path)
    out.append(path)
    return out


def main() -> int:
    images = {s: render(s) for s in SPECS}
    setdir = ASSETS / "iconset" / "app"
    setdir.mkdir(parents=True, exist_ok=True)
    for s, im in images.items():
        im.save(setdir / f"icon_{s}.png")
    write_ico(images, ASSETS / "app.ico")
    print(f"{ASSETS / 'app.ico'}: sizes {sorted(images)}, {(ASSETS / 'app.ico').stat().st_size} bytes")
    if "--preview" in sys.argv:
        prefix = sys.argv[sys.argv.index("--preview") + 1]
        for p in preview(images, prefix):
            print(p)
    return 0


if __name__ == "__main__":
    sys.exit(main())
