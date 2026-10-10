#!/usr/bin/env node
/**
 * Regenerate the tray icon files from the jigsaw-piece SVG (issues #164, #185).
 *
 * The tray is handed a **file path**, not image data: `systray2` calls
 * `fs.pathExists(icon)` and, when that is true, `readFile()`s the path and base64s
 * the bytes itself. Windows then requires a real `.ico` - the tray binary's source
 * says "iconBytes should be the content of .ico for windows and .ico/.jpg/.png for
 * other platforms". So the artwork has to exist as files, not as a base64 string
 * embedded in the module.
 *
 * `src/ui/icons/tray-piece.svg` stays the single source of truth. This script
 * rasterises it with `sharp` (already a dependency, used only here and in tests) and
 * writes four committed files:
 *
 *   src/ui/icons/tray-normal.png   src/ui/icons/tray-normal.ico   (blue = listening)
 *   src/ui/icons/tray-grey.png     src/ui/icons/tray-grey.ico     (grey = quiet)
 *
 * Do not edit a generated icon by hand: edit the SVG and re-run this script. The two
 * colour states share one geometry, so the shape can never drift between them.
 *
 *   node scripts/build-tray-icons.mjs              # rewrite the four icon files
 *   node scripts/build-tray-icons.mjs --preview    # also write the review PNG
 */
import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SVG_PATH = join(root, 'src/ui/icons/tray-piece.svg');
const ICON_DIR = join(root, 'src/ui/icons');
const PREVIEW_PATH = join(ICON_DIR, 'tray-piece-preview.png');

// The tokens as they appear in the committed SVG.
const BLUE = { fill: '#1e78dc', stroke: '#0a3d73' };
const GREY = { fill: '#969696', stroke: '#4a4a4a' };

const STATES = [
  { key: 'normal', file: 'tray-normal', palette: BLUE },
  { key: 'grey', file: 'tray-grey', palette: GREY },
];

const source = readFileSync(SVG_PATH, 'utf8');

/** The geometry with this state's colours, keeping the tab and blank identical. */
function svgFor({ fill, stroke }) {
  return source
    .replace(`fill="${BLUE.fill}"`, `fill="${fill}"`)
    .replace(`stroke="${BLUE.stroke}"`, `stroke="${stroke}"`);
}

/** Rasterise one state to its 16x16 PNG. */
function render(svgText) {
  return sharp(Buffer.from(svgText), { density: 384 })
    .resize(16, 16, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

/**
 * Wrap a PNG in a single-entry ICO container.
 *
 * `sharp` cannot write ICO, so the container is assembled here. This is the
 * PNG-compressed entry form: the image bytes are a verbatim PNG and the directory
 * entry says so by pointing at an offset past the header. Windows'
 * `LoadImage`/`CreateIconFromResourceEx` has accepted a PNG entry since Vista, and the
 * app requires Windows 10/11; `packaging/run-tray-interop.ps1` proves the result with
 * the same Win32 `LoadImage` call the tray binary makes, on the Windows deploy job,
 * rather than relying on that sentence.
 *
 * ICONDIR is 6 bytes (reserved, type = 1, count); each ICONDIRENTRY is 16 bytes. A
 * 16px icon stores 16 in its width/height bytes, 32bpp, the PNG byte length, and an
 * offset of 6 + 16. The PNG itself follows.
 */
function pngToIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved, must be 0
  header.writeUInt16LE(1, 2); // image type: 1 = icon
  header.writeUInt16LE(1, 4); // number of images

  const entry = Buffer.alloc(16);
  entry.writeUInt8(16, 0); // width (0 means 256; 16 for a 16px icon)
  entry.writeUInt8(16, 1); // height
  entry.writeUInt8(0, 2); // palette colour count (0 = truecolour)
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8); // size of the image data
  entry.writeUInt32LE(header.length + entry.length, 12); // offset of the image data

  return Buffer.concat([header, entry, png]);
}

const pngs = {};
for (const state of STATES) {
  pngs[state.key] = await render(svgFor(state.palette));
  writeFileSync(join(ICON_DIR, `${state.file}.png`), pngs[state.key]);
  writeFileSync(join(ICON_DIR, `${state.file}.ico`), pngToIco(pngs[state.key]));
  console.log(`wrote ${join(ICON_DIR, `${state.file}.png`)}`);
  console.log(`wrote ${join(ICON_DIR, `${state.file}.ico`)}`);
}

if (process.argv.includes('--preview')) {
  // A 2x2 contact sheet of the *actual* 16px bitmaps, nearest-upscaled 8x, on a
  // light and a dark background - the thing a reviewer cannot see in a diff.
  const scale = 8;
  const cell = 16 * scale;
  const pad = 12;
  const size = pad * 3 + cell * 2;
  const backgrounds = [
    { top: pad, left: pad, colour: '#f4f4f4' },
    { top: pad, left: pad * 2 + cell, colour: '#f4f4f4' },
    { top: pad * 2 + cell, left: pad, colour: '#1e1e1e' },
    { top: pad * 2 + cell, left: pad * 2 + cell, colour: '#1e1e1e' },
  ];
  const tiles = await Promise.all(
    [0, 1, 2, 3].map((i) =>
      sharp(pngs[i % 2 === 0 ? 'normal' : 'grey'])
        .resize(cell, cell, { kernel: 'nearest' })
        .png()
        .toBuffer()
    )
  );
  const sheet = sharp({
    create: { width: size, height: size, channels: 4, background: '#00000000' },
  });
  const composites = [];
  backgrounds.forEach((bg, i) => {
    composites.push({
      input: { create: { width: cell, height: cell, channels: 4, background: bg.colour } },
      top: bg.top,
      left: bg.left,
    });
    composites.push({ input: tiles[i], top: bg.top, left: bg.left });
  });
  await sheet.composite(composites).png().toFile(PREVIEW_PATH);
  console.log(`wrote ${PREVIEW_PATH}`);
}
