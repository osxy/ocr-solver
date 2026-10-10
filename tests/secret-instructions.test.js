/**
 * Guards the instructions the runtime gives for setting a secret (issue #172).
 *
 * The "no Pushbullet token found" message told a stuck user to hand-write the
 * plaintext migration file, never named `config set`, and mentioned PUSHBULLET_TOKEN
 * without the persistent-variable caveat that makes it reach the logon task. That is
 * the same shape as #144's DESIGN.md guard: an instruction naming something that does
 * not work. Both halves run offline:
 *
 *   1. every literal `config set <id>` any source string suggests names a setting in
 *      `SETTINGS` (src/ui/settings.js) - a typo, or an id that was removed from the
 *      registry, fails here with the offending file and id;
 *   2. no source string presents `credentials.json` / `credentialPath` as a route -
 *      a migration mention with no route verb is allowed, which is exactly how
 *      docs/configuration.md labels the legacy file.
 *
 * The source is flattened (`+` concatenations joined, whitespace collapsed) so a
 * message split across lines is checked as one string. The `credentialPath` variable
 * is checked as well as the filename: the old defect interpolated the variable rather
 * than spelling `credentials.json`, so a filename-only scan would have missed it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SETTINGS } from '../src/ui/settings.js';
import { WEB_UI_CREDENTIAL_SETTING } from '../src/ui/access.js';

const repoRoot = join(import.meta.dirname, '..');

function walkJs(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJs(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = walkJs(join(repoRoot, 'src'));

/** Join string concatenations and collapse whitespace so messages are one line. */
function flatten(file) {
  return readFileSync(file, 'utf8').replace(/\s*\+\s*/g, ' ').replace(/\s+/g, ' ');
}

const settingIds = new Set(SETTINGS.map((setting) => setting.id));

test('every `config set <id>` a source message suggests names a setting in SETTINGS (#172)', () => {
  const suggested = [];
  for (const file of files) {
    for (const match of flatten(file).matchAll(/config set ([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)/g)) {
      suggested.push({ file: file.slice(repoRoot.length + 1), id: match[1] });
    }
  }
  assert.ok(
    suggested.length >= 4,
    `the guard found only ${suggested.length} \`config set\` suggestions; the extractor is broken, not the messages`
  );

  const problems = suggested.filter((s) => !settingIds.has(s.id)).map((s) => `${s.file}: config set ${s.id}`);
  assert.deepEqual(
    problems,
    [],
    `a message suggests a setting that is not in SETTINGS (src/ui/settings.js), so the editor and \`config set\` cannot change it:\n${problems.join('\n')}`
  );
});

test('the web UI credential a message suggests is a registered setting (#172)', () => {
  assert.ok(
    settingIds.has(WEB_UI_CREDENTIAL_SETTING),
    `${WEB_UI_CREDENTIAL_SETTING} is suggested by a message but is absent from SETTINGS`
  );
});

test('no source message presents credentials.json as a way to configure a secret (#172)', () => {
  const problems = [];
  for (const file of files) {
    const re = /(add|write|put|paste|hand-?write)\b[^.;]{0,120}?(credentialPath|credentials\.json)/gi;
    for (const match of flatten(file).matchAll(re)) {
      problems.push(`${file.slice(repoRoot.length + 1)}: "${match[0]}"`);
    }
  }
  assert.deepEqual(
    problems,
    [],
    `a message routes the user to the plaintext migration file instead of the credential store:\n${problems.join('\n')}`
  );
});
