/**
 * The synthetic solve history behind `npm run screenshots` (issue #92), extracted from
 * `scripts/screenshots.mjs` so the offline suite can assert that the fixture is a pure
 * function of a **fixed** clock without a browser. The capture itself needs Firefox and
 * is therefore not testable in CI; the fixture is.
 *
 * Every timestamp here derives from `FIXTURE_NOW`, never from the real clock. The first
 * version seeded the history relative to `Date.now()`, so every regeneration produced a
 * byte-different `statistics.png` / `statistics-dark.png` and a real UI change was
 * indistinguishable from clock noise (#114). `solve.png` is the one committed image that
 * still differs on re-run: it shows a genuine solve with its genuine recorded duration,
 * which is a property of the run rather than of the fixture. See
 * `docs/screenshots/README.md`.
 *
 * The subjects are `demo/...` names, never a Pushbullet iden, and every answer and timing
 * is invented: a committed image must not carry anything real.
 */
export const FIXTURE_NOW = Math.floor(Date.UTC(2025, 0, 15, 12, 0, 0) / 1000);

/**
 * The ordered `store.record(...)` operations for the fixture, each paired with the clock
 * value it is recorded at. Pure: `buildHistory(now)` returns the same plan for the same
 * `now` and consults no ambient time source (proved by
 * `tests/screenshots-fixture.test.js`, which freezes `Date.now` at a far-future instant).
 */
export function buildHistory(now = FIXTURE_NOW) {
  const base = Math.floor(now) - 6 * 3600;
  const rows = [
    { subject: 'demo/001-count-kleuren.png', answer: '2', method: 'tier0:count', klass: 'count', confident: true, ms: 1180, at: base, respond: { sent: true } },
    { subject: 'demo/003-arithmetic-acht-min-een.png', answer: '7', method: 'tier0:arithmetic', klass: 'arithmetic', confident: true, ms: 940, at: base + 1800, respond: { sent: true } },
    { subject: 'demo/002-ordinal-lichaamsdeel.png', answer: 'derde', method: 'model:text', klass: 'ordinal', confident: true, ms: 6120, at: base + 3600, respond: { sent: true } },
    { subject: 'demo/needs-model-001.png', answer: null, method: null, klass: 'unknown', confident: false, ms: 8420, at: base + 5400, respond: { sent: false, reason: 'no tier produced a valid answer' } },
    { subject: 'demo/needs-model-004.png', answer: 'Amsterdam', method: 'model:vision', klass: 'unknown', confident: true, ms: 15340, at: base + 7200, respond: { sent: true } },
    { subject: 'demo/005-count-vruchten.png', answer: '4', method: 'tier0:count', klass: 'count', confident: true, ms: 1020, at: base + 9000, respond: null },
    // #104: a withheld candidate, so the screenshot shows all three outcomes
    // (solved, withheld, unresolved) and the mistake is visible if one regresses.
    { subject: 'demo/007-ordinal-kleur.png', answer: 'rood', method: 'model:text', klass: 'ordinal', confident: false, ms: 4800, at: base + 10800, respond: { sent: false, reason: 'unconfirmed' } },
  ];

  const ops = [];
  for (const row of rows) {
    ops.push({
      at: row.at,
      entry: {
        subject: row.subject,
        stage: 'validate',
        payload: { answer: row.answer, method: row.method, class: row.klass, confident: row.confident, disputed: false },
        ok: row.answer != null,
        ms: row.ms,
      },
    });
    if (row.respond) {
      ops.push({ at: row.at + 1, entry: { subject: row.subject, stage: 'respond', payload: row.respond } });
    }
  }

  // Two model stages so the page's "model calls made" figure is not zero.
  ops.push({ at: base + 3600, entry: { subject: 'demo/002-ordinal-lichaamsdeel.png', stage: 'model-text', variant: 'openrouter/auto', payload: { ok: true } } });
  ops.push({ at: base + 7200, entry: { subject: 'demo/needs-model-004.png', stage: 'model-vision', variant: '~google/gemini-flash-latest', payload: { ok: true } } });
  return ops;
}
