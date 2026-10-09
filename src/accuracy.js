/**
 * The accuracy metric (M4).
 *
 * This module is the single place a reported number is computed, so the CLI, the
 * tray and the tests cannot disagree about what "accuracy" means.
 *
 * Vocabulary, chosen to keep the honesty of the number visible:
 *   - `seen`      every puzzle in the set;
 *   - `valid`     the pipeline produced an answer that passed its class validator;
 *   - `sentable`  valid **and** corroborated: what the default responder
 *                 (`require_confidence = true`) would actually send. `withheld` is
 *                 the valid-but-uncorroborated difference. These are separate from
 *                 `valid` because a validator-accepted answer can be withheld, and
 *                 counting it as sent overstates the traffic number (issue #49);
 *   - `correct`   the answer matched known ground truth (only counted when the
 *                 fixture carries an `expected` answer);
 *   - `validRate` = valid / seen. This is the literal "% valid answers / puzzles
 *                 seen" from issue #5 and it works without ground truth.
 *   - `sentableRate` = sentable / seen. This is the recorded-traffic headline,
 *                 because it is what would have been sent rather than what passed a
 *                 validator.
 *   - `accuracy`  = correct / gradeable. Ground-truth accuracy; null on real
 *                 traffic, because the store does not know the right answer.
 *   - `failures`  = graded items (`expected != null`) that were wrong. Ungraded
 *                 missing answers are reported as `unresolved` instead, so a solved
 *                 traffic puzzle is never listed as a failure (issue #49).
 *
 * **Provenance is never blended.** Every report groups by `provenance`
 * (`real` | `synthetic` | `derived`) and by `kind` (`image` | `text`). A synthetic
 * corpus measures the pipeline against our own noise model, not the real
 * generator's, so a single combined percentage would be actively misleading.
 * The overall number is printed only alongside its breakdown.
 *
 * `record-corpus.js` can add items whose correct answer is not known yet
 * (`expected: null`). Those items count in `seen` and in `validRate` (an unresolved
 * puzzle was still seen and not answered) but not in `accuracy`; they are listed
 * separately as `pending` so a failure cannot silently vanish from the denominator.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { solveText } from './corpus/build.js';

export const PROVENANCES = Object.freeze(['real', 'synthetic', 'derived']);
export const KINDS = Object.freeze(['image', 'text']);
export const REPORT_VERSION = 1;

function rate(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

/** Summarize a set of outcome rows. Never mutates the rows. */
export function summarize(outcomes) {
  const seen = outcomes.length;
  const valid = outcomes.filter((o) => o.valid).length;
  const correct = outcomes.filter((o) => o.correct).length;
  const confident = outcomes.filter((o) => o.confident).length;
  // `valid` is the validator's verdict; `sentable` is what the default responder
  // (`require_confidence = true`) would actually send: validator-accepted AND
  // corroborated. `withheld` is the difference. The traffic report used to fold the
  // withheld rows into `valid`, so its headline counted answers that were never sent
  // (issue #49). The two are now separate figures, each meaning its own label.
  const sentable = outcomes.filter((o) => o.valid && o.confident).length;
  const withheld = valid - sentable;
  const gradeable = outcomes.filter((o) => o.expected != null).length;
  const pending = outcomes.filter((o) => o.expected == null).length;
  return {
    seen,
    valid,
    correct,
    confident,
    sentable,
    withheld,
    gradeable,
    pending,
    validRate: rate(valid, seen),
    accuracy: rate(correct, gradeable),
    confidentRate: rate(confident, seen),
    sentableRate: rate(sentable, seen),
  };
}

function groupBy(outcomes, key) {
  const map = new Map();
  for (const outcome of outcomes) {
    const value = outcome[key] ?? 'unknown';
    if (!map.has(value)) map.set(value, []);
    map.get(value).push(outcome);
  }
  return Object.fromEntries([...map.entries()].map(([value, rows]) => [value, summarize(rows)]));
}

/**
 * Collapse a winning `method` to the tier the statistics page reports: `tier0`,
 * `model:text`, `model:vision`, or `none`. `tier0` methods carry a class suffix
 * (`tier0:count`); a model method is already the tier name. This is the one place
 * the tier label is derived, so the page cannot invent a fourth spelling.
 */
export function methodTier(method) {
  if (method == null || method === '') return 'none';
  return String(method).startsWith('model:') ? String(method) : 'tier0';
}

/** Build the report object the CLI, the tray and the cache all consume. */
export function buildReport(outcomes, { source = 'corpus', label = null } = {}) {
  // `outcome()` stamps `tier`, but a plain caller (and older cached rows) may only
  // carry `method`; derive the tier here so the by-tier breakdown cannot silently
  // collapse into one bucket.
  const tiered = outcomes.map((o) => (o.tier == null ? { ...o, tier: methodTier(o.method) } : o));
  return {
    version: REPORT_VERSION,
    source,
    label,
    overall: summarize(outcomes),
    byProvenance: groupBy(outcomes, 'provenance'),
    byClass: groupBy(outcomes, 'class'),
    byKind: groupBy(outcomes, 'kind'),
    // How the answer was actually produced: offline Tier 0 vs a model text/vision
    // call. This is the efficiency figure the statistics page surfaces (#64).
    byTier: groupBy(tiered, 'tier'),
    // `failures` means one thing only: a graded item (ground truth known) whose
    // answer was wrong or absent. Recorded traffic has no ground truth, so `correct`
    // is always false there and every row used to be listed as a failure (#49).
    failures: outcomes
      .filter((o) => o.expected != null && !o.correct)
      .map((o) => ({
        id: o.id,
        provenance: o.provenance,
        kind: o.kind,
        class: o.class,
        expected: o.expected,
        answer: o.answer,
        valid: o.valid,
        error: o.error ?? null,
      })),
    // The ungraded counterpart: a recorded puzzle that produced no validator-accepted
    // answer. It is not a "failure" (nothing was known to be wrong); it is unresolved.
    unresolved: outcomes
      .filter((o) => o.expected == null && !o.valid)
      .map((o) => ({
        id: o.id,
        provenance: o.provenance,
        kind: o.kind,
        class: o.class,
        answer: o.answer,
        error: o.error ?? null,
      })),
  };
}

function outcome(item, fields = {}) {
  const method = fields.method ?? null;
  return {
    id: item.id,
    provenance: item.provenance,
    kind: item.kind,
    class: item.class ?? null,
    expected: item.expected ?? null,
    answer: null,
    valid: false,
    correct: false,
    confident: false,
    method,
    tier: methodTier(method),
    transcript: item.transcript ?? null,
    error: null,
    ...fields,
  };
}

/** Run text fixtures through repair -> parse -> Tier 0 -> validate. */
export function runTextCorpus(items) {
  return items.map((item) => {
    try {
      const { solved, validation, normalized } = solveText(item.transcript);
      const answer = solved && validation.ok ? validation.answer : null;
      return outcome(item, {
        answer,
        valid: answer != null,
        correct: item.expected != null && answer != null && String(answer) === String(item.expected),
        confident: Boolean(solved?.confident),
        method: solved?.method ?? null,
        transcript: normalized,
      });
    } catch (err) {
      return outcome(item, { error: String(err?.message ?? err) });
    }
  });
}

/**
 * Run image fixtures through the real pipeline. The worker is passed in so the
 * caller owns its lifetime (one worker for a whole run, not one per image).
 */
export async function runImageCorpus(items, { worker, corpusDir, solveImageImpl, onProgress = null } = {}) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      const result = await solveImageImpl(worker, join(corpusDir, item.file), {});
      const answer = result.answer ?? null;
      const row = outcome(item, {
        answer,
        valid: answer != null,
        correct: item.expected != null && answer != null && String(answer) === String(item.expected),
        confident: Boolean(result.confident),
        method: result.method ?? null,
        transcript: result.transcript ?? null,
      });
      out.push(row);
      onProgress?.(i + 1, items.length, item, row);
    } catch (err) {
      const row = outcome(item, { error: String(err?.message ?? err) });
      out.push(row);
      onProgress?.(i + 1, items.length, item, row);
    }
  }
  return out;
}

/** Run every corpus item, preserving the manifest order in the returned rows. */
export async function runCorpus({ items, worker, corpusDir, solveImageImpl, onProgress = null } = {}) {
  const images = items.filter((i) => i.kind === 'image');
  const texts = items.filter((i) => i.kind === 'text');
  const imageRows = worker
    ? await runImageCorpus(images, { worker, corpusDir, solveImageImpl, onProgress })
    : images.map((item) => outcome(item, { error: 'no OCR worker supplied (--no-images?)' }));
  const textRows = runTextCorpus(texts);
  const byId = new Map([...imageRows, ...textRows].map((row) => [row.id, row]));
  return items.map((item) => byId.get(item.id) ?? outcome(item));
}

/**
 * The full offline report: corpus dimensions plus recorded real traffic.
 * `corpusReport` is null when the caller chose not to run the images.
 */
export function reportBundle({ corpusReport = null, storeReport = null, generatedAt = null } = {}) {
  return { version: REPORT_VERSION, generatedAt, corpus: corpusReport, store: storeReport };
}

/**
 * Accuracy from the recorded `attempts` store - real traffic, whatever exists.
 *
 * There is no ground truth in the store, so this reports `validRate`, not
 * `accuracy`. A subject counts as seen if it produced any pipeline attempt; it is
 * valid if its latest `validate` row was accepted. Subjects with no validate row
 * crashed or were still in flight and correctly count as seen-but-unanswered.
 */
export function storeReport(store, { excludeSubjects = ['circuit-breaker'] } = {}) {
  // Prefer the one-row-per-subject SQL reduction when the store offers it: the old
  // shape called `attemptsFor` for every subject, which is O(subjects x attempts)
  // and the wrong thing to run behind a page that reloads (#64). The fallback keeps
  // a store double that only implements the documented read surface working.
  const rows = typeof store.latestValidationRows === 'function'
    ? store.latestValidationRows()
    : (typeof store.subjects === 'function'
        ? store.subjects()
        : store.db.prepare('SELECT DISTINCT subject FROM attempts').all().map((r) => r.subject)
      ).map((subject) => {
        const validate = store.attemptsFor(subject).filter((r) => r.stage === 'validate').at(-1);
        return { subject, payload: validate?.payload ?? {}, ok: Boolean(validate?.ok) };
      });

  const outcomes = [];
  for (const row of rows) {
    if (excludeSubjects.includes(row.subject)) continue;
    const payload = row.payload ?? {};
    outcomes.push({
      id: row.subject,
      provenance: 'real',
      kind: 'traffic',
      class: payload.class ?? null,
      expected: null,
      answer: payload.answer ?? null,
      valid: Boolean(row.ok),
      correct: false,
      confident: Boolean(payload.confident),
      method: payload.method ?? null,
      tier: methodTier(payload.method ?? null),
      error: null,
    });
  }
  return buildReport(outcomes, { source: 'attempts' });
}

/**
 * The recent solves the statistics page lists, newest first and bounded.
 *
 * Each row is the raw stored verdict plus the fields `formatSolveResponse` consumes,
 * so the page renders the same answer/method/confidence/reason the solve page shows
 * rather than a second interpretation of the same payload (#64, #65).
 */
export function storeRecentSolves(store, { limit = 5 } = {}) {
  if (typeof store.recentSolves !== 'function') return [];
  return store.recentSolves(limit).map((row) => {
    const payload = row.payload ?? {};
    const method = payload.method ?? null;
    return {
      subject: row.subject,
      at: row.created_at,
      answer: payload.answer ?? null,
      method,
      tier: methodTier(method),
      confident: payload.confident === true,
      puzzleClass: payload.class ?? null,
      disputed: payload.disputed === true,
      // The pipeline records each solve's own wall time on its validate row. A row
      // without it (an older row, or a caller that never timed a solve) reports
      // `null`, which the page renders as "unknown" rather than inventing a span.
      ms: row.ms == null ? null : Number(row.ms),
      // The Pushbullet responder's own verdict, when one was recorded. HTTP and CLI
      // solves have no responder row, so `null` means "not recorded", not "not sent".
      sent: row.respond ? row.respond.sent === true : null,
      respondReason: row.respond?.reason ?? null,
      // The stored review copy's row id, if the operator enabled `storage.keep_images`
      // (#100). The page turns this into a thumbnail through the gated `/images/:id`
      // route; `null` means no image was stored for this solve.
      imageId: row.image_id == null ? null : Number(row.image_id),
    };
  });
}

/**
 * The recorded-traffic report plus the model-call count. It reuses `storeReport`, so
 * the totals are the same numbers the tray and the accuracy CLI report, not a second
 * implementation. The model-call count is a SQL aggregate over the model stages, not
 * a read of every payload.
 */
export function storeStats(store, { excludeSubjects = ['circuit-breaker'] } = {}) {
  const traffic = storeReport(store, { excludeSubjects });
  const stageCounts = typeof store.stageCounts === 'function' ? store.stageCounts() : {};
  const modelCalls = (stageCounts['model-text'] ?? 0) + (stageCounts['model-vision'] ?? 0);
  return { traffic, modelCalls, stageCounts };
}

// ---------------------------------------------------------------------------
// Manifest loading and the tray cache
// ---------------------------------------------------------------------------

/**
 * Read the corpus manifest and refuse a malformed one.
 *
 * A mislabelled item is exactly how synthetic data swamps the real number, so an
 * unknown provenance is a hard error rather than a default.
 */
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.items)) {
    throw new Error('corpus manifest must be an object with an items array');
  }
  const ids = new Set();
  for (const item of manifest.items) {
    if (!item.id || typeof item.id !== 'string') throw new Error('corpus item without a string id');
    if (ids.has(item.id)) throw new Error(`duplicate corpus item id: ${item.id}`);
    ids.add(item.id);
    if (!PROVENANCES.includes(item.provenance)) {
      throw new Error(`corpus item ${item.id} has unknown provenance ${JSON.stringify(item.provenance)}`);
    }
    if (!KINDS.includes(item.kind)) {
      throw new Error(`corpus item ${item.id} has unknown kind ${JSON.stringify(item.kind)}`);
    }
    if (item.kind === 'image' && !item.file) throw new Error(`image corpus item ${item.id} has no file`);
    if (item.expected != null && typeof item.expected !== 'string') {
      throw new Error(`corpus item ${item.id} expected must be a string or null`);
    }
  }
  return manifest;
}

export function loadManifest(corpusDir) {
  const manifest = JSON.parse(readFileSync(join(corpusDir, 'manifest.json'), 'utf8'));
  return validateManifest(manifest);
}

/**
 * The committed manifest plus anything `record-corpus.js` has saved. Recorded
 * entries are kept in their own file so regenerating the corpus never deletes a
 * hard-won failure.
 */
export function loadCorpusItems(corpusDir) {
  const base = loadManifest(corpusDir).items;
  const recordedPath = join(corpusDir, 'recorded', 'manifest.json');
  if (!existsSync(recordedPath)) return validateManifest({ items: [...base] }).items;
  const recorded = JSON.parse(readFileSync(recordedPath, 'utf8'));
  const extra = Array.isArray(recorded) ? recorded : recorded.items ?? [];
  return validateManifest({ items: [...base, ...extra] }).items;
}

/** Save the corpus report where the tray can read it without re-running OCR. */
export function saveReportCache(cachePath, bundle) {
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(bundle, null, 2));
  return cachePath;
}

export function loadReportCache(cachePath) {
  if (!cachePath || !existsSync(cachePath)) return null;
  try {
    return JSON.parse(readFileSync(cachePath, 'utf8'));
  } catch {
    return null;
  }
}

export function defaultAccuracyCachePath(statePath) {
  return join(dirname(statePath), 'accuracy.json');
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function percent(value, digits = 1) {
  return value == null ? 'n/a' : `${(value * 100).toFixed(digits)}%`;
}

/** One compact line per summary, used by the accuracy CLI and `formatReport`. */
export function formatSummary(summary) {
  return (
    `${summary.correct}/${summary.gradeable} correct (${percent(summary.accuracy)}), ` +
    `${summary.valid}/${summary.seen} valid (${percent(summary.validRate)}), ` +
    `${summary.sentable}/${summary.seen} sent-able (${percent(summary.sentableRate)})`
  );
}

export function formatReport(report) {
  if (!report) return 'no report';
  const lines = [];
  lines.push(`${report.label ?? report.source}: ${formatSummary(report.overall)}  [seen ${report.overall.seen}]`);
  const section = (title, group) => {
    const entries = Object.entries(group ?? {});
    if (entries.length === 0) return;
    lines.push(`  ${title}`);
    for (const [name, summary] of entries.sort()) {
      lines.push(`    ${name.padEnd(14)} ${formatSummary(summary).padEnd(58)} seen=${summary.seen}`);
    }
  };
  section('by provenance', report.byProvenance);
  section('by kind', report.byKind);
  section('by class', report.byClass);
  if (report.failures.length) {
    lines.push(`  failures, graded (${report.failures.length})`);
    for (const f of report.failures.slice(0, 20)) {
      lines.push(
        `    ${String(f.id).padEnd(34)} class=${String(f.class).padEnd(13)} ` +
        `want=${String(f.expected).padEnd(10)} got=${f.answer ?? '-'}${f.error ? `  error=${f.error}` : ''}`
      );
    }
    if (report.failures.length > 20) lines.push(`    ... and ${report.failures.length - 20} more`);
  }
  // Ungraded unresolved traffic: no ground truth, so it is reported separately from
  // the graded failures rather than silently inflating them.
  if (report.unresolved?.length) {
    lines.push(`  unresolved (${report.unresolved.length})`);
    for (const u of report.unresolved.slice(0, 20)) {
      lines.push(
        `    ${String(u.id).padEnd(34)} class=${String(u.class).padEnd(13)} got=${u.answer ?? '-'}${u.error ? `  error=${u.error}` : ''}`
      );
    }
    if (report.unresolved.length > 20) lines.push(`    ... and ${report.unresolved.length - 20} more`);
  }
  return lines.join('\n');
}

/** The tray's one-line, human-readable form. */
export function formatTray(bundle) {
  if (!bundle) return null;
  const parts = [];
  if (bundle.corpus?.overall) parts.push(`corpus ${percent(bundle.corpus.overall.accuracy)}`);
  if (bundle.store?.overall) {
    const store = bundle.store.overall;
    // The traffic headline is what would actually be sent, not every validator-accepted
    // answer: a confident:false answer under `require_confidence` was withheld (#49).
    // Fall back to validRate for a cache written before the split.
    parts.push(
      store.sentableRate != null
        ? `traffic ${percent(store.sentableRate)} sent-able`
        : `traffic ${percent(store.validRate)} valid`
    );
  }
  return parts.length ? parts.join(' · ') : null;
}
