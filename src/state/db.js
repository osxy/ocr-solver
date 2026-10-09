/**
 * State store, on Node's built-in `node:sqlite` (no dependency).
 *
 * The `attempts` table is the debugging backbone of the whole app: it records every
 * OCR variant, every model sample and every validation outcome. When a puzzle is
 * answered wrongly, the question "which stage was wrong?" is answered by reading
 * this table instead of re-running anything or guessing.
 *
 * The `pushes` and `outbox` tables are created now but only used from M2 onward.
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
  const pendingOutbox = db.prepare('SELECT * FROM outbox WHERE sent_at IS NULL ORDER BY push_iden');

  // Retention. `attempts` hold puzzle transcripts and model replies, which are the
  // rows with privacy value, so they are bounded by age. `pushes` and `outbox` are
  // deliberately NOT pruned: they are the durable dedupe and duplicate-send guards,
  // and deleting either risks answering a puzzle twice - a strictly worse outcome
  // than keeping a row that contains no secret and no image (DESIGN 8).
  const deleteOldAttempts = db.prepare('DELETE FROM attempts WHERE created_at < ?');

  const store = {
    db,
    path,

    /** Record one pipeline attempt. Never throws - logging must not break solving. */
    record({ subject, stage, variant = null, psm = null, payload = null, confidence = null, ok = null, ms = null }) {
      try {
        insertAttempt.run(
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
        return true;
      } catch {
        return false;
      }
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

    countSentSince(epochSeconds) {
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
