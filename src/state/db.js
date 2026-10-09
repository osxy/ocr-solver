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

  const current = db.prepare('SELECT v FROM kv WHERE k = ?');
  const upsert = db.prepare(
    'INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'
  );

  const store = {
    db,
    path,

    /** Record one pipeline attempt. Never throws - logging must not break solving. */
    record({ subject, stage, variant = null, psm = null, payload = null, confidence = null, ok = null, ms = null }) {
      try {
        insertAttempt.run(
          String(subject ?? 'unknown'),
          String(stage),
          variant,
          psm,
          encodePayload(payload),
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

    attemptsFor(subject) {
      return selectAttempts.all(String(subject)).map((row) => ({
        ...row,
        payload: row.payload ? safeParse(row.payload) : null,
        ok: row.ok == null ? null : row.ok === 1,
      }));
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
