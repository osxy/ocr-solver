/**
 * Prove the packaged artifact resolves `systray2` to a `SysTray` class.
 *
 * This is run by `packaging/run-tray-interop.ps1` from the `deploy` job in
 * `.github/workflows/package.yml`, against the *extracted release artifact*: the
 * `app/src/ui/tray-systray.js` imported below is the file that will run on a user's
 * machine, and the `systray2` it resolves is the Windows build that shipped with it.
 * It is the difference between "the checkout resolves the class" and "the installer
 * ships something that does".
 *
 * It deliberately does NOT construct a tray. Starting the native widget needs an
 * interactive desktop, which a CI runner does not have, so the tray can still be
 * unverified by this job - and saying so is the point. What this proves is the layer
 * that was broken: CommonJS/Babel interop. The shipped code read `mod?.default ??
 * mod`, got an object, and its guard threw, so the tray had never started anywhere.
 * If that resolution regresses, this check fails on Windows, on the artifact that
 * users install.
 *
 * Usage: node tray-interop.mjs <payload-root>
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const payload = resolve(process.argv[2] ?? '');
if (!payload) throw new Error('usage: node tray-interop.mjs <payload-root>');

const adapterPath = join(payload, 'app', 'src', 'ui', 'tray-systray.js');
if (!existsSync(adapterPath)) throw new Error(`the artifact has no tray adapter at ${adapterPath}`);

const { resolveSysTray } = await import(pathToFileURL(adapterPath).href);

// Resolve `systray2` the way the adapter's own `import('systray2')` will, from the
// artifact's `app/src`, so this cannot be satisfied by a copy in the checkout.
const requireFromArtifact = createRequire(adapterPath);
let entry;
try {
  entry = requireFromArtifact.resolve('systray2');
} catch (err) {
  throw new Error(`the artifact does not ship 'systray2': ${err?.message ?? err}`);
}
const mod = await import(pathToFileURL(entry).href);
const resolved = resolveSysTray(mod);

// The honest raw evidence first, so a failure says which shape was seen.
console.log(`systray2 entry: ${entry}`);
console.log(`systray2 exports: ${Object.keys(mod).join(', ')}`);
console.log(`mod.SysTray=${typeof mod?.SysTray} mod.default=${typeof mod?.default} mod.default.default=${typeof mod?.default?.default}`);

if (typeof resolved !== 'function') {
  throw new Error(
    `tray interop: resolveSysTray returned ${typeof resolved}, not a function; ` +
      `the tray would throw TrayUnavailableError on this artifact. exports seen: ${Object.keys(mod).join(', ')}`
  );
}

// Name the trap explicitly: if a future change makes `mod.default` a function again,
// this still passes, but the shape that broke the tray is recorded here.
const shippedShape = typeof mod?.default !== 'function' && typeof mod?.default?.default === 'function';
console.log(`tray interop: resolved a ${typeof resolved} (shipped Babel/CJS shape: ${shippedShape})`);
console.log('tray-interop-ok');
