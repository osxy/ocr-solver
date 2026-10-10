/**
 * State store, on Node's built-in `node:sqlite` (no dependency).
 *
 * The `attempts` table is the debugging backbone of the whole app: it records every
 * OCR variant, every model sample and every validation outcome. When a puzzle is
 * answered wrongly, the question "which stage was wrong?" is answered by reading
 * this table instead of re-running anything or guessing.
 *
 * The `pushes` and `outbox` tables are created now but only used from M2 onward.
 *
 * `node:sqlite` is unflagged from Node 22.13.0 but still emits
 * `ExperimentalWarning: SQLite is an experimental feature ...` on import. That warning is
 * left alone deliberately: the module really is experimental, the message is accurate,
 * and suppressing it narrowly (`--disable-warning=ExperimentalWarning`) would also hide
 * experimental warnings from every other feature. A console run shows it; the packaged
 * app launches without a console via `PuzzleSolver.vbs`, so it is not user-visible there.
 * `tests/config-cli.test.js` filters it out of the runtime's stderr, not the app's output.
 */
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { redactRecord } from '../redact.js';

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pushes (
  iden TEXT PRIMARY KEY,
  created REAL, modified REAL,
  type TEXT, file_name TEXT, file_url TEXT,
  status TEXT,
  created_at REAL, updated_at REAL
);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,      -- push iden, or the image name for CLI runs
  stage TEXT NOT NULL,        -- preprocess | ocr | tier0 | model-text | model-vision | validate | respond
  variant TEXT,               -- preprocessing preset or model name
  psm TEXT,
  payload TEXT,               -- JSON blob: transcript, answer, raw model reply, ...
  confidence REAL,
  ok INTEGER,                 -- 1 accepted, 0 rejected, NULL not a judgement
  ms INTEGER,
  created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_subject ON attempts (subject);
-- The statistics page lists the most recent solves, newest first, bounded by a LIMIT.
-- The only index was on subject, so ordering by created_at would have scanned the
-- whole table and sorted it on every page load (#64).
CREATE INDEX IF NOT EXISTS idx_attempts_created_at ON attempts (created_at);

CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,        -- the solve's subject, for diagnostics
  attempt_id INTEGER,           -- the validate attempt row that owns this image
  path TEXT NOT NULL,           -- absolute path of the bounded review copy
  mime TEXT NOT NULL,           -- fixed by the encoder, never the request
  width INTEGER, height INTEGER,
  bytes INTEGER,
  created_at REAL NOT NULL
);
-- The recent-solves query joins an image to its validate row by attempt_id, one
-- image per solve. The created_at index is what the retention prune walks.
CREATE INDEX IF NOT EXISTS idx_images_attempt ON images (attempt_id);
CREATE INDEX IF NOT EXISTS idx_images_created_at ON images (created_at);

CREATE TABLE IF NOT EXISTS outbox (
  push_iden TEXT,
  answer_hash TEXT,
  sent_at REAL,
  response TEXT,
  PRIMARY KEY (push_iden, answer_hash)
);

CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
`;

/**
 * Turn a Pushbullet push into the columns the `pushes` table keeps, keeping the
 * raw fields the fetcher and the responder need later (file_url, file_name).
 */
function pushRow(push, status, at) {
  return [
    String(push.iden),
    push.created == null ? null : Number(push.created),
    push.modified == null ? null : Number(push.modified),
    push.type ?? null,
    push.file_name ?? null,
    push.file_url ?? null,
    status,
    at,
    at,
  ];
}

/** Turn an arbitrary payload into a storable string without ever throwing. */
function encodePayload(payload) {
  if (payload == null) return null;
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return JSON.stringify({ unserialisable: String(payload) });
  }
}

export function openStore({ path = ':memory:', now = () => Date.now() / 1000 } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);

  const insertAttempt = db.prepare(`
    INSERT INTO attempts (subject, stage, variant, psm, payload, confidence, ok, ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectAttempts = db.prepare('SELECT * FROM attempts WHERE subject = ? ORDER BY id');
  const selectSubjects = db.prepare('SELECT DISTINCT subject FROM attempts ORDER BY subject');

  // The statistics page's reads. Both are bounded by construction: the recent list
  // carries a LIMIT, and the per-subject work is a correlated subquery against the
  // `subject` index rather than a JS loop over every attempt (#64).
  const selectRecentSolves = db.prepare(`
    SELECT v.id AS attempt_id, v.subject, v.created_at, v.payload, v.ok, v.ms,
      (SELECT r.payload FROM attempts r
        WHERE r.subject = v.subject AND r.stage = 'respond'
        ORDER BY r.id DESC LIMIT 1) AS respond_payload,
      i.id AS image_id
    FROM attempts v
    LEFT JOIN images i ON i.attempt_id = v.id
    WHERE v.stage = 'validate'
    ORDER BY v.created_at DESC, v.id DESC
    LIMIT ?
  `);
  // One row per subject: the latest validate row, aggregated in SQL rather than by
  // reading every attempt for every subject (`storeReport`'s old N+1 shape).
  const selectLatestValidation = db.prepare(`
    SELECT a.subject, a.payload, a.ok
    FROM attempts a
    JOIN (SELECT subject, MAX(id) AS id FROM attempts WHERE stage = 'validate' GROUP BY subject) m
      ON a.id = m.id
    ORDER BY a.subject
  `);
  const selectStageCounts = db.prepare('SELECT stage, COUNT(*) AS n FROM attempts GROUP BY stage');

  const current = db.prepare('SELECT v FROM kv WHERE k = ?');
  const upsert = db.prepare(
    'INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'
  );

  // `ON CONFLICT DO NOTHING` + the returned `changes` is the durable dedupe: the
  // first caller wins, every later caller (including after a restart) sees 0 rows
  // changed and knows the push is already claimed. An in-memory Set cannot do that.
  const insertPush = db.prepare(`
    INSERT INTO pushes (iden, created, modified, type, file_name, file_url, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(iden) DO NOTHING
  `);
  const selectPush = db.prepare('SELECT * FROM pushes WHERE iden = ?');
  const updatePushStatus = db.prepare('UPDATE pushes SET status = ?, updated_at = ? WHERE iden = ?');
  const countPushes = db.prepare('SELECT COUNT(*) AS n FROM pushes');

  // Insert-before-send idempotency. sent_at stays NULL until delivery succeeded, so
  // "claimed but never sent" is visible rather than indistinguishable from sent.
  const insertOutbox = db.prepare(`
    INSERT INTO outbox (push_iden, answer_hash, sent_at, response)
    VALUES (?, ?, NULL, NULL)
    ON CONFLICT(push_iden, answer_hash) DO NOTHING
  `);
  const selectOutbox = db.prepare('SELECT * FROM outbox WHERE push_iden = ? AND answer_hash = ?');
  const selectOutboxForPush = db.prepare('SELECT * FROM outbox WHERE push_iden = ? ORDER BY sent_at');
  const markSent = db.prepare(
    'UPDATE outbox SET sent_at = ?, response = ? WHERE push_iden = ? AND answer_hash = ?'
  );
  const markResponse = db.prepare(
    'UPDATE outbox SET response = ? WHERE push_iden = ? AND answer_hash = ?'
  );
  const lastSent = db.prepare('SELECT MAX(sent_at) AS t FROM outbox WHERE sent_at IS NOT NULL');
  const sentSince = db.prepare(
    'SELECT COUNT(*) AS n FROM outbox WHERE sent_at IS NOT NULL AND sent_at >= ?'
  );
  // Answer and acknowledgement budgets share one table but not one counter (#48).
  // The marker is a caller-supplied string so the store stays unaware of the
  // responder's literal; it only knows how to include or exclude one hash.
  const sentSinceExcludingHash = db.prepare(
    'SELECT COUNT(*) AS n FROM outbox WHERE sent_at IS NOT NULL AND sent_at >= ? AND answer_hash != ?'
  );
  const sentSinceOnlyHash = db.prepare(
    'SELECT COUNT(*) AS n FROM outbox WHERE sent_at IS NOT NULL AND sent_at >= ? AND answer_hash = ?'
  );
  const pendingOutbox = db.prepare('SELECT * FROM outbox WHERE sent_at IS NULL ORDER BY push_iden');

  // Retention. `attempts` hold puzzle transcripts and model replies, which are the
  // rows with privacy value, so they are bounded by age. `pushes` and `outbox` are
  // deliberately NOT pruned: they are the durable dedupe and duplicate-send guards,
  // and deleting either risks answering a puzzle twice - a strictly worse outcome
  // than keeping a row that contains no secret and no image (DESIGN 8).
  const deleteOldAttempts = db.prepare('DELETE FROM attempts WHERE created_at < ?');
  const selectAttemptExists = db.prepare('SELECT 1 AS present FROM attempts WHERE id = ?');

  // Image metadata. Files are the image store's business; these rows are the durable
  // record that a file was written, so an orphan (a file with no row, or a row whose
  // file is gone) can be reconciled rather than silently accumulated.
  const insertImage = db.prepare(`
    INSERT INTO images (subject, attempt_id, path, mime, width, height, bytes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectImage = db.prepare('SELECT * FROM images WHERE id = ?');
  const selectAllImages = db.prepare('SELECT * FROM images ORDER BY id');
  const countImages = db.prepare('SELECT COUNT(*) AS n FROM images');
  const deleteImageById = db.prepare('DELETE FROM images WHERE id = ?');
  const deleteAllImages = db.prepare('DELETE FROM images');

  // The most recent attempt row's id, captured by `record`. The pipeline reads it
  // right after recording the validate row, so the review copy can be tied to the
  // exact solve it belongs to (a subject can be solved more than once).
  let lastAttemptId = null;

  const store = {
    db,
    path,

    /** Record one pipeline attempt. Never throws - logging must not break solving. */
    record({ subject, stage, variant = null, psm = null, payload = null, confidence = null, ok = null, ms = null }) {
      try {
        // Reset first, so a failed insert cannot leave the previous attempt's id and
        // cause an image to be attached to the wrong solve.
        lastAttemptId = null;
        const result = insertAttempt.run(
          String(subject ?? 'unknown'),
          String(stage),
          // Redaction happens at the sink, not at the call site: a caller cannot
          // forget it, and an upstream error body is covered too.
          variant == null ? null : redactRecord(String(variant)),
          psm,
          payload == null ? null : redactRecord(encodePayload(payload)),
          confidence == null ? null : Number(confidence),
          ok == null ? null : ok ? 1 : 0,
          ms == null ? null : Math.round(ms),
          now()
        );
        lastAttemptId = Number(result.lastInsertRowid);
        return true;
      } catch {
        return false;
      }
    },

    /**
     * The id of the most recently recorded attempt row, or `null`. The pipeline uses
     * it to attach an image to the validate row it just wrote; it is a read of a
     * value `record` captured, never a second insert. Deliberately not a return value
     * of `record`: the boolean `true`/`false` contract is asserted by existing tests.
     */
    lastAttemptId() {
      return lastAttemptId;
    },

    /** True when the attempt row still exists; used to reconcile image orphans. */
    attemptExists(id) {
      const n = Number(id);
      if (!Number.isInteger(n)) return false;
      return selectAttemptExists.get(n) != null;
    },

    /**
     * Delete `attempts` older than `retainDays`. Returns the number removed.
     * `now` may be overridden so the retention window is testable without waiting.
     */
    pruneAttempts({ retainDays, now: clock = now } = {}) {
      if (!Number.isFinite(retainDays) || retainDays < 0) return 0;
      try {
        const cutoff = clock() - retainDays * 86_400;
        return Number(deleteOldAttempts.run(cutoff).changes);
      } catch {
        return 0;
      }
    },

    attemptsFor(subject) {
      return selectAttempts.all(String(subject)).map((row) => ({
        ...row,
        payload: row.payload ? safeParse(row.payload) : null,
        ok: row.ok == null ? null : row.ok === 1,
      }));
    },

    /**
     * The last `limit` validate rows, newest first, with the recorded responder
     * verdict and the solve's own recorded duration (`ms`, set by the pipeline on the
     * validate row). A single bounded query: the LIMIT is the only thing standing
     * between a page load and the whole table (#64).
     */
    recentSolves(limit) {
      const n = Number(limit);
      if (!Number.isFinite(n) || n <= 0) return [];
      return selectRecentSolves.all(Math.floor(n)).map((row) => ({
        attempt_id: row.attempt_id == null ? null : Number(row.attempt_id),
        subject: row.subject,
        created_at: row.created_at,
        payload: row.payload ? safeParse(row.payload) : null,
        ok: row.ok == null ? null : row.ok === 1,
        ms: row.ms == null ? null : Number(row.ms),
        respond: row.respond_payload ? safeParse(row.respond_payload) : null,
        // The image row joined to this solve, if one was stored. `null` for a solve
        // that predates image storage or had it turned off.
        image_id: row.image_id == null ? null : Number(row.image_id),
      }));
    },

    /** Insert an image row. Returns the new id, or `null` if the write failed. */
    insertImageRecord({ subject, attemptId = null, path, mime = 'image/webp', width = null, height = null, bytes = null }) {
      try {
        const result = insertImage.run(
          String(subject ?? 'unknown'),
          attemptId == null ? null : Number(attemptId),
          String(path),
          String(mime),
          width == null ? null : Number(width),
          height == null ? null : Number(height),
          bytes == null ? null : Number(bytes),
          now()
        );
        return Number(result.lastInsertRowid);
      } catch {
        return null;
      }
    },

    imageById(id) {
      const n = Number(id);
      if (!Number.isInteger(n)) return null;
      return selectImage.get(n) ?? null;
    },

    /** Every image row, oldest first. The image store reconciles files against these. */
    imageRows() {
      return selectAllImages.all().map((row) => ({
        ...row,
        id: Number(row.id),
        attempt_id: row.attempt_id == null ? null : Number(row.attempt_id),
        width: row.width == null ? null : Number(row.width),
        height: row.height == null ? null : Number(row.height),
        bytes: row.bytes == null ? null : Number(row.bytes),
        created_at: Number(row.created_at),
      }));
    },

    deleteImageById(id) {
      return Number(deleteImageById.run(Number(id)).changes);
    },

    deleteAllImageRecords() {
      return Number(deleteAllImages.run().changes);
    },

    countImages() {
      return Number(countImages.get().n);
    },

    /**
     * The latest validate row for every subject (one row each), for the totals.
     * SQL does the per-subject reduction; the caller only summarizes the rows.
     */
    latestValidationRows() {
      return selectLatestValidation.all().map((row) => ({
        subject: row.subject,
        payload: row.payload ? safeParse(row.payload) : null,
        ok: row.ok == null ? null : row.ok === 1,
      }));
    },

    /** Rows per stage, so the page can count model calls without reading payloads. */
    stageCounts() {
      return Object.fromEntries(selectStageCounts.all().map((row) => [row.stage, Number(row.n)]));
    },

    /** Every subject with at least one recorded attempt, for accuracy reporting. */
    subjects() {
      return selectSubjects.all().map((row) => row.subject);
    },

    get(k, fallback = null) {
      const row = current.get(k);
      return row ? row.v : fallback;
    },

    set(k, v) {
      upsert.run(k, String(v));
    },

    countAttempts() {
      return db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n;
    },

    /**
     * Claim a push exactly once. Returns true when this call created the row,
     * false when the push was already seen (duplicate tickle, replayed stream
     * message, or a restart re-reading the same history).
     */
    claimPush(push, { status = 'new' } = {}) {
      const result = insertPush.run(...pushRow(push, status, now()));
      return Number(result.changes) > 0;
    },

    getPush(iden) {
      return selectPush.get(String(iden)) ?? null;
    },

    setPushStatus(iden, status) {
      updatePushStatus.run(String(status), now(), String(iden));
    },

    countPushes() {
      return countPushes.get().n;
    },

    /**
     * Claim the right to send one answer for one push. The row is inserted
     * *before* the network call; `sent_at` is filled in afterwards by
     * `markOutboxSent`. A crash in between therefore loses the note but can never
     * send it twice, which is the trade the design deliberately makes.
     */
    claimOutbox(pushIden, answerHash) {
      const result = insertOutbox.run(String(pushIden), String(answerHash));
      return Number(result.changes) > 0;
    },

    getOutbox(pushIden, answerHash) {
      return selectOutbox.get(String(pushIden), String(answerHash)) ?? null;
    },

    outboxFor(pushIden) {
      return selectOutboxForPush.all(String(pushIden));
    },

    markOutboxSent(pushIden, answerHash, { response = null } = {}) {
      const text = response == null ? null : redactRecord(encodePayload(response)).slice(0, 2000);
      markSent.run(now(), text, String(pushIden), String(answerHash));
    },

    /** Record why a claimed delivery has no `sent_at`: the note is not retried. */
    noteOutboxError(pushIden, answerHash, error) {
      const payload = { error: String(error?.message ?? error) };
      markResponse.run(redactRecord(encodePayload(payload)).slice(0, 2000), String(pushIden), String(answerHash));
    },

    lastSentAt() {
      const row = lastSent.get();
      return row?.t == null ? null : Number(row.t);
    },

    /**
     * Count sent rows since `epochSeconds`.
     *
     * With no options every send counts, which is the original behaviour and what
     * `lastSentAt`-style callers expect. `excludeHash` removes one category - the
     * answer budget must not count acknowledgements - and `onlyHash` counts exactly
     * one category, which is how the acknowledgement budget is bounded separately.
     */
    countSentSince(epochSeconds, { excludeHash = null, onlyHash = null } = {}) {
      if (onlyHash != null) return sentSinceOnlyHash.get(Number(epochSeconds), String(onlyHash)).n;
      if (excludeHash != null) return sentSinceExcludingHash.get(Number(epochSeconds), String(excludeHash)).n;
      return sentSince.get(Number(epochSeconds)).n;
    },

    /** Claims that were taken but never delivered - useful when debugging silence. */
    pendingOutbox() {
      return pendingOutbox.all();
    },

    close() {
      try {
        db.close();
      } catch {
        // already closed
      }
    },
  };

  store.set('schema_version', SCHEMA_VERSION);
  return store;
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** A store that keeps everything in memory and discards it - used by tests. */
export function memoryStore(options = {}) {
  return openStore({ ...options, path: ':memory:' });
}
