# brand/

Logos, colours and type for Multisig, plus the script that builds them.

If you are writing about the project and want the words rather than the files —
boilerplate at four lengths, a plain-English explainer and a fact sheet — go to
**[multisig.software/brand](https://www.multisig.software/brand)**, or
its markdown twin at [`docs/src/brand.md`](../docs/src/brand.md). This page is
for whoever has to place a logo.

Everything here is MIT-licensed along with the rest of the repository. You do
not need to ask before using it in an article, a deck, a wallet's chain-picker
or an integration page. The only rule is the ordinary one: don't alter the
marks, and don't use them in a way that suggests we built or endorsed your
product.

Need a size, a format or a lockup that isn't here?
[ross@wei.domains](mailto:ross@wei.domains).

## Files

```
brand/
├── build.py                     regenerates everything below
├── logo/
│   ├── multisig-mark-*.svg      the M in its frame, 1:1
│   ├── multisig-lockup-*.svg    mark + MULTISIG, 3.29:1
│   ├── multisig-lockup-stacked-*.svg
│   │                            mark over MULTISIG over .software, 1.48:1
│   └── png/                     the same, rasterised
└── social/
    ├── multisig-card.svg        Open Graph card, 1200×630
    └── multisig-card-1200x630.png
```

Each shape comes in four finishes. Pick by what is behind it, not by taste:

| Finish | File | Use it on |
|---|---|---|
| **Blue** | `-blue` | Anything. This is the primary. It carries its own field, so it survives any background. |
| **Light** | `-light` | White and near-white pages where a blue block would be too loud. |
| **White** | `-white` | Transparent. Dark backgrounds, photographs, video. |
| **Black** | `-black` | Transparent. One-colour print, faxes, laser-etching, anywhere ink is ink. |

SVG is the master in every case. Reach for the PNGs only when a system won't
take SVG — a CMS, a slide deck, an app icon pipeline.

### Which one to place

| You are | Use |
|---|---|
| An article, a slide, a partner page | `multisig-lockup-blue.svg` |
| A chain picker, an integration list, a table row | `multisig-mark-blue.svg` |
| A favicon or app icon | `png/multisig-mark-blue-32.png` … `-1024.png` |
| A dark UI | `multisig-lockup-white.svg` |
| Sharing a link | `social/multisig-card-1200x630.png` |
| A launch announcement, animated | [`launch/multisig-launch.gif`](../launch/multisig-launch.gif) |

## The mark

A capital M inside a dashed frame.

The M is the wallet. The frame is the hatch the interface draws around a
transaction that has been signed but not yet executed — the visual language of
a thing that is pending, waiting on someone else. A multisig is exactly that
gap, so the mark is the gap.

It is one path and a border of slashes, nothing else. No gradient, no shadow,
no rounded container. It resolves at 24px because there is nothing in it that
needs resolving.

### Clear space and minimum size

Clear space is **a quarter of the mark's height** on every side, and it is
already inside the lockup files — place them flush and they are correct. For
the bare mark, leave 16 units of air per 64 units of mark.

| Asset | Minimum | Below that |
|---|---|---|
| Mark | 24 px / 8 mm | The frame stops resolving and the M is alone |
| Horizontal lockup | 200 px wide | The wordmark closes up |
| Stacked lockup | 140 px wide | `.software` closes up |

Under 24px, use the M alone — take `multisig-mark-blue.svg` and delete the
frame path. It is designed to survive that.

## Colour

| Name | Hex | Role |
|---|---|---|
| **Signal Blue** | `#2D5FE8` | The field. The one colour anyone should remember. |
| **Ice** | `#F5FBFF` | Ink on blue. Not pure white — it takes the glare off a full-bleed field. |
| **Paper** | `#FDFDFD` | The light field. |
| **Deep Teal** | `#0099B3` | Ink on paper, for the light mark. |
| **Ink** | `#0A0A0A` | One-colour dark, and body text. |
| **Mint** | `#7DFFBA` | The one accent. In the interface it means a threshold has been met — a green that only appears when something is finally allowed to happen. Use it sparingly or it stops meaning that. |

Measured contrast, for anyone laying out a page:

| Pair | Ratio | |
|---|---|---|
| Ice on Signal Blue | 5.14:1 | AA at any size |
| Mint on Signal Blue | 4.31:1 | AA large text only |
| Signal Blue on Paper | 5.28:1 | AA at any size |
| Ink on Paper | 19.46:1 | AAA |
| Deep Teal on Paper | 3.33:1 | Logo and large display only — not body text |

## Type

**IBM Plex Mono**, and only IBM Plex Mono. It is SIL OFL 1.1 —
[github.com/IBM/plex](https://github.com/IBM/plex), on Google Fonts as
`IBM Plex Mono`.

Monospace is not decoration here. Everything the project displays is an
address, a hash, a nonce or a gas figure, and those are read column-by-column
or not at all. The wordmark inherits it so the logo and the data are the same
voice.

| | Face | Tracking |
|---|---|---|
| Wordmark, `MULTISIG` | Bold, all caps | −0.034 em |
| `.software` | Regular, lowercase | +1.44 em |
| Headings, UI labels | Bold, all caps | +0.06 em |
| Body, data | Regular | 0 |

The wordmark in the supplied files is already outlined, so you never have to
match this by hand. Set the tracking yourself only if you are rebuilding the
lockup at a size the files don't cover.

## Don't

- Don't recolour the mark. There are four finishes; one of them fits.
- Don't rebuild the wordmark in another typeface, or in Plex Mono Regular.
- Don't stretch, rotate, outline, emboss or add a shadow.
- Don't box the mark in a circle or a squircle. It already has a container.
- Don't put the transparent mark on a busy photograph — use `-blue`, which
  brings its own field.
- Don't crop the frame, and don't close its corners. The gaps are the point.
- Don't set the mark beside your own logo in a way that reads as a joint
  product, and don't put it on a page that implies we endorse yours.
- Don't call it "MultiSig", "Multi-Sig" or "MULTISIG" in running text. See
  [naming](../docs/src/brand.md#naming).

## Rebuilding

```bash
pip install fonttools brotli
python3 brand/build.py            # SVGs
python3 brand/build.py --png      # SVGs + PNGs, needs headless Chrome
```

Every asset here is generated, and every asset here is **font-free** — the
slashes in the frame and the letters in the wordmark are real IBM Plex Mono
outlines converted to SVG paths at build time. Nothing in `brand/` depends on a
font being installed, which is why the SVGs and the PNGs are the same shapes,
and why these files open correctly in Illustrator, Figma and a browser without
anyone chasing a missing typeface.

`build.py` reads the font out of [`launch/launch.html`](../launch/launch.html),
which already carries a base64 IBM Plex Mono subset so the launch card renders
offline. No font binary is vendored into this directory.

Chrome is found via `$CHROME`, then `~/.cache/ms-playwright/chromium-*`, then
`chromium` / `chromium-browser` / `google-chrome` on `PATH`.

If you change the mark, change it in `build.py` and re-run — the root
[`logo.svg`](../logo.svg) and [`dark-logo.svg`](../dark-logo.svg) are the
original hand-written pair the README and the mdBook use, and they are *not*
generated. Keep them in step by eye.
