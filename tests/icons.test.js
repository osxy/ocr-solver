/**
 * Tray icon tests (issue #164).
 *
 * The icon is the app's only visible presence on Windows, and the defect was
 * purely visual: a flat, fully opaque 16x16 square. No runner can render the
 * tray, but the bitmap can be decoded - so the guard asserts the *properties*
 * the mark must have, not the bytes it happens to be:
 *
 *   - each embedded PNG decodes and is 16x16;
 *   - it has more than one distinct colour, so it is not a flat fill;
 *   - it has transparent pixels, so it is not a full-bleed block that punches
 *     a rectangle into the taskbar;
 *   - the two states stay distinguishable - blue for listening, neutral grey
 *     for the watchdog's quiet state (README).
 *
 * Both original bitmaps were one colour across all 256 opaque pixels, so these
 * fail on the shape this replaced.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { TRAY_ICONS, trayIcon } from '../src/ui/icons.js';

async function decode(b64) {
  const { data, info } = await sharp(Buffer.from(b64, 'base64'))
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

test('each tray icon is a shaped 16x16 piece, not a flat opaque square (#164)', async () => {
  for (const [state, b64] of Object.entries(TRAY_ICONS)) {
    const { data, info } = await decode(b64);
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
  const blue = dominantColour(await decode(TRAY_ICONS.normal));
  const grey = dominantColour(await decode(TRAY_ICONS.grey));

  assert.ok(blue[2] > blue[0] + 40, `normal is the blue listening state, got rgb(${blue})`);
  assert.ok(
    Math.abs(grey[0] - grey[1]) < 8 && Math.abs(grey[1] - grey[2]) < 8,
    `grey is a neutral quiet state, got rgb(${grey})`
  );
  assert.notDeepEqual(blue, grey);
});

test('trayIcon falls back to normal for an unknown state', () => {
  assert.equal(trayIcon('nope'), TRAY_ICONS.normal);
  assert.equal(trayIcon('grey'), TRAY_ICONS.grey);
  assert.equal(trayIcon(), TRAY_ICONS.normal);
});
