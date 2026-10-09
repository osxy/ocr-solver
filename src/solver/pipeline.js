/**
 * End-to-end solve pipeline.
 *
 *   image ─▶ masks ─▶ OCR ─▶ repair ─▶ parse ─▶ Tier 0 (offline)
 *                                                   │
 *             ┌─────────────────────────────────────┘
 *             ▼
 *   Tier 0 confident?  ── yes ──▶ answer, no model call at all
 *             │ no
 *             ▼
 *   collect opinions: Tier 0 (if any) + text model (+ vision model on disagreement)
 *             │
 *             ▼
 *   strict majority of opinions ──▶ answer
 *             │ no majority
 *             ▼
 *   unresolved: nothing is sent
 *
 * Why opinions rather than a simple fallback ladder: a *non-confident* Tier 0 answer
 * (one whose word list contains unrecognised tokens) is exactly the case most likely
 * to be a miscount, so it must be corroborated rather than posted on its own. Making
 * Tier 0 just another opinion means it can be confirmed, outvoted, or deadlocked -
 * and a deadlock reports unresolved instead of guessing.
 *
 * Strategy notes:
 *  - Every preprocessing variant is OCR'd, and candidates are walked best-first.
 *    OCR garbles differ per variant, so one variant's garble is often another
 *    variant's clean read.
 *  - Among acceptable answers a *confident* one always wins, even from a
 *    lower-confidence variant, because a miscounted answer posted as certain is the
 *    worst possible outcome.
 */
import { buildVariants, DEFAULT_VARIANTS } from '../imaging/preprocess.js';
import { recognizeVariants, rankResults, PSM } from '../ocr/recognize.js';
import { normalizeTranscript } from './transcript.js';
import { parsePuzzle, solveTier0, PUZZLE_CLASS } from './puzzle.js';
import { validateAnswer } from './validate.js';
import { consensus } from './reason.js';

export const DEFAULT_PSMS = [PSM.SINGLE_BLOCK, PSM.SINGLE_LINE];

/** Build a candidate from one OCR result: transcript, repairs, parse, Tier 0 answer. */
function makeCandidate(ocrResult) {
  const normalized = normalizeTranscript(ocrResult.text);
  const parsed = parsePuzzle(normalized.text);
  const tier0 = solveTier0(parsed);
  let validation = null;
  if (tier0) {
    validation = validateAnswer(parsed.class, tier0.answer);
    // A picked word must actually come from the puzzle's own list, otherwise an
    // over-eager lexicon repair could produce a plausible but wrong answer.
    if (parsed.class === PUZZLE_CLASS.ORDINAL_PICK && validation.ok) {
      if (!parsed.list.includes(validation.answer)) {
        validation = {
          ok: false,
          answer: validation.answer,
          reason: 'answer not present in the puzzle word list',
          expected: 'a word from the puzzle list',
        };
      }
    }
  }
  return { ocr: ocrResult, normalized, parsed, tier0, validation };
}

/** The best offline answer: a confident one if available, else the highest-ranked acceptable one. */
function pickOfflineAnswer(candidates) {
  const acceptable = candidates.filter((c) => c.tier0 && c.validation?.ok);
  return acceptable.find((c) => c.tier0.confident) ?? acceptable[0] ?? null;
}

/** A model answer is confident only when its samples were unanimous and it felt sure. */
function modelIsConfident(result) {
  if (!result) return false;
  const unanimous = result.votes != null && result.of != null && result.votes === result.of;
  const selfReported = result.confidence == null || result.confidence >= 0.6;
  return unanimous && selfReported;
}

export async function solveImage(worker, image, options = {}) {
  const {
    variants = DEFAULT_VARIANTS,
    psms = DEFAULT_PSMS,
    minConfidence = 0,
    reasoner = null,
    store = null,
    subject = String(image),
    logger = null,
  } = options;

  const built = await buildVariants(image, variants);
  const ocr = await recognizeVariants(worker, built, psms);
  const ranked = rankResults(ocr).filter((r) => !r.empty && r.confidence >= minConfidence);

  if (store) {
    for (const r of ocr) {
      store.record({
        subject,
        stage: 'ocr',
        variant: r.variant,
        psm: r.psm,
        payload: { text: r.text, empty: r.empty },
        confidence: r.confidence,
        ms: r.ms,
      });
    }
  }

  const candidates = ranked.map(makeCandidate);
  const offline = pickOfflineAnswer(candidates);

  if (store && offline) {
    store.record({
      subject,
      stage: 'tier0',
      variant: offline.ocr.variant,
      psm: offline.ocr.psm,
      payload: {
        answer: offline.validation.answer,
        method: offline.tier0.method,
        detail: offline.tier0.detail,
        confident: offline.tier0.confident,
      },
      ok: true,
      confidence: offline.ocr.confidence,
    });
  }

  const transcript = offline?.normalized.text ?? ranked[0]?.text ?? '';
  const parsed = offline?.parsed ?? candidates[0]?.parsed ?? parsePuzzle('');

  /** Opinions about the answer, from every tier that produced one. */
  const opinions = [];
  if (offline) {
    opinions.push({
      answer: offline.validation.answer,
      source: 'tier0',
      method: offline.tier0.method,
      confident: offline.tier0.confident,
    });
  }

  let textResult = null;
  let visionResult = null;

  // Only consult the model when the offline answer is missing or uncorroborated.
  if (reasoner && !(offline && offline.tier0.confident)) {
    const preferred = ranked[0]?.variant;
    const ordered = preferred
      ? [...built].sort((a, b) => (a.name === preferred ? -1 : b.name === preferred ? 1 : 0))
      : built;
    const images = ordered.slice(0, 1);

    const attempt = async (label, fn) => {
      try {
        return await fn();
      } catch (err) {
        // A dead model must never lose an answer we already have, and must never
        // crash the worker.
        store?.record({ subject, stage: 'model-error', variant: label, payload: { error: String(err?.message ?? err) }, ok: false });
        logger?.warn?.(`${label} tier failed: ${err?.message ?? err}`);
        return null;
      }
    };

    if (transcript) {
      textResult = await attempt('text', () => reasoner.solveText({ transcript, parsed }));
    }
    if (textResult) {
      opinions.push({ answer: textResult.answer, source: 'text', method: 'model:text', confident: modelIsConfident(textResult) });
    }

    // Disagreement (or nothing usable from text) means the image itself gets a look.
    // Note the explicit `.answer` check: `consensus` returns an object even when no
    // answer reached a majority (with `answer: null`), so testing truthiness here
    // would silently skip the vision tier in exactly the case it exists for.
    if (!consensus(opinions)?.answer) {
      visionResult = await attempt('vision', () =>
        reasoner.solveVision({ images, parsed, hintTranscript: transcript })
      );
      if (visionResult) {
        opinions.push({
          answer: visionResult.answer,
          source: 'vision',
          method: 'model:vision',
          confident: modelIsConfident(visionResult),
        });
      }
    }

    for (const [stage, result] of [['model-text', textResult], ['model-vision', visionResult]]) {
      if (!result || !store) continue;
      store.record({
        subject,
        stage,
        variant: stage === 'model-text' ? reasoner.textModel : reasoner.visionModel,
        payload: {
          answer: result.answer,
          votes: result.votes,
          of: result.of,
          transcript: result.transcript,
          corrected: result.corrected ?? false,
        },
        confidence: result.confidence == null ? null : result.confidence * 100,
        ok: true,
      });
    }
  }

  const agreement = consensus(opinions);
  const answer = agreement?.answer ?? null;

  // Confidence: unanimous agreement across every tier that spoke, or a single
  // opinion that vouched for itself (a confident Tier 0, or a unanimous model).
  let confident = false;
  if (agreement && agreement.answer != null) {
    if (opinions.length === 1) confident = opinions[0].confident === true;
    else confident = agreement.votes === opinions.length;
  }

  const winningSource = answer == null ? null : agreement.sources[0];
  const method =
    winningSource === 'tier0'
      ? offline.tier0.method
      : winningSource === 'text'
        ? 'model:text'
        : winningSource === 'vision'
          ? 'model:vision'
          : null;

  const disputed = opinions.length > 1 && agreement?.answer == null;

  if (store) {
    store.record({
      subject,
      stage: 'validate',
      payload: {
        answer,
        method,
        opinionCount: opinions.length,
        opinions: opinions.map((o) => `${o.source}=${o.answer}`),
        agreement: agreement ? `${agreement.votes}/${agreement.of}` : null,
        disputed,
      },
      ok: answer != null,
    });
  }

  return {
    image,
    subject,
    variantCount: built.length,
    ocr,
    ranked,
    candidates,
    solved: offline,
    model: textResult || visionResult ? { text: textResult, vision: visionResult } : null,
    opinions,
    agreement,
    disputed,
    answer,
    method,
    confident,
    needsModel: !offline,
    unresolved: answer == null,
    puzzleClass: offline?.parsed.class ?? textResult?.puzzleClass ?? visionResult?.puzzleClass ?? null,
    transcript,
  };
}

/** One-line-per-attempt human readable report. */
export function formatReport(result) {
  const lines = [];
  for (const r of result.ranked.slice(0, 4)) {
    lines.push(`  ocr  ${r.variant.padEnd(20)} psm${r.psm}  ${String(r.confidence).padStart(3)}%  ${r.text}`);
  }
  for (const c of result.candidates.slice(0, 3)) {
    const repairs = c.normalized.repairs.map((x) => `${x.from}->${x.to}`).join(' ');
    lines.push(
      `  cand ${c.parsed.class.padEnd(13)} tier0=${c.tier0 ? c.tier0.answer : '-'}` +
      ` valid=${c.validation ? c.validation.ok : 'n/a'}${repairs ? `  repairs: ${repairs}` : ''}`
    );
  }
  for (const [label, m] of [['text ', result.model?.text], ['image', result.model?.vision]]) {
    if (!m) continue;
    lines.push(
      `  model:${label} answer="${m.answer}"` +
      (m.votes != null ? ` agreement=${m.votes}/${m.of}` : '') +
      (m.corrected ? ' (arithmetic corrected the model)' : '')
    );
  }
  if (result.opinions?.length > 1) {
    lines.push(`  opinions ${result.opinions.map((o) => `${o.source}=${o.answer}`).join(', ')}`);
  }
  if (result.answer != null) {
    lines.push(
      `  =>   answer "${result.answer}" via ${result.method} (${result.agreement.votes}/${result.agreement.of} agree)` +
      (result.confident ? '' : ' (LOW CONFIDENCE)')
    );
  } else if (result.disputed) {
    lines.push('  =>   unresolved: tiers disagreed, nothing sent');
  } else {
    lines.push('  =>   unresolved: no tier produced a valid answer');
  }
  return lines.join('\n');
}
