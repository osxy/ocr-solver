/**
 * `node src/cli.js images ...` - the headless purge for stored review copies (#100).
 *
 * Someone who wants to clear the stored images should not have to hunt for a
 * directory or hand-write SQL. The purge deletes the rows and the files together,
 * through the same `createImageStore` the running app uses, so the two cannot
 * disagree about which file belongs to which row.
 *
 * Usage:
 *   node src/cli.js images purge            # delete every stored image
 *   node src/cli.js images purge --config X # use X's data location
 */
import { loadConfig, defaultStatePath } from './config.js';
import { openStore } from './state/db.js';
import { createImageStore, defaultImagesDir } from './state/images.js';

function parse(argv) {
  const opts = { command: null, config: null, store: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config') opts.config = argv[++i] ?? null;
    else if (arg === '--store') opts.store = argv[++i] ?? null;
    else if (!arg.startsWith('-') && opts.command == null) opts.command = arg;
  }
  return opts;
}

function usage(out) {
  out.write(
    'Usage: node src/cli.js images purge [--config <path>] [--store <path>]\n\n' +
      '  purge   delete every stored review copy (rows and files) and report the count\n' +
      '  --store <path>  the state database (default: the app data directory)\n'
  );
}

export async function runImages(argv, { stdout = process.stdout, stderr = process.stderr, imagesDir = null, statePath = null } = {}) {
  const opts = parse(argv);
  if (opts.command == null || opts.command === 'help' || opts.command === '--help') {
    usage(stderr);
    return 2;
  }
  if (opts.command !== 'purge') {
    stderr.write(`unknown images command "${opts.command}"\n`);
    usage(stderr);
    return 2;
  }

  const { config } = loadConfig({ explicitPath: opts.config, env: {} });
  const store = openStore({ path: statePath ?? opts.store ?? defaultStatePath() });
  try {
    const imageStore = createImageStore({
      store,
      dir: imagesDir ?? defaultImagesDir(),
      maxCount: config.storage.max_images,
    });
    const before = imageStore.count();
    const removed = imageStore.purge();
    stdout.write(`purged ${removed} stored image(s) from ${imageStore.dir} (${before} row(s) before)\n`);
    return 0;
  } finally {
    store.close();
  }
}
