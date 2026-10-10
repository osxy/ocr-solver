/**
 * Tray icon tests (issues #164, #185).
 *
 * The icon is the app's only visible presence on Windows, and #185 was a delivery
 * defect: `systray2` is given a **file path** and reads the bytes itself, so an
 * embedded base64 string was forwarded unchanged and a bare PNG is not a valid
 * Windows icon resource. These tests therefore assert the *file* contract:
 *
 *   - the path systray2 is handed exists on disk and carries the platform-correct
 *     extension (`.ico` on Windows, `.png` elsewhere) - the assertion that fails on
 *     the shipped bug;
 *   - each PNG decodes and is a shaped 16x16 piece: more than one colour (not a flat
 *     fill) and some transparency (not a full-bleed block) - the #164 guard;
 *   - the two colour states stay distinguishable - blue for listening, neutral grey
 *     for the watchdog's quiet state;
 *   - the Windows `.ico` is a real ICO container whose entry wraps a decodable PNG,
 *     so the bytes Windows is handed are the artwork and not an accident.
 *
 * What no Linux runner can prove is that Windows' `LoadImage` accepts the `.ico`;
 * that is asserted by `packaging/run-tray-interop.ps1` on `windows-latest`, with the
 * same Win32 call the tray binary makes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import sharp from 'sharp';

import { TRAY_ICONS, trayIcon, trayIconPath, iconExtension } from '../src/ui/icons.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function decode(buffer) {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, info };
}

/** The most common fully-opaque pixel colour, as [r, g, b]. */
function dominantColour({ data }) {
  const counts = new Map();
  for (let p = 0; p < 16 * 16; p += 1) {
    const i = p * 4;
    if (data[i + 3] !== 255) continue;
    const key = `${data[i]},${data[i + 1]},${data[i + 2]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const [key] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return key.split(',').map(Number);
}

/** Parse the single-entry ICO container and return its directory fields and PNG bytes. */
function parseIco(buffer) {
  assert.equal(buffer.readUInt16LE(0), 0, 'ICONDIR.reserved is 0');
  assert.equal(buffer.readUInt16LE(2), 1, 'ICONDIR.type is 1 (icon)');
  assert.equal(buffer.readUInt16LE(4), 1, 'the icon has one image');
  const entry = {
    width: buffer.readUInt8(6),
    height: buffer.readUInt8(7),
    planes: buffer.readUInt16LE(10),
    bitCount: buffer.readUInt16LE(12),
    size: buffer.readUInt32LE(14),
    offset: buffer.readUInt32LE(18),
  };
  const png = buffer.subarray(entry.offset, entry.offset + entry.size);
  return { entry, png };
}

test('each tray state resolves to an existing file with the platform extension (#185)', () => {
  for (const state of ['normal', 'grey']) {
    for (const platform of ['win32', 'linux', 'darwin']) {
      const path = trayIconPath(state, platform);
      const expected = platform === 'win32' ? '.ico' : '.png';
      assert.ok(path.endsWith(expected), `${platform} ${state}: expected ${expected}, got ${path}`);
      assert.ok(existsSync(path), `${platform} ${state}: systray2 reads this path itself, so it must exist: ${path}`);
    }
  }
  // The default-platform path is the one the adapter actually forwards.
  assert.equal(iconExtension(), process.platform === 'win32' ? 'ico' : 'png');
  for (const path of Object.values(TRAY_ICONS)) {
    assert.ok(existsSync(path), `the adapter would hand systray2 a missing file: ${path}`);
  }
});

test("each icon PNG is a shaped 16x16 piece, not a flat opaque square (#164)", async () => {
  for (const state of ['normal', 'grey']) {
    const source = readFileSync(trayIconPath(state, 'linux'));
    assert.deepEqual(source.subarray(0, 8), PNG_MAGIC, `${state}: is a PNG`);
    const { data, info } = await decode(source);
    assert.equal(info.width, 16, `${state}: icon width`);
    assert.equal(info.height, 16, `${state}: icon height`);

    const colours = new Set();
    let transparent = 0;
    for (let p = 0; p < 16 * 16; p += 1) {
      const i = p * 4;
      colours.add(`${data[i]},${data[i + 1]},${data[i + 2]},${data[i + 3]}`);
      if (data[i + 3] < 255) transparent += 1;
    }
    assert.ok(colours.size > 1, `${state}: has more than one distinct colour (a flat fill)`);
    assert.ok(transparent > 0, `${state}: has transparent pixels (a full-bleed block)`);
  }
});

test('the two states stay distinguishable by colour', async () => {
  const blue = dominantColour(await decode(readFileSync(trayIconPath('normal', 'linux'))));
  const grey = dominantColour(await decode(readFileSync(trayIconPath('grey', 'linux'))));

  assert.ok(blue[2] > blue[0] + 40, `normal is the blue listening state, got rgb(${blue})`);
  assert.ok(
    Math.abs(grey[0] - grey[1]) < 8 && Math.abs(grey[1] - grey[2]) < 8,
    `grey is a neutral quiet state, got rgb(${grey})`
  );
  assert.notDeepEqual(blue, grey);
});

test('each Windows icon is a real ICO wrapping the 16x16 artwork (#185)', async () => {
  for (const state of ['normal', 'grey']) {
    const { entry, png } = parseIco(readFileSync(trayIconPath(state, 'win32')));
    assert.equal(entry.width, 16, `${state}: ICONDIRENTRY width`);
    assert.equal(entry.height, 16, `${state}: ICONDIRENTRY height`);
    assert.equal(entry.planes, 1, `${state}: colour planes`);
    assert.equal(entry.bitCount, 32, `${state}: bits per pixel`);
    assert.deepEqual(png.subarray(0, 8), PNG_MAGIC, `${state}: the entry points at a PNG`);

    // Decoding the entry proves the bytes are the artwork, not a zero-length payload.
    const { info } = await decode(png);
    assert.equal(info.width, 16, `${state}: embedded image width`);
    assert.equal(info.height, 16, `${state}: embedded image height`);
  }
});

test('trayIcon falls back to normal for an unknown state', () => {
  assert.equal(trayIcon('nope'), TRAY_ICONS.normal);
  assert.equal(trayIcon('grey'), TRAY_ICONS.grey);
  assert.equal(trayIcon(), TRAY_ICONS.normal);
});
