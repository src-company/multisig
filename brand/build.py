#!/usr/bin/env python3
"""Regenerate every file in brand/logo/.

The kit is built, not drawn by hand, so the mark and the wordmark can never
drift apart — and so every asset here is *font-free*. The frame's slashes and
the letters of the wordmark are real IBM Plex Mono outlines, converted to SVG
paths at build time. A journalist opening these in Illustrator, or a product
inlining them into a page, gets the same shapes we do without installing
anything.

The font is not vendored. It is read out of `launch/launch.html`, which already
carries a base64 IBM Plex Mono subset (regular + bold) so the launch card
renders identically offline. This script borrows it for an hour and writes only
outlines.

    pip install fonttools brotli
    python3 brand/build.py            # SVGs only
    python3 brand/build.py --png      # SVGs + PNGs (needs headless Chrome)

Chrome is located via $CHROME, else the first match under ~/.cache/ms-playwright.
"""

import argparse
import base64
import glob
import io
import math
import os
import re
import subprocess
import sys

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "brand", "logo")
PNG = os.path.join(OUT, "png")

# ── Palette ──────────────────────────────────────────────────────────────────
# The dapp's own values. Keep in step with brand/README.md and dapp/index.html.
BLUE = "#2D5FE8"   # Signal Blue   — the field
ICE = "#F5FBFF"    # Ice           — ink on blue
PAPER = "#FDFDFD"  # Paper         — the light field
TEAL = "#0099B3"   # Deep Teal     — ink on paper
INK = "#0A0A0A"    # Ink           — one-colour dark
MINT = "#7DFFBA"   # Mint          — threshold met, the one accent

# ── The mark ─────────────────────────────────────────────────────────────────
# A 64-unit square. The M is drawn, not set: it is a single path, so it stays
# crisp at 16px. The frame is a border of "/" glyphs run along each edge — the
# same hatch the interface uses to mark a pending signature.
M_PATH = "M16,48 V16 H22 L32,32 L42,16 H48 V48 H42 V26 L32,42 L22,26 V48 Z"

HATCH_SIZE = 4.2      # font-size of the "/" glyphs, in mark units
HATCH_TRACK = -0.3    # letter-spacing, in mark units
HATCH_OPACITY = 0.6
CLEAR = 0.25          # minimum clear space, as a fraction of the mark's height

# start point, direction, and run length of each edge's baseline
EDGES = [
    ((1, 4), 0, 59),     # top,    left to right
    ((60, 1), 90, 59),   # right,  top to bottom
    ((63, 60), 180, 59), # bottom, right to left
    ((4, 63), 270, 59),  # left,   bottom to top
]

# ── The wordmark ─────────────────────────────────────────────────────────────
# MULTISIG in IBM Plex Mono Bold at -0.0338em, the launch card's -2.5px on 74px.
# ".software" in Regular at 1.444em, the card's 26px on 18px.
WORD = "MULTISIG"
WORD_TRACK = -2.5 / 74
SUB = ".software"
SUB_SIZE = 18 / 74      # relative to the wordmark
SUB_TRACK = 26 / 18


def faces():
    """Pull the two IBM Plex Mono subsets out of the launch card."""
    html = open(os.path.join(ROOT, "launch", "launch.html")).read()
    found = re.findall(
        r"@font-face\{font-family:'PlexM';src:url\(data:font/woff2;base64,"
        r"([A-Za-z0-9+/=]+)\) format\('woff2'\);font-weight:(\d+)", html)
    if len(found) != 2:
        sys.exit("launch/launch.html no longer carries both PlexM faces")
    return {int(w): TTFont(io.BytesIO(base64.b64decode(b))) for b, w in found}


def num(v):
    """Trim float noise so the SVGs stay diffable."""
    s = f"{v:.3f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def glyph_quad(font, ch):
    """The corners of a straight-sided glyph in em units, y flipped for SVG.

    "/" is four points and no curves, which is what makes a font-free frame
    possible at all — record the contour and place copies of it by hand.
    """
    gs = font.getGlyphSet()
    pen = RecordingPen()
    gs[font.getBestCmap()[ord(ch)]].draw(pen)
    upem = font["head"].unitsPerEm
    pts = []
    for op, args in pen.value:
        if op in ("moveTo", "lineTo"):
            pts.append(args[0])
        elif op in ("curveTo", "qCurveTo"):
            sys.exit(f"'{ch}' is not a straight-sided glyph in this face")
    return [(x / upem, -y / upem) for x, y in pts]


def hatch(font):
    """One path holding every slash of the frame, in final mark coordinates."""
    quad = glyph_quad(font, "/")
    gs = font.getGlyphSet()
    pitch = HATCH_SIZE * gs[font.getBestCmap()[ord("/")]].width / \
        font["head"].unitsPerEm + HATCH_TRACK
    out = []
    for (ox, oy), deg, run in EDGES:
        cos, sin = math.cos(math.radians(deg)), math.sin(math.radians(deg))
        for i in range(int(run // pitch)):
            corners = []
            for gx, gy in quad:
                x, y = gx * HATCH_SIZE + i * pitch, gy * HATCH_SIZE
                corners.append((ox + x * cos - y * sin, oy + x * sin + y * cos))
            head, *rest = corners
            out.append("M" + num(head[0]) + "," + num(head[1]) +
                       "".join("L" + num(x) + "," + num(y) for x, y in rest) + "Z")
    return "".join(out)


def text_path(font, text, size, track):
    """Outline `text` as one path on a baseline at y=0, starting at x=0.

    Returns (path data, advance width, bbox). The glyph outlines come out of a
    TransformPen, so the scale and the y-flip are baked into the numbers and
    nothing downstream has to re-parse a path.
    """
    gs, cmap = font.getGlyphSet(), font.getBestCmap()
    s = size / font["head"].unitsPerEm
    parts, pen_x = [], 0.0
    x0 = y0 = x1 = y1 = None
    for ch in text:
        name = cmap[ord(ch)]
        out = SVGPathPen(gs, ntos=num)
        gs[name].draw(TransformPen(out, (s, 0, 0, -s, pen_x, 0)))
        d = out.getCommands()
        if d:
            parts.append(d)
            bounds = BoundsPen(gs)
            gs[name].draw(TransformPen(bounds, (s, 0, 0, -s, pen_x, 0)))
            if bounds.bounds:
                bx0, by0, bx1, by1 = bounds.bounds
                x0 = bx0 if x0 is None else min(x0, bx0)
                y0 = by0 if y0 is None else min(y0, by0)
                x1 = bx1 if x1 is None else max(x1, bx1)
                y1 = by1 if y1 is None else max(y1, by1)
        pen_x += gs[name].width * s + track * size
    return "".join(parts), pen_x - track * size, (x0, y0, x1, y1)


def svg(w, h, body, title):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {num(w)} '
            f'{num(h)}" role="img" aria-label="{title}">\n'
            f'<title>{title}</title>\n{body}</svg>\n')


def write(name, content):
    path = os.path.join(OUT, name)
    open(path, "w").write(content)
    print("  " + os.path.relpath(path, ROOT))


# ── Variants ─────────────────────────────────────────────────────────────────
# field, ink, label. `None` field means transparent.
VARIANTS = [
    ("blue", BLUE, ICE),
    ("light", PAPER, TEAL),
    ("white", None, "#FFFFFF"),
    ("black", None, INK),
]


def build_marks(frame):
    for name, field, ink in VARIANTS:
        body = ""
        if field:
            body += f'<rect width="64" height="64" fill="{field}"/>\n'
        body += (f'<path d="{frame}" fill="{ink}" fill-opacity="{HATCH_OPACITY}"/>\n'
                 f'<path d="{M_PATH}" fill="{ink}"/>\n')
        write(f"multisig-mark-{name}.svg", svg(64, 64, body, "Multisig"))


def build_lockups(frame, fonts):
    """Mark, a gap of one mark-quarter, then MULTISIG on the same optical centre.

    The minimum clear space is baked into the file rather than left to a rule
    nobody reads, so a lockup dropped straight into a page is already correct.
    """
    mark, size = 64, 64 * 74 / 104     # the launch card's mark-to-wordmark ratio
    pad = gap = mark * CLEAR
    word, _, (wx0, wy0, wx1, wy1) = text_path(fonts[700], WORD, size, WORD_TRACK)
    cap = wy1 - wy0
    dx = pad + mark + gap - wx0
    dy = pad + mark / 2 + cap / 2 - wy1            # cap height centred on the mark
    width, height = dx + wx1 + pad, mark + pad * 2
    for name, field, ink in VARIANTS:
        body = ""
        if field:
            body += (f'<rect width="{num(width)}" height="{num(height)}" '
                     f'fill="{field}"/>\n')
        body += (f'<g transform="translate({num(pad)},{num(pad)})">'
                 f'<path d="{frame}" fill="{ink}" fill-opacity="{HATCH_OPACITY}"/>'
                 f'<path d="{M_PATH}" fill="{ink}"/></g>\n'
                 f'<path transform="translate({num(dx)},{num(dy)})" d="{word}" '
                 f'fill="{ink}"/>\n')
        write(f"multisig-lockup-{name}.svg", svg(width, height, body, "Multisig"))


def build_stacked(frame, fonts):
    """The launch card's lockup: mark over MULTISIG over .software."""
    mark, size = 104, 74
    pad = mark * CLEAR
    word, _, (wx0, wy0, wx1, wy1) = text_path(fonts[700], WORD, size, WORD_TRACK)
    sub, _, (sx0, sy0, sx1, sy1) = text_path(
        fonts[400], SUB, size * SUB_SIZE, SUB_TRACK)
    inner = max(mark, wx1 - wx0, sx1 - sx0)
    width, cx = inner + pad * 2, pad + inner / 2
    # The card's own rhythm: 18px of air on 104px of mark, above each line.
    air = mark * 18 / 104
    y_word = pad + mark + air + (wy1 - wy0)
    y_sub = y_word + air + (sy1 - sy0)
    height = y_sub + pad
    for name, field, ink in VARIANTS:
        body = ""
        if field:
            body += (f'<rect width="{num(width)}" height="{num(height)}" '
                     f'fill="{field}"/>\n')
        body += (f'<g transform="translate({num(cx - mark / 2)},{num(pad)}) '
                 f'scale({num(mark / 64)})">'
                 f'<path d="{frame}" fill="{ink}" fill-opacity="{HATCH_OPACITY}"/>'
                 f'<path d="{M_PATH}" fill="{ink}"/></g>\n'
                 f'<path transform="translate({num(cx - (wx0 + wx1) / 2)},'
                 f'{num(y_word)})" d="{word}" fill="{ink}"/>\n'
                 f'<path transform="translate({num(cx - (sx0 + sx1) / 2)},'
                 f'{num(y_sub)})" d="{sub}" fill="{ink}" fill-opacity="0.82"/>\n')
        write(f"multisig-lockup-stacked-{name}.svg",
              svg(width, height, body, "Multisig — multisig.software"))


def build_card(frame, fonts):
    """A 1200x630 Open Graph card — the size Twitter, Slack and Discord crop to.

    Same stacked lockup, on the same blue, under the same green hairline the
    interface uses for a met threshold.
    """
    w, h, mark, size = 1200, 630, 132, 94
    word, _, (wx0, wy0, wx1, wy1) = text_path(fonts[700], WORD, size, WORD_TRACK)
    sub, _, (sx0, sy0, sx1, sy1) = text_path(
        fonts[400], SUB, size * SUB_SIZE, SUB_TRACK)
    foot, _, (fx0, fy0, fx1, fy1) = text_path(
        fonts[400], "K-OF-N MULTISIG WITH A BUILT-IN TIMELOCK", 16, 0.3)
    top, cx = 150, w / 2
    y_word = top + mark + 22 + (wy1 - wy0)
    y_sub = y_word + 24 + (sy1 - sy0)
    rule = y_sub + 44
    body = (
        f'<rect width="{w}" height="{h}" fill="{BLUE}"/>\n'
        f'<g transform="translate({num(cx - mark / 2)},{num(top)}) '
        f'scale({num(mark / 64)})">'
        f'<path d="{frame}" fill="{ICE}" fill-opacity="{HATCH_OPACITY}"/>'
        f'<path d="{M_PATH}" fill="{ICE}"/></g>\n'
        f'<path transform="translate({num(cx - (wx0 + wx1) / 2)},{num(y_word)})" '
        f'd="{word}" fill="{ICE}"/>\n'
        f'<path transform="translate({num(cx - (sx0 + sx1) / 2)},{num(y_sub)})" '
        f'd="{sub}" fill="{ICE}" fill-opacity="0.82"/>\n'
        f'<rect x="{num(cx - 330)}" y="{num(rule)}" width="660" height="2.5" '
        f'fill="{MINT}"/>\n'
        f'<path transform="translate({num(cx - (fx0 + fx1) / 2)},{num(rule + 50)})" '
        f'd="{foot}" fill="{ICE}" fill-opacity="0.72"/>\n')
    path = os.path.join(ROOT, "brand", "social", "multisig-card.svg")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "w").write(svg(w, h, body, "Multisig — multisig.software"))
    print("  " + os.path.relpath(path, ROOT))


# ── Raster ───────────────────────────────────────────────────────────────────
RASTER = [
    ("multisig-mark-blue.svg", [32, 128, 512, 1024]),
    ("multisig-mark-light.svg", [512, 1024]),
    ("multisig-mark-white.svg", [512, 1024]),
    ("multisig-mark-black.svg", [512, 1024]),
    ("multisig-lockup-blue.svg", [1024, 2048]),
    ("multisig-lockup-light.svg", [1024, 2048]),
    ("multisig-lockup-white.svg", [2048]),
    ("multisig-lockup-stacked-blue.svg", [1024]),
    ("multisig-lockup-stacked-light.svg", [1024]),
]


def chrome():
    if os.environ.get("CHROME"):
        return os.environ["CHROME"]
    for pattern in ("~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome",
                    "~/.cache/ms-playwright/chromium-*/chrome-linux/chrome"):
        hits = glob.glob(os.path.expanduser(pattern))
        if hits:
            return sorted(hits)[-1]
    for name in ("chromium", "chromium-browser", "google-chrome"):
        path = subprocess.run(["which", name], capture_output=True,
                              text=True).stdout.strip()
        if path:
            return path
    sys.exit("no Chrome found — set $CHROME to a Chrome or Chromium binary")


def shoot(binary, src, dst, width):
    """Rasterise one SVG at an exact pixel width, preserving its aspect ratio."""
    vb = re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', open(src).read())
    height = max(1, round(width * float(vb.group(2)) / float(vb.group(1))))
    subprocess.run([
        binary, "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
        "--force-device-scale-factor=1", "--default-background-color=00000000",
        f"--screenshot={dst}", f"--window-size={width},{height}", "file://" + src,
    ], capture_output=True)
    print("  " + os.path.relpath(dst, ROOT))


def build_png():
    binary = chrome()
    os.makedirs(PNG, exist_ok=True)
    for name, widths in RASTER:
        for w in widths:
            shoot(binary, os.path.join(OUT, name),
                  os.path.join(PNG, name.replace(".svg", f"-{w}.png")), w)
    social = os.path.join(ROOT, "brand", "social")
    card = os.path.join(social, "multisig-card-1200x630.png")
    shoot(binary, os.path.join(social, "multisig-card.svg"), card, 1200)
    # dapp/brand.html points og:image at multisig.software/multisig-card-1200x630.png.
    # Unfurlers want an absolute URL on the page's own origin, and Render serves
    # only ./dapp — so the card has to exist there, not just in brand/.
    served = os.path.join(ROOT, "dapp", "multisig-card-1200x630.png")
    open(served, "wb").write(open(card, "rb").read())
    print("  " + os.path.relpath(served, ROOT))


# ── Book mirror ──────────────────────────────────────────────────────────────
# mdBook only copies what lives under docs/src, so the press chapter needs its
# own copies. They are written here rather than by hand so they cannot go stale.
MIRROR = [
    (OUT, "multisig-mark-blue.svg"),
    (OUT, "multisig-lockup-blue.svg"),
    (OUT, "multisig-lockup-light.svg"),
    (OUT, "multisig-lockup-stacked-blue.svg"),
    (os.path.join(ROOT, "brand", "social"), "multisig-card.svg"),
]


def mirror_to_book():
    dst_dir = os.path.join(ROOT, "docs", "src", "brand")
    os.makedirs(dst_dir, exist_ok=True)
    for src_dir, name in MIRROR:
        dst = os.path.join(dst_dir, name)
        open(dst, "w").write(open(os.path.join(src_dir, name)).read())
        print("  " + os.path.relpath(dst, ROOT))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--png", action="store_true", help="also rasterise")
    args = ap.parse_args()

    os.makedirs(OUT, exist_ok=True)
    fonts = faces()
    frame = hatch(fonts[400])
    build_marks(frame)
    build_lockups(frame, fonts)
    build_stacked(frame, fonts)
    build_card(frame, fonts)
    mirror_to_book()
    if args.png:
        build_png()


if __name__ == "__main__":
    main()
