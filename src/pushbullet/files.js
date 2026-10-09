/**
 * Image fetcher for the Pushbullet file push.
 *
 * `file_url` is a pre-signed S3 URL, so a plain GET works and - importantly - the
 * Pushbullet token is *not* sent with it. Sending an account token to a third-party
 * host because it happens to be in the push object would leak it; the fetcher never
 * takes the token at all.
 *
 * Three checks before an image is handed to the solver, in increasing cost:
 *   1. size cap, enforced while streaming (never buffer an unbounded body);
 *   2. magic bytes - the real type is read from the bytes, not trusted from
 *      `file_type`, and it is what chooses the saved extension;
 *   3. `sharp` must actually decode it, and the height has to be plausible.
 *
 * The decode check matters because magic bytes are four to twelve bytes: a truncated
 * or corrupt file can pass step 2 and fail inside the pipeline; failing here keeps
 * the solver from ever seeing a broken image.
 */
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_RETAIN_DAYS = 7;
export const DEFAULT_MIN_HEIGHT = 8;
export const DEFAULT_MAX_HEIGHT = 20_000;

export class ImageFetchError extends Error {
  constructor(message, { reason = 'unknown', status = null } = {}) {
    super(message);
    this.name = 'ImageFetchError';
    this.reason = reason; // size | http | magic | decode | height | no-url
    this.status = status;
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Identify an image from its leading bytes only.
 * @returns {{ext: string, mime: string}|null}
 */
export function sniffImage(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { ext: '.png', mime: 'image/png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: '.jpg', mime: 'image/jpeg' };
  }
  if (buffer.length >= 6) {
    const head = buffer.subarray(0, 6).toString('ascii');
    if (head === 'GIF87a' || head === 'GIF89a') return { ext: '.gif', mime: 'image/gif' };
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { ext: '.webp', mime: 'image/webp' };
  }
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return { ext: '.bmp', mime: 'image/bmp' };
  }
  if (buffer.length >= 4) {
    const head = buffer.subarray(0, 4);
    if (head.equals(Buffer.from([0x49, 0x49, 0x2a, 0x00]))) return { ext: '.tif', mime: 'image/tiff' };
    if (head.equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))) return { ext: '.tif', mime: 'image/tiff' };
  }
  return null;
}

/** Where the inbox lives by default - the config module (leg 2) overrides it. */
export function defaultInboxDir() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return join(base, 'PuzzleSolver', 'inbox');
  }
  const base = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return join(base, 'puzzlesolver', 'inbox');
}

async function readCapped(response, maxBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    // A mocked Response without a stream; the cap still applies, just later.
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new ImageFetchError(`image is larger than the ${maxBytes} byte cap`, { reason: 'size' });
    }
    return buffer;
  }

  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value?.byteLength ?? 0;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ImageFetchError(`image is larger than the ${maxBytes} byte cap`, { reason: 'size' });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Download and validate one image URL.
 * @returns {{buffer: Buffer, ext: string, mime: string, width: number, height: number, bytes: number, contentType: string|null}}
 */
export async function downloadImage(
  url,
  {
    fetchImpl = globalThis.fetch,
    maxBytes = DEFAULT_MAX_BYTES,
    timeoutMs = 30_000,
    minHeight = DEFAULT_MIN_HEIGHT,
    maxHeight = DEFAULT_MAX_HEIGHT,
    sharpImpl = sharp,
  } = {}
) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new ImageFetchError(`image download failed with HTTP ${response.status}`, {
      reason: 'http',
      status: response.status,
    });
  }

  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ImageFetchError(`image is larger than the ${maxBytes} byte cap`, { reason: 'size' });
  }

  const buffer = await readCapped(response, maxBytes);
  const kind = sniffImage(buffer);
  if (!kind) {
    throw new ImageFetchError('downloaded bytes are not a recognised image (magic bytes)', { reason: 'magic' });
  }

  let meta;
  try {
    meta = await sharpImpl(buffer).metadata();
  } catch (err) {
    throw new ImageFetchError(`sharp could not decode the image: ${err?.message ?? err}`, { reason: 'decode' });
  }
  if (!meta?.width || !meta?.height) {
    throw new ImageFetchError('sharp decoded the image but reported no dimensions', { reason: 'decode' });
  }
  if (meta.height < minHeight || meta.height > maxHeight) {
    throw new ImageFetchError(
      `image height ${meta.height}px is outside the sane range ${minHeight}..${maxHeight}`,
      { reason: 'height' }
    );
  }

  return {
    buffer,
    ext: kind.ext,
    mime: kind.mime,
    width: meta.width,
    height: meta.height,
    bytes: buffer.length,
    contentType: response.headers?.get?.('content-type') ?? null,
  };
}

/** Save to the inbox as `<iden>.<ext>`; the extension comes from the magic bytes. */
export function saveImage(buffer, { inboxDir = defaultInboxDir(), iden, ext = '.png' } = {}) {
  mkdirSync(inboxDir, { recursive: true });
  // The iden comes from the remote service, so it is sanitised before it becomes a
  // path segment even though Pushbullet idens are URL-safe in practice.
  const safeIden = String(iden ?? `image-${Date.now()}`).replace(/[^A-Za-z0-9._-]/g, '_');
  const path = join(inboxDir, `${safeIden}${ext}`);
  writeFileSync(path, buffer);
  return path;
}

/** Download a push's file and store it in the inbox. */
export async function fetchImage(push, { inboxDir = defaultInboxDir(), ...options } = {}) {
  if (!push?.file_url) throw new ImageFetchError('push has no file_url', { reason: 'no-url' });
  const image = await downloadImage(push.file_url, options);
  const path = saveImage(image.buffer, { inboxDir, iden: push.iden, ext: image.ext });
  return { ...image, path, iden: push.iden ?? null };
}

/**
 * Delete inbox files older than `retainDays`. Called once on startup; a failed
 * unlink is skipped rather than thrown, because housekeeping must not stop the app
 * from watching for puzzles.
 */
export function pruneInbox({
  inboxDir = defaultInboxDir(),
  retainDays = DEFAULT_RETAIN_DAYS,
  now = () => Date.now() / 1000,
} = {}) {
  const removed = [];
  if (!existsSync(inboxDir)) return removed;
  const cutoffSeconds = now() - retainDays * 86_400;
  for (const name of readdirSync(inboxDir)) {
    const path = join(inboxDir, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      if (stat.mtimeMs / 1000 < cutoffSeconds) {
        unlinkSync(path);
        removed.push(name);
      }
    } catch {
      // another process removed it, or it is not ours to touch
    }
  }
  return removed;
}
