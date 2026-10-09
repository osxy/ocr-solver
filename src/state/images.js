/**
 * Stored review copies of solve images (issue #100).
 *
 * This is the first feature that persists user content to disk, so the rules are
 * narrower than "save the upload":
 *
 *  - **A bounded copy, not the original.** `sharp` re-encodes every stored image to
 *    WebP at most `IMAGE_MAX_DIM` on its longest edge. The original bytes are already
 *    in the inbox and are not kept here; a multi-megabyte PNG never reaches a 64 px
 *    cell. If an operator wants the original, `storage.log_images` still records a
 *    reference to the unresolved one.
 *  - **Storage never breaks a solve.** Every failure - an unwritable directory, a
 *    full disk, a `sharp` decode error - is logged and swallowed. `save` returns
 *    `null`; the pipeline's own guard is a second layer. This is the same shape as
 *    the rule that a validator rejection never produces a sent answer: the answer
 *    path must not depend on a side feature.
 *  - **The DB row owns the file.** A file is written first and the row inserted
 *    after; if the insert fails the file is unlinked. Pruning removes row and file
 *    together, and reconciles both directions: a file with no row, and a row whose
 *    file is gone, are cleaned up rather than accumulating. The serving route reads
 *    the path from the row and renders a placeholder when the file is missing, so a
 *    vanished file is a 404/placeholder, never a 500.
 *  - **No encryption.** On POSIX the directory is `0700` and the files `0600`. On
 *    Windows `chmod` does nothing, so the protection there is the per-user profile
 *    ACL and nothing more - the README says so rather than implying encryption.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import sharp from 'sharp';

/** Longest edge of the stored copy. 512 px fills a review thumbnail and keeps bytes tiny. */
export const IMAGE_MAX_DIM = 512;
/** How many stored images are kept when the operator does not override the cap. */
export const DEFAULT_MAX_IMAGES = 200;

/** The private data directory the stored copies live in. */
export function defaultImagesDir({ platform = process.platform, env = process.env, homedir: osHome = homedir } = {}) {
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA ?? join(osHome(), 'AppData', 'Local');
    return join(base, 'PuzzleSolver', 'images');
  }
  const base = env.XDG_DATA_HOME ?? join(osHome(), '.local', 'share');
  return join(base, 'puzzlesolver', 'images');
}

/**
 * Build the image store around an open `store` and a directory.
 *
 * @param {object} options
 * @param {object} options.store           the `openStore` handle (owns the `images` table)
 * @param {string} [options.dir]           where the copies live; lazily created on first save
 * @param {number} [options.maxCount]      count cap enforced on every save and prune
 * @param {number} [options.maxDimension]  longest edge of the stored copy
 * @param {object} [options.logger]
 * @param {function} [options.sharpImpl]   injectable for tests
 * @param {function} [options.now]         epoch-seconds clock
 */
export function createImageStore({
  store,
  dir = defaultImagesDir(),
  maxCount = DEFAULT_MAX_IMAGES,
  maxDimension = IMAGE_MAX_DIM,
  retainDays = null,
  logger = null,
  sharpImpl = sharp,
  now = () => Date.now() / 1000,
} = {}) {
  if (!store || typeof store.insertImageRecord !== 'function') {
    throw new Error('createImageStore needs an open store');
  }
  const root = resolve(dir);

  /** Is `candidate` inside the configured directory? Never follow a path from a row blindly. */
  function insideRoot(candidate) {
    const resolved = resolve(candidate);
    return resolved === root || resolved.startsWith(root + sep);
  }

  function unlinkQuietly(path) {
    try {
      unlinkSync(path);
      return true;
    } catch {
      return false;
    }
  }

  function deleteRow(row) {
    unlinkQuietly(row.path);
    store.deleteImageById(row.id);
  }

  /** Reconcile files and rows, then enforce the count cap. Never throws. */
  function pruneInternal({ retainDays = null, maxCount: cap = maxCount } = {}) {
    const result = { removed: 0, byCount: 0, orphans: 0, missing: 0, staleFiles: 0 };
    try {
      let rows = store.imageRows();
      const cutoff =
        Number.isFinite(retainDays) && retainDays >= 0 ? now() - retainDays * 86_400 : null;

      // 1. Age policy, when one applies to this pass.
      for (const row of rows) {
        if (cutoff != null && row.created_at < cutoff) {
          deleteRow(row);
          result.removed += 1;
        }
      }

      // 2. Rows whose solve attempt is gone, and rows whose file is gone. Both are
      //    orphans the issue names; drop the row so the UI never learns a stale path.
      rows = store.imageRows();
      for (const row of rows) {
        if (row.attempt_id != null && !store.attemptExists(row.attempt_id)) {
          deleteRow(row);
          result.orphans += 1;
          continue;
        }
        if (!existsSync(row.path)) {
          store.deleteImageById(row.id);
          result.missing += 1;
        }
      }

      // 3. Count cap: evict oldest until the cap holds. A cap of 0 keeps nothing.
      const limit = Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : Infinity;
      rows = store.imageRows();
      if (rows.length > limit) {
        for (const row of rows.slice(0, rows.length - limit)) {
          deleteRow(row);
          result.byCount += 1;
        }
      }

      // 4. Files with no row (a crash between write and insert, or a manual copy).
      const known = new Set(store.imageRows().map((row) => basename(row.path)));
      for (const name of safeReaddir(root)) {
        if (!known.has(name)) {
          if (unlinkQuietly(join(root, name))) result.staleFiles += 1;
        }
      }
    } catch (err) {
      // Housekeeping must never take the app down.
      logger?.warn?.(`keep_images: prune failed: ${err?.message ?? err}`);
    }
    return result;
  }

  function safeReaddir(path) {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  }

  return {
    dir: root,

    /**
     * Persist a bounded copy for one solve. Returns the image row id, or `null` on
     * any failure. **Never throws** - a store failure is a log line, not a solve error.
     */
    async save({ subject, attemptId = null, imagePath = null, buffer = null } = {}) {
      try {
        // The image must belong to a recorded solve; without the row it is an orphan
        // by construction.
        if (attemptId == null) return null;
        let source = buffer;
        if (!Buffer.isBuffer(source) && imagePath) source = readFileSync(imagePath);
        if (!source) return null;

        mkdirSync(root, { recursive: true, mode: 0o700 });
        try {
          // Best effort on POSIX; a no-op on Windows, where the per-user profile ACL
          // is what actually protects the files. Never claim otherwise.
          chmodSync(root, 0o700);
        } catch {
          // not supported (Windows) or not ours to change
        }

        // One file per solve attempt, so a re-solve cannot overwrite an older image.
        const finalPath = join(root, `solve-${Number(attemptId)}.webp`);
        const info = await sharpImpl(source)
          .rotate()
          .resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 72 })
          .toFile(finalPath);
        try {
          chmodSync(finalPath, 0o600);
        } catch {
          // Windows: chmod is a read-only toggle and does not restrict the ACL.
        }

        const id = store.insertImageRecord({
          subject,
          attemptId,
          path: finalPath,
          mime: 'image/webp',
          width: info?.width ?? null,
          height: info?.height ?? null,
          bytes: info?.size ?? null,
        });
        if (id == null) {
          unlinkQuietly(finalPath);
          throw new Error('the image row could not be written');
        }

        // The count cap and the age window are enforced here as well as at startup,
        // so a long-running listener that never restarts cannot grow without bound.
        pruneInternal({ retainDays, maxCount });
        return id;
      } catch (err) {
        logger?.warn?.(`keep_images: could not store the image for ${subject ?? 'unknown'}: ${err?.message ?? err}`);
        return null;
      }
    },

    /** The absolute path for a known row id, or `null`. The path always comes from the row. */
    pathFor(id) {
      const row = store.imageById(id);
      if (!row) return null;
      if (typeof row.path !== 'string' || !insideRoot(row.path)) return null;
      return row.path;
    },

    /** True when the row exists and its file is present. */
    exists(id) {
      const path = this.pathFor(id);
      return path != null && existsSync(path);
    },

    prune(options = {}) {
      return pruneInternal(options);
    },

    /** Remove every stored image and its row. Returns how many were removed. */
    purge() {
      let removed = 0;
      try {
        for (const row of store.imageRows()) {
          unlinkQuietly(row.path);
          removed += 1;
        }
        store.deleteAllImageRecords();
        // Sweep stray files even when their row was lost.
        for (const name of safeReaddir(root)) {
          if (unlinkQuietly(join(root, name))) removed += 1;
        }
      } catch (err) {
        logger?.warn?.(`keep_images: purge failed: ${err?.message ?? err}`);
      }
      return removed;
    },

    count() {
      return store.countImages();
    },
  };
}
