/**
 * Preprocessing: turn a noisy coloured puzzle image into a clean black-on-white
 * bitmap that Tesseract can read.
 *
 * Why this exists (measured on the sample corpus):
 *   - Saturation does NOT separate ink from noise (both ~20-23% mean saturation).
 *   - A global luminance threshold fails because the noise gets darker toward one
 *     side of the image, so no single cut point works across the whole width.
 *   - Local adaptive thresholding (Bradley) handles the varying background.
 *   - Residual speckle is removed by connectivity: noise is isolated pixels,
 *     glyph strokes are connected components.
 *
 * The upscale happens LAST. Denoising at native resolution is what works; scaling
 * first turns per-pixel noise into 4x4 blocks that median/connectivity filters
 * can no longer distinguish from strokes.
 */
import sharp from 'sharp';

/**
 * Named preprocessing presets.
 *
 * Constants chosen by sweeping scripts/tune-preprocessing.js against the corpus.
 * w25_t0.2_c4 is the outright winner there (3/3 exact transcripts), so it runs
 * first and usually decides the answer on its own; the others exist so a garble
 * in one variant can be recovered from another.
 */
export const VARIANTS = {
  adaptive_25_020: { win: 25, t: 0.2, minComponent: 4, scale: 4 },
  adaptive_25_020_c8: { win: 25, t: 0.2, minComponent: 8, scale: 4 },
  adaptive_15_020: { win: 15, t: 0.2, minComponent: 4, scale: 4 },
  adaptive_15_020_x6: { win: 15, t: 0.2, minComponent: 4, scale: 6 },
};

export const DEFAULT_VARIANTS = ['adaptive_25_020', 'adaptive_25_020_c8', 'adaptive_15_020'];

/** Rec.601 luminance, which matches how the eye weights these pastel colours. */
export function toLuminance(rgb, width, height) {
  const lum = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    lum[i] = (0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2]) | 0;
  }
  return lum;
}

/** Summed-area table so any local window mean is O(1). */
export function integralImage(gray, width, height) {
  const stride = width + 1;
  const I = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += gray[y * width + x];
      I[(y + 1) * stride + (x + 1)] = I[y * stride + (x + 1)] + rowSum;
    }
  }
  return I;
}

/**
 * Bradley adaptive threshold: a pixel is ink if it is meaningfully darker than the
 * mean of its local window. Robust to gradients in the background noise.
 */
export function bradleyThreshold(gray, width, height, win, t) {
  const stride = width + 1;
  const I = integralImage(gray, width, height);
  const r = win >> 1;
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(height - 1, y + r);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(width - 1, x + r);
      const count = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum =
        I[(y1 + 1) * stride + (x1 + 1)] - I[y0 * stride + (x1 + 1)] -
        I[(y1 + 1) * stride + x0] + I[y0 * stride + x0];
      mask[y * width + x] = gray[y * width + x] < (sum / count) * (1 - t) ? 1 : 0;
    }
  }
  return mask;
}

/** Drop ink pixels without enough ink neighbours. Isolated noise dies, strokes survive. */
export function despeckle(mask, width, height, minNeighbours = 2, passes = 1) {
  let cur = mask;
  for (let p = 0; p < passes; p++) {
    const out = new Uint8Array(cur.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (!cur[i]) continue;
        let c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const yy = y + dy;
            const xx = x + dx;
            if (yy < 0 || xx < 0 || yy >= height || xx >= width) continue;
            if (cur[yy * width + xx]) c++;
          }
        }
        out[i] = c >= minNeighbours ? 1 : 0;
      }
    }
    cur = out;
  }
  return cur;
}

/**
 * Keep only connected components of at least `minSize` pixels.
 * This is the strongest noise filter available: random noise never forms large blobs.
 */
export function componentFilter(mask, width, height, minSize) {
  if (minSize <= 1) return mask;
  const label = new Int32Array(width * height).fill(-1);
  const out = new Uint8Array(width * height);
  const stack = [];
  const members = [];
  let next = 0;
  for (let i = 0; i < width * height; i++) {
    if (!mask[i] || label[i] !== -1) continue;
    const id = next++;
    stack.length = 0;
    members.length = 0;
    stack.push(i);
    label[i] = id;
    while (stack.length) {
      const cur = stack.pop();
      members.push(cur);
      const cx = cur % width;
      const cy = (cur - cx) / width;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = cy + dy;
          const xx = cx + dx;
          if (yy < 0 || xx < 0 || yy >= height || xx >= width) continue;
          const j = yy * width + xx;
          if (mask[j] && label[j] === -1) {
            label[j] = id;
            stack.push(j);
          }
        }
      }
    }
    if (members.length >= minSize) for (const m of members) out[m] = 1;
  }
  return out;
}

/** Morphological closing: bridges hairline breaks inside glyph strokes. */
export function closeMask(mask, width, height) {
  const dilate = (src) => {
    const out = new Uint8Array(src.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let on = 0;
        for (let dy = -1; dy <= 1 && !on; dy++) {
          for (let dx = -1; dx <= 1 && !on; dx++) {
            const yy = y + dy;
            const xx = x + dx;
            if (yy < 0 || xx < 0 || yy >= height || xx >= width) continue;
            if (src[yy * width + xx]) on = 1;
          }
        }
        out[y * width + x] = on;
      }
    }
    return out;
  };
  const erode = (src) => {
    const out = new Uint8Array(src.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let all = 1;
        for (let dy = -1; dy <= 1 && all; dy++) {
          for (let dx = -1; dx <= 1 && all; dx++) {
            const yy = y + dy;
            const xx = x + dx;
            if (yy < 0 || xx < 0 || yy >= height || xx >= width) continue;
            if (!src[yy * width + xx]) all = 0;
          }
        }
        out[y * width + x] = all;
      }
    }
    return out;
  };
  return erode(dilate(mask));
}

/** Darken the mask by one pixel - helps reconnect broken letters before OCR. */
export function dilateMask(mask, width, height) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let on = 0;
      for (let dy = -1; dy <= 1 && !on; dy++) {
        for (let dx = -1; dx <= 1 && !on; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy < 0 || xx < 0 || yy >= height || xx >= width) continue;
          if (mask[yy * width + xx]) on = 1;
        }
      }
      out[y * width + x] = on;
    }
  }
  return out;
}

/** Run the full mask extraction on an image buffer or path. */
export async function extractMask(input, opts = {}) {
  const {
    win = 15,
    t = 0.2,
    minComponent = 4,
    minNeighbours = 0,
    despecklePasses = 1,
    closing = 0,
    dilate = 0,
    // Second layer behind the image gate: `sharp` refuses to decode an input above
    // this, so a caller that skipped `validateImageBuffer` still cannot hand the
    // pipeline a pixel bomb. The gate rejects first with a precise reason; this only
    // ever fires if the gate was bypassed.
    limitInputPixels = null,
  } = opts;

  const sharpOptions = limitInputPixels != null ? { limitInputPixels } : {};
  const { data, info } = await sharp(input, sharpOptions)
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const lum = toLuminance(data, width, height);
  let mask = bradleyThreshold(lum, width, height, win, t);
  mask = componentFilter(mask, width, height, minComponent);
  if (minNeighbours > 0) mask = despeckle(mask, width, height, minNeighbours, despecklePasses);
  for (let i = 0; i < closing; i++) mask = closeMask(mask, width, height);
  for (let i = 0; i < dilate; i++) mask = dilateMask(mask, width, height);
  return { mask, width, height };
}

/** Render a mask as a white-background PNG upscaled for OCR. */
export async function renderMask(mask, width, height, scale = 4, border = 8) {
  const rgb = Buffer.alloc(width * height * 3, 255);
  for (let i = 0; i < width * height; i++) {
    if (mask[i]) {
      rgb[i * 3] = 0;
      rgb[i * 3 + 1] = 0;
      rgb[i * 3 + 2] = 0;
    }
  }
  return sharp(rgb, { raw: { width, height, channels: 3 } })
    .resize({ width: width * scale, height: height * scale, kernel: 'lanczos3' })
    .extend({ top: border, bottom: border, left: border, right: border, background: '#ffffff' })
    .png()
    .toBuffer();
}

/** Build every named preprocessing variant for one image. */
export async function buildVariants(input, names = DEFAULT_VARIANTS, { limitInputPixels = null } = {}) {
  const out = [];
  for (const name of names) {
    const preset = VARIANTS[name];
    if (!preset) throw new Error(`unknown preprocessing variant: ${name}`);
    const { mask, width, height } = await extractMask(input, { ...preset, limitInputPixels });
    const buffer = await renderMask(mask, width, height, preset.scale);
    out.push({ name, buffer, width, height });
  }
  return out;
}
