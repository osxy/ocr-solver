/**
 * Prove the *constructed* opener command from the shipped artifact, on Windows.
 *
 * This is run by `packaging/run-open-path.ps1` from the `deploy` job in
 * `.github/workflows/package.yml`, against the extracted release artifact: the
 * `app/src/ui/open-path.js` imported below is the file a user's machine will run. Issue
 * #217 was fixed twice in the wrong place because only the *URL* branch was asserted off
 * Windows; this asserts the path branch on the platform whose shell actually misbehaves.
 *
 * It does NOT open a window and cannot: a runner has no interactive desktop, so whether
 * Explorer highlights the file, opens the folder, or (the bug) opens Documents is not
 * observable here. What is observable is the command handed to Explorer - which is
 * exactly the seam that was wrong before.
 *
 * Usage: node open-path-check.mjs <payload-root>
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const payload = resolve(process.argv[2] ?? '');
if (!payload) throw new Error('usage: node open-path-check.mjs <payload-root>');

const modulePath = join(payload, 'app', 'src', 'ui', 'open-path.js');
if (!existsSync(modulePath)) throw new Error(`the artifact has no open-path.js at ${modulePath}`);

const { openPathCommand } = await import(pathToFileURL(modulePath).href);

function fail(message) {
  throw new Error(`open-path: ${message}`);
}

// 1. An existing file is *revealed* with explorer's `/select,` switch. A bare path is
//    not a reveal form; the old `args: [text]` is what opened Documents (#217).
const existing = join(payload, 'node.exe');
const fileSpec = openPathCommand(existing);
const root = process.env.SystemRoot;
console.log(`open-path: existing file  -> ${fileSpec.command} ${fileSpec.args.join(' ')}`);
if (!/explorer\.exe$/i.test(fileSpec.command)) {
  fail(`an existing file must open with explorer.exe, got ${fileSpec.command}`);
}
if (root && fileSpec.command !== `${root}\\explorer.exe`) {
  fail(`explorer.exe must be SystemRoot-qualified, got ${fileSpec.command}`);
}
if (fileSpec.args.length !== 1 || fileSpec.args[0] !== `/select,${existing}`) {
  fail(`an existing file must be revealed as /select,<path> with no space, got ${JSON.stringify(fileSpec.args)}`);
}

// 2. A missing file whose containing folder exists: the folder is opened, never the
//    target (which Explorer would resolve to its default folder, Documents).
const folder = payload;
const missingBeside = join(folder, 'no-such-file.toml');
const besideSpec = openPathCommand(missingBeside);
console.log(`open-path: missing, folder -> ${besideSpec.command} ${besideSpec.args.join(' ')}`);
if (besideSpec.args.length !== 1 || besideSpec.args[0] !== folder) {
  fail(`a missing file must open its existing containing folder ${folder}, got ${JSON.stringify(besideSpec.args)}`);
}
if (besideSpec.args[0].startsWith('/select,')) {
  fail('the folder fallback must open the folder, not select a path that does not exist');
}

// 3. A missing file whose whole containing chain is missing: walk up to the nearest
//    existing ancestor. This is the fresh-install config.toml shape.
const missingDeep = join(folder, 'no-such-folder', 'config.toml');
const deepSpec = openPathCommand(missingDeep);
console.log(`open-path: missing, walk  -> ${deepSpec.command} ${deepSpec.args.join(' ')}`);
if (deepSpec.args.length !== 1 || deepSpec.args[0] !== folder) {
  fail(`the ancestor walk must reach ${folder}, got ${JSON.stringify(deepSpec.args)}`);
}

// 4. The split itself: a URL still goes to the shell's protocol handler, not explorer
//    (#169), so a fix to the path branch cannot have re-broken the URL branch.
const url = 'http://127.0.0.1:51234/?token=abc123';
const urlSpec = openPathCommand(url);
console.log(`open-path: url            -> ${urlSpec.command} ${urlSpec.args.join(' ')}`);
if (!/rundll32\.exe$/i.test(urlSpec.command) || /explorer/i.test(urlSpec.command)) {
  fail(`a URL must open with rundll32, not explorer, got ${urlSpec.command}`);
}
if (urlSpec.args[0] !== 'url.dll,FileProtocolHandler' || urlSpec.args[1] !== url) {
  fail(`a URL must keep its literal argument, got ${JSON.stringify(urlSpec.args)}`);
}

console.log('open-path-ok');
