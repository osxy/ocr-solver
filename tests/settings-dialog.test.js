/**
 * The settings dialog's interactive `test <id>` command (#214).
 *
 * The dialog's parser was `/^test\s+(.+)$/i`, the same ambiguous shape CodeQL flagged in
 * the request parser (#208): `\s+` and `(.+)` both match whitespace, so a line terminator
 * after a long separator run forces the engine to retry every split of the run and the
 * match is O(N^2). `parseTestCommand` replaces it with a one-pass scan.
 *
 * The suite pins three things: the shapes the old pattern accepted, that a hostile answer
 * is rejected promptly, and - because a stopwatch only samples a machine - that the
 * function body carries no quantified whitespace class at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { defaultSettingsDialog, parseTestCommand } from '../src/ui/settings-dialog.js';

test('parseTestCommand keeps the shapes the old pattern accepted (#214)', () => {
  assert.equal(parseTestCommand('test solver.offline_only'), 'solver.offline_only');
  assert.equal(parseTestCommand('TEST solver.offline_only'), 'solver.offline_only', 'the keyword is case-insensitive');
  assert.equal(parseTestCommand('test   solver.offline_only'), 'solver.offline_only', 'several spaces');
  assert.equal(parseTestCommand('test\tsolver.offline_only'), 'solver.offline_only', 'a tab separator');
  assert.equal(parseTestCommand('test solver.offline_only extra'), 'solver.offline_only extra', 'the id runs to the end');
  assert.equal(parseTestCommand('test'), null);
  assert.equal(parseTestCommand('testing x'), null, 'the keyword is the whole word');
  // The old pattern let `(.+)` fall back to a single separator character, so `test   `
  // produced a whitespace-only id that resolved to no setting. The linear scan rejects
  // it outright - the same deliberate narrowing as `tokenMatches(' ', 'Bearer  ')` in
  // http.test.js - and the dialog reports it as an unknown setting either way.
  assert.equal(parseTestCommand('test   '), null, 'a whitespace-only answer names no setting');
  assert.equal(parseTestCommand(' test x'), null, 'a leading separator is not accepted');
  assert.equal(parseTestCommand(''), null);
  assert.equal(parseTestCommand(undefined), null);
  assert.equal(parseTestCommand('1'), null);
});

test('a hostile test-command answer is rejected promptly (#214)', () => {
  // The CodeQL shape: the keyword plus a long run of separators and a final carriage
  // return. `\r` is whitespace that `\s+` matched but `(.+)` cannot, so the old pattern
  // retried every split of the run. At this size the old pattern takes ~20s; the linear
  // scan is O(n).
  const answer = `test${' '.repeat(150_000)}\r`;
  const started = performance.now();
  const id = parseTestCommand(answer);
  const elapsedMs = performance.now() - started;
  assert.equal(id, null, 'a hostile answer must name no setting');
  // Deliberately generous - the linear scan costs ~1-2ms, so a loaded runner would have
  // to be thousands of times slower to trip this, while the quadratic pattern is an
  // order of magnitude over it.
  assert.ok(elapsedMs < 5_000, `hostile answer took ${elapsedMs.toFixed(0)}ms; the parse must stay linear`);
});

test('the test-command parse carries no backtracking regex (#214)', () => {
  // A stopwatch only samples a machine, so it cannot prove linearity. Pin the mechanism
  // instead: the finding was a quantified whitespace class overlapping the id wildcard,
  // so the function body must carry no quantified whitespace class at all. The
  // per-character test lives at module scope as a bare `/\s/`.
  assert.doesNotMatch(String(parseTestCommand), /\\s[+*]/, 'a quantified whitespace class is the backtracking hazard');
});

test('the dialog routes a numeric `test <id>` answer to the editor probe (#214)', async () => {
  let probes = 0;
  const output = [];
  const editor = {
    // A position resolves through `list()`, so the probe is driven without a real setting.
    list: () => [{ id: 'model.api_key', display: '(not set)', restart: false, secret: true, isNew: false }],
    pending: new Map(),
    test: async (id) => {
      probes += 1;
      return { ok: true, detail: `probed ${id}` };
    },
    save: async () => ({ backupPath: null, restartRequired: [], live: [] }),
    set() {},
  };
  const result = await defaultSettingsDialog({
    editor,
    input: Readable.from(['test 1\n', '\n']),
    output: { write: (chunk) => output.push(String(chunk)) && true },
  });
  assert.equal(probes, 1, '`test 1` must reach the editor probe');
  assert.match(output.join(''), /model\.api_key: ok - probed model\.api_key/);
  assert.deepEqual(result, { saved: false, changed: [] });
});
