#!/usr/bin/env node
/**
 * Command line entry point.
 *
 * Offline by default (Tier 0 only). Pass --use-model to enable the model tiers.
 *
 *   node src/cli.js corpus                            # offline, no token, no network
 *   node src/cli.js corpus --json
 *   node src/cli.js corpus --use-model                # Tier 1/2 escalation
 *   node src/cli.js corpus --use-model --store log.db # record every attempt
 *   node src/cli.js corpus --attempts log.db          # read back what happened
 */
import { readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import sharp from 'sharp';
import { createOcrWorker } from './ocr/recognize.js';
import { solveImage, formatReport } from './solver/pipeline.js';
import { VARIANTS, DEFAULT_VARIANTS, extractMask, renderMask } from './imaging/preprocess.js';
import {
  createChatClient,
  OPENROUTER_BASE_URL,
  AUTO_ROUTER_SLUGS,
  autoRouterPlugin,
  normalizeModelChain,
} from './model/client.js';

/** Default auto slug; the slug->plugin-id mapping lives in the client. */
const AUTO_ROUTER_SLUG = 'openrouter/auto';
import { createFakeClient } from './model/fake.js';
import { createReasoner } from './solver/reason.js';
import { openStore } from './state/db.js';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.webp', '.tif', '.tiff', '.gif']);

function parseArgs(argv) {
  const opts = {
    files: [],
    json: false,
    quiet: false,
    variants: DEFAULT_VARIANTS,
    psms: null,
    dumpMasks: null,
    useModel: false,
    fakeModel: false,
    apiKey: process.env.LLM_API_KEY ?? '',
    baseUrl: process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1',
    // Left null so "unset" is distinguishable from "deliberately chosen" - the vision
    // tier is required to be an explicit choice when auto routing is in play.
    textModel: process.env.LLM_TEXT_MODEL ?? null,
    visionModel: process.env.LLM_VISION_MODEL ?? null,
    samples: null,
    store: null,
    showAttempts: null,
    fakeAnswer: '0',
    fakeClass: 'unknown',
    auto: false,
    costTier: process.env.LLM_COST_TIER ?? null,
    allowedModels: (process.env.LLM_ALLOWED_MODELS ?? '').split(',').filter(Boolean),
    excludedModels: (process.env.LLM_EXCLUDED_MODELS ?? '').split(',').filter(Boolean),
    // listen mode: run the Pushbullet service rather than solving local images.
    listen: false,
    // --headless: skip the tray and every notification; the default is tray mode.
    headless: false,
    config: null,
    // Explicit secrets only. `apiKey` above may come from the environment, but the
    // secret resolver should still report the environment as the source, so only a
    // literal --api-key travels as an explicit option.
    explicitApiKey: null,
    token: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--json') opts.json = true;
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--use-model') opts.useModel = true;
    else if (a === '--fake-model') { opts.useModel = true; opts.fakeModel = true; }
    else if (a === '--fake-answer') { opts.useModel = true; opts.fakeModel = true; opts.fakeAnswer = next() ?? '0'; }
    else if (a === '--fake-class') { opts.fakeClass = next() ?? 'unknown'; }
    else if (a === '--api-key') { opts.apiKey = next() ?? ''; opts.explicitApiKey = opts.apiKey; }
    else if (a === '--token') opts.token = next() ?? null;
    else if (a === '--pushbullet-token') opts.token = next() ?? null;
    else if (a === '--config') opts.config = next() ?? null;
    else if (a === '--listen') opts.listen = true;
    else if (a === '--headless') { opts.headless = true; opts.listen = true; }
    else if (a === '--base-url') opts.baseUrl = next() ?? opts.baseUrl;
    else if (a === '--auto') {
      // Auto-route the TEXT tier only. The vision tier stays a chosen model: it runs
      // only when OCR failed, so it is the one place where model choice matters most.
      opts.useModel = true;
      opts.auto = true;
      opts.baseUrl = OPENROUTER_BASE_URL;
      opts.textModel = opts.textModel ?? AUTO_ROUTER_SLUG;
    }
    else if (a === '--cost-tier') opts.costTier = next() ?? null;
    else if (a === '--allowed-models') opts.allowedModels = (next() ?? '').split(',').filter(Boolean);
    else if (a === '--exclude-models') opts.excludedModels = (next() ?? '').split(',').filter(Boolean);
    else if (a === '--text-model') opts.textModel = next() ?? opts.textModel;
    else if (a === '--vision-model') opts.visionModel = next() ?? opts.visionModel;
    else if (a === '--samples') opts.samples = Number(next());
    else if (a === '--store') opts.store = next() ?? null;
    else if (a === '--attempts') opts.showAttempts = next() ?? null;
    else if (a === '--variants') opts.variants = (next() ?? '').split(',').filter(Boolean);
    else if (a === '--psm') opts.psms = [next() ?? '6'];
    else if (a === '--dump-masks') opts.dumpMasks = next();
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('-')) throw new Error(`unknown option: ${a}`);
    else opts.files.push(a);
  }
  return opts;
}

/** Expand directories into the image files inside them. */
function expandFiles(inputs) {
  const out = [];
  for (const input of inputs) {
    const st = statSync(input);
    if (st.isDirectory()) {
      for (const name of readdirSync(input).sort()) {
        if (IMAGE_EXT.has(extname(name).toLowerCase())) out.push(join(input, name));
      }
    } else {
      out.push(input);
    }
  }
  return out;
}

function summarizeModel(m) {
  return {
    answer: m.answer,
    votes: m.votes,
    of: m.of,
    corrected: m.corrected ?? false,
    confidence: m.confidence ?? null,
  };
}

/** Print everything recorded for one subject, for debugging a bad answer. */
function printAttempts(store, subject) {
  const rows = store.attemptsFor(subject);
  if (rows.length === 0) {
    console.log(`no attempts recorded for ${subject}`);
    return;
  }
  console.log(`\n${subject}: ${rows.length} attempt(s)`);
  for (const row of rows) {
    const bits = [
      row.stage.padEnd(12),
      (row.variant ?? '-').padEnd(18),
      row.psm ? `psm${row.psm}` : '    ',
      row.confidence == null ? '   ' : `${String(Math.round(row.confidence)).padStart(3)}%`,
      row.ok == null ? '  ' : row.ok ? 'ok' : 'NO',
      row.payload ? JSON.stringify(row.payload).slice(0, 120) : '',
    ];
    console.log(`  ${bits.join('  ')}`);
  }
}

/** Vision-capable rolling aliases, read from the live OpenRouter catalogue. */
export const SUGGESTED_VISION_MODELS = [
  '~google/gemini-flash-latest',
  '~anthropic/claude-sonnet-latest',
  '~openai/gpt-mini-latest',
];

/**
 * Pick the vision model, refusing to silently guess one when auto routing is used.
 * The vision tier is the last line of defence, so its model should be a decision
 * someone made on purpose rather than a default nobody looked at.
 */
function resolveVisionModel(opts, isOpenRouter) {
  if (opts.visionModel) return opts.visionModel;
  if (!isOpenRouter && !opts.auto) return 'gpt-4o';
  throw new Error(
    'the vision tier needs an explicitly chosen model: set LLM_VISION_MODEL or pass --vision-model.\n' +
    '  It only runs when OCR failed, so it is the one tier where the model choice matters most.\n' +
    '  A comma-separated list becomes an ordered fallback chain (max 3).\n' +
    '  Vision-capable rolling aliases that accept images and never go stale:\n' +
    SUGGESTED_VISION_MODELS.map((m) => `    ${m}`).join('\n') + '\n' +
    '  e.g. --vision-model "~google/gemini-flash-latest,~anthropic/claude-sonnet-latest"'
  );
}

/** Nudge when the last-resort tier has been left to a router. */
function warnIfVisionIsRouted(opts) {
  if (!opts.useModel) return;
  const slug = normalizeModelChain(opts.visionModel ?? '')[0];
  if (!slug || !AUTO_ROUTER_SLUGS[slug]) return;
  process.stderr.write(
    `warning: the vision tier is set to an auto-routing slug (${slug}).\n` +
    '  It runs only when OCR failed, so it is the one tier where the model choice\n' +
    '  matters most - and the unset cost band is the cheapest one. Pinning a specific\n' +
    '  vision model, optionally with fallbacks, is recommended.\n'
  );
}

function buildReasoner(opts, store, subject) {
  if (opts.fakeModel) {
    // Offline demo path: makes the model tiers exercisable without a provider key.
    const client = createFakeClient({
      responses: () => ({
        transcript: 'fake',
        answer: opts.fakeAnswer,
        puzzle_class: opts.fakeClass,
        confidence: 0.95,
      }),
    });
    return createReasoner({ client, textModel: 'fake', visionModel: 'fake', store, subject });
  }

  if (!opts.apiKey) {
    throw new Error(
      '--use-model requires an API key: set LLM_API_KEY or pass --api-key ' +
      '(use --fake-model to exercise the model tiers without one)'
    );
  }

  const isOpenRouter = /openrouter\.ai/.test(opts.baseUrl);
  const textModel = opts.textModel ?? 'gpt-4o-mini';
  const visionModel = resolveVisionModel(opts, isOpenRouter);

  const autoRouter = {
    costTier: opts.costTier,
    allowedModels: opts.allowedModels,
    excludedModels: opts.excludedModels,
  };

  // Validate the cost tier now rather than inside a retry loop, where an unknown
  // tier would be retried as if it were a transient fault.
  try {
    autoRouterPlugin(textModel, autoRouter);
    autoRouterPlugin(visionModel, autoRouter);
  } catch (err) {
    throw new Error(`${err.message} (check --cost-tier / LLM_COST_TIER)`);
  }

  const client = createChatClient({ baseUrl: opts.baseUrl, apiKey: opts.apiKey, autoRouter });
  const sampleCounts = opts.samples
    ? { count: opts.samples, arithmetic: opts.samples, 'ordinal-pick': opts.samples, unknown: opts.samples }
    : undefined;
  return createReasoner({ client, textModel, visionModel, sampleCounts, store, subject });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help || (opts.files.length === 0 && !opts.showAttempts)) {
    console.log(
      'Usage: node src/cli.js <image|dir> [...] [options]\n\n' +
      '  --json                 machine-readable output\n' +
      `  --variants <list>      preprocessing presets (${Object.keys(VARIANTS).join(',')})\n` +
      '  --psm <n>              single Tesseract page segmentation mode\n' +
      '  --dump-masks <dir>     write the cleaned bitmaps OCR was given\n' +
      '  --use-model            enable Tier 1/2 model escalation\n' +
      '  --fake-model           exercise the model tiers with a scripted reply\n' +
      '  --fake-answer <text>   implied by --fake-answer: reply with this answer\n' +
      '  --fake-class <class>   puzzle class the fake model claims\n' +
      '  --api-key <k>          model API key (or LLM_API_KEY)\n' +
      '  --base-url <url>       OpenAI-compatible endpoint\n' +
      '  --auto                 auto-route the TEXT tier via OpenRouter (implies --use-model)\n' +
      '  --cost-tier <tier>     auto-router cost band: low|medium|high|xhigh|max\n' +
      '  --allowed-models <l>   comma-separated wildcard patterns to route within\n' +
      '  --exclude-models <l>   comma-separated patterns to route around\n' +
      '  --text-model <name>    transcript-level model (or comma list for fallbacks)\n' +
      '  --vision-model <name>  image-level model, chosen deliberately (or comma list)\n' +
      '  --samples <n>          samples per puzzle for self-consistency\n' +
      '  --store <file.db>      record every attempt to SQLite\n' +
      '  --attempts <file.db>   print recorded attempts and exit\n' +
      '  listen                 run the Pushbullet service (see also --listen)\n' +
      '  --headless             skip the tray and notifications (for a service/unattended run)\n' +
      '  --config <path>        TOML config file (or PUZZLESOLVER_CONFIG)\n' +
      '  --token <token>        Pushbullet token for listen mode (or PUSHBULLET_TOKEN)'
    );
    process.exit(opts.help ? 0 : 2);
  }

  if (opts.showAttempts) {
    const store = openStore({ path: opts.showAttempts });
    const subjects = opts.files.length ? opts.files.map((f) => basename(f)) : [];
    if (subjects.length === 0) {
      const rows = store.db.prepare('SELECT DISTINCT subject FROM attempts ORDER BY subject').all();
      for (const { subject } of rows) printAttempts(store, subject);
    } else {
      for (const subject of subjects) printAttempts(store, subject);
    }
    store.close();
    return;
  }

  const files = expandFiles(opts.files);
  if (files.length === 0) {
    console.error('no image files found');
    process.exit(2);
  }

  if (opts.dumpMasks) mkdirSync(opts.dumpMasks, { recursive: true });
  warnIfVisionIsRouted(opts);

  const store = opts.store ? openStore({ path: opts.store }) : null;
  const worker = await createOcrWorker();
  const results = [];

  try {
    for (const file of files) {
      const subject = basename(file);
      if (opts.dumpMasks) {
        for (const name of opts.variants) {
          const preset = VARIANTS[name];
          const { mask, width, height } = await extractMask(file, preset);
          const buf = await renderMask(mask, width, height, preset.scale);
          const out = join(opts.dumpMasks, `${basename(file, extname(file)).replace(/[^a-z0-9]/gi, '_')}--${name}.png`);
          await sharp(buf).toFile(out);
        }
      }

      const reasoner = opts.useModel ? buildReasoner(opts, store, subject) : null;
      const result = await solveImage(worker, file, {
        variants: opts.variants,
        psms: opts.psms ?? undefined,
        reasoner,
        store,
        subject,
      });
      results.push(result);

      if (!opts.json) {
        console.log(`\n${subject}`);
        console.log(formatReport(result));
      }
    }
  } finally {
    await worker.terminate();
    if (store && !opts.json) store.close();
  }

  if (opts.json) {
    console.log(JSON.stringify(results.map((r) => ({
      image: basename(r.image),
      answer: r.answer,
      method: r.method,
      confident: r.confident,
      puzzleClass: r.puzzleClass,
      needsModel: r.needsModel,
      unresolved: r.unresolved,
      transcript: r.transcript,
      repairs: r.solved?.normalized.repairs ?? [],
      disputed: r.disputed,
      opinions: r.opinions?.map((o) => ({ source: o.source, answer: o.answer })) ?? [],
      agreement: r.agreement ? { votes: r.agreement.votes, of: r.agreement.of } : null,
      model: r.model
        ? {
            text: r.model.text ? summarizeModel(r.model.text) : null,
            vision: r.model.vision ? summarizeModel(r.model.vision) : null,
          }
        : null,
      bestOcr: r.ranked[0]
        ? { variant: r.ranked[0].variant, psm: r.ranked[0].psm, confidence: r.ranked[0].confidence }
        : null,
      candidates: r.candidates.map((c) => ({
        class: c.parsed.class,
        tier0: c.tier0?.answer ?? null,
        valid: c.validation?.ok ?? null,
      })),
    })), null, 2));
    store?.close();
  } else {
    const solved = results.filter((r) => r.answer != null).length;
    const offline = results.filter((r) => r.solved).length;
    console.log(`\nsolved ${solved}/${results.length} (${offline} offline, ${solved - offline} via model)`);
  }

  process.exit(results.every((r) => r.answer != null) ? 0 : 1);
}

/** Run the Pushbullet service (M2). Kept separate from the local-solve path so the
 * default behaviour of `node src/cli.js <image|dir>` is unchanged. */
async function runListen(argv) {
  const opts = parseArgs(argv);
  const { runApp } = await import('./app.js');
  await runApp({
    configPath: opts.config,
    // Only literal flags travel as explicit secrets; env vars keep source 'env'.
    explicitSecrets: { pushbullet: opts.token, llm: opts.explicitApiKey },
    // Tray is the default; --headless turns both the tray and notifications off.
    headless: opts.headless,
    tray: !opts.headless,
  });
}

const argv = process.argv.slice(2);
if (argv[0] === 'listen' || argv.includes('--listen') || argv.includes('--headless')) {
  runListen(argv).catch((err) => {
    // The missing-tray case is expected on a machine without systray2; a stack trace
    // there reads as a crash, so surface only the actionable line.
    if (err?.name === 'TrayUnavailableError') {
      console.error(err.message);
      process.exit(1);
    }
    console.error(err.stack ?? String(err));
    process.exit(1);
  });
} else {
  main().catch((err) => {
    console.error(err.stack ?? String(err));
    process.exit(1);
  });
}
