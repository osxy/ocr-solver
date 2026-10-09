/**
 * Byte and pixel limits shared by the image gate and the config schema.
 *
 * This is a leaf module on purpose. `config.js` needs the defaults to build the
 * `[image]` section, and importing them from `pushbullet/files.js` would pull `sharp`
 * into config loading - the same trap `http/defaults.js` exists to avoid. No imports
 * here, so config loading stays cheap.
 *
 * The pixel limits are chosen by measurement, not taste (DESIGN 8 threat table). The
 * real corpus is at most 820x90 = 73,800 pixels; a highly compressible PNG can be a
 * few hundred KB on the wire and tens of megapixels once decoded, which `buildVariants`
 * then amplifies 16x per variant. `DEFAULT_MAX_PIXELS` bounds that work without coming
 * anywhere near a real puzzle.
 */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MIN_HEIGHT = 8;
export const DEFAULT_MAX_HEIGHT = 20_000;
export const DEFAULT_MAX_WIDTH = 2_000;
export const DEFAULT_MAX_PIXELS = 1_000_000;
