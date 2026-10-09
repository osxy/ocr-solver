/**
 * Deterministic renderer for the synthetic corpus (M4).
 *
 * The three real puzzle images are the only ground truth we have for the real
 * generator, so they can never be enough to move a metric by a meaningful amount.
 * This renderer produces images in the *observed* style - coloured text on dense
 * coloured noise, 44 px tall, one or two lines - with the answer known by
 * construction, which is what makes a large corpus possible at all.
 *
 * What it is not: a model of the real generator. It reproduces the visual
 * properties DESIGN 2 measured (local luminance contrast, per-pixel noise that
 * dies in the component filter), not the generator's font, palette or noise
 * distribution. Accuracy on these images is therefore **not real-world accuracy**
 * and is reported under its own provenance, never blended into the `real` number.
 *
 * Rendering is seeded: the same (lines, seed, style) always produces the same
 * bytes, so regenerating the corpus on another machine with the same fonts is a
 * no-op diff. Fonts are the one non-hermetic input; the committed PNGs, not the
 * renderer, are what the tests consume.
 */
import sharp from 'sharp';

/** Small, fast, deterministic PRNG (mulberry32). Identical seeds -> identical corpus. */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]
  ));
}

/**
 * The ink colours seen on the real samples: a saturated mid-tone that is darker
 * than the pastel noise but not black. Black ink would make the puzzle trivially
 * separable and would not exercise the adaptive threshold.
 */
export const INK_COLOURS = ['#8a4b1e', '#7a3f8f', '#6f7a2a', '#245a8a', '#8a2f4f', '#3f6b3f'];

/**
 * A pastel palette for the noise. Each channel is nudged independently, which is
 * what gives the real background its colour speckle while keeping the mean
 * luminance high enough that the Bradley threshold sees ink as locally dark.
 */
export function noisePalette(rand, { size = 12, min = 175, max = 255 } = {}) {
  const span = max - min;
  const palette = [];
  for (let i = 0; i < size; i++) {
    palette.push([
      min + Math.floor(rand() * span),
      min + Math.floor(rand() * span),
      min + Math.floor(rand() * span),
    ]);
  }
  return palette;
}

/**
 * Render one noisy puzzle image.
 *
 * @param {object} options
 * @param {string[]} options.lines  one entry per rendered line (already wrapped)
 * @param {number} [options.seed]
 * @param {number} [options.fontSize]
 * @param {string} [options.fill]   ink colour; defaults from the seed
 * @param {number} [options.padding]
 * @returns {Promise<Buffer>} PNG bytes
 */
export async function renderPuzzleImage({
  lines,
  seed = 1,
  fontSize = 28,
  fill = null,
  padding = 6,
  noise = {},
} = {}) {
  if (!Array.isArray(lines) || lines.length === 0) throw new Error('renderPuzzleImage needs at least one line');
  const rand = seededRandom(seed);
  const ink = fill ?? INK_COLOURS[Math.floor(rand() * INK_COLOURS.length)];

  // Measure the rendered text so the canvas hugs it, exactly as the real samples
  // do. A width chosen from a character count would clip wide glyphs or leave a
  // huge empty margin, and both change how the adaptive threshold behaves.
  const cleanSvg = (line) => Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="80">` +
      `<rect width="2400" height="80" fill="#ffffff"/>` +
      `<text x="4" y="48" font-family="sans-serif" font-size="${fontSize}" fill="#000000">${escapeXml(line)}</text>` +
    `</svg>`
  );
  let textWidth = 0;
  let textHeight = 0;
  for (const line of lines) {
    const trimmed = await sharp(cleanSvg(line)).trim({ threshold: 10 }).toBuffer({ resolveWithObject: true });
    textWidth = Math.max(textWidth, trimmed.info.width);
    textHeight += trimmed.info.height;
  }
  const lineGap = 2;
  const width = textWidth + padding * 2;
  const height = Math.max(44, textHeight + lineGap * (lines.length - 1) + padding * 2);

  // Noise first, then text on top. Per-pixel noise is what the component filter is
  // built to remove; blocks large enough to survive it would not be the real style.
  const palette = noisePalette(rand, noise);
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const [r, g, b] = palette[Math.floor(rand() * palette.length)];
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
  }

  const lineHeight = Math.round(fontSize * 1.15);
  const totalText = lineHeight * lines.length;
  const startY = Math.max(Math.round((height - totalText) / 2) + Math.round(fontSize * 0.85), Math.round(fontSize * 0.85));
  const textSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      lines
        .map((line, i) => `<text x="${padding}" y="${startY + i * lineHeight}" font-family="sans-serif" font-size="${fontSize}" fill="${ink}">${escapeXml(line)}</text>`)
        .join('') +
    `</svg>`
  );

  return sharp(rgb, { raw: { width, height, channels: 3 } })
    .composite([{ input: textSvg }])
    // Indexed colour keeps the dense noise from bloating the repository; the text
    // edges survive because the ink is far from every palette entry.
    .png({ palette: true, colours: 32, effort: 10 })
    .toBuffer();
}
