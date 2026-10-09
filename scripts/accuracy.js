#!/usr/bin/env node
/**
 * Development entry point for the accuracy report. The implementation lives in
 * `src/accuracy-cli.js` because the packaged app ships `src/` but not `scripts/`.
 *
 *   node scripts/accuracy.js [--json] [--no-images] [--no-store] [--store <db>]
 */
import { runAccuracy } from '../src/accuracy-cli.js';

await runAccuracy();
