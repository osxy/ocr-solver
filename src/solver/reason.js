/**
 * Tier 1/2: the model reasoner.
 *
 * Ladder: offline lexicon -> text model on the OCR transcript -> vision model on the
 * preprocessed image -> give up (unresolved).
 *
 * Three ideas do the real work here:
 *
 * 1. **Every model answer passes the same validator as an offline answer.** A model
 *    is not trusted to be self-consistent; it is trusted to produce something whose
 *    *shape* the puzzle demands. Anything else escalates.
 *
 * 2. **Self-consistency by sampling.** For the classes where a single sample is
 *    unreliable (ordinal-pick, unknown), several samples are taken and must agree.
 *    Arithmetic is exempt because it is provably checkable instead.
 *
 * 3. **Deterministic cross-check.** If the model calls a puzzle arithmetic, the
 *    corrected transcript is handed to the offline calculator. When they disagree,
 *    the arithmetic wins - it cannot be wrong about `9 - 4`.
 */
import { extractJson, visionMessage, ModelError, normalizeModelChain } from '../model/client.js';
import { loadPrompt } from './prompts.js';
import { validateAnswer } from './validate.js';
import { PUZZLE_CLASS, parsePuzzle } from './puzzle.js';
import { solveArithmetic } from './numbers.js';
import { normalizeTranscript } from './transcript.js';

/**
 * Completion budget per sample.
 *
 * Sized for the NARRATION, not the answer. The answer is ~20 tokens, but open models
 * frequently emit their reasoning as ordinary content before the JSON. Measured live:
 * a routed reasoning model spent all 300 tokens of a smaller budget narrating, was cut
 * off with finish_reason "length", and never emitted the JSON at all - while its
 * reasoning was correct throughout. Under-budgeting here looks exactly like a model
 * that cannot do the task.
 */
export const DEFAULT_MAX_TOKENS = 1500;

/** On a truncated reply, retry once with this multiple of the budget. */
const TRUNCATION_RETRY_FACTOR = 3;

const KNOWN_CLASSES = new Set(Object.values(PUZZLE_CLASS));
const ANSWER_KEYS = ['answer', 'antwoord', 'solution', 'oplossing', 'result', 'resultaat'];

/** How many samples a class needs before its answer is trusted. */
export const DEFAULT_SAMPLE_COUNTS = {
  [PUZZLE_CLASS.COUNT]: 1,
  [PUZZLE_CLASS.ARITHMETIC]: 1,
  [PUZZLE_CLASS.ORDINAL_PICK]: 3,
  [PUZZLE_CLASS.UNKNOWN]: 3,
};

/**
 * Decide which validator the model's answer must satisfy.
 *
 * Strict on purpose: when the offline parser already identified the puzzle shape it
 * is held to that shape, and `unknown` is NOT a fallback. Otherwise a model that
 * answers "twee" to a `hoeveel` question would quietly validate as a loose
 * free-text answer and be posted. The model only gets to name the class when the
 * parser genuinely could not tell (which is the case it exists for).
 */
function candidateClasses(parsed, modelClass) {
  if (parsed.class && parsed.class !== PUZZLE_CLASS.UNKNOWN) return [parsed.class];
  if (KNOWN_CLASSES.has(modelClass) && modelClass !== PUZZLE_CLASS.UNKNOWN) return [modelClass];
  return [PUZZLE_CLASS.UNKNOWN];
}

/**
 * Turn one raw model reply into a validated interpretation, or a rejection with a
 * reason. This is where the model's output stops being prose and becomes data.
 */
export function interpretReply(replyText, parsed, { modelClass: rawModelClass } = {}) {
  const json = extractJson(replyText);
  if (!json) {
    return { ok: false, reason: 'reply was not a JSON object', raw: replyText };
  }

  const modelClass = String(rawModelClass ?? json.puzzle_class ?? '').toLowerCase().trim();
  let rawAnswer = null;
  for (const key of ANSWER_KEYS) {
    if (json[key] != null && String(json[key]).trim() !== '') {
      rawAnswer = json[key];
      break;
    }
  }
  if (rawAnswer == null) {
    return { ok: false, reason: 'reply JSON had no answer field', json, modelClass };
  }

  const modelTranscript = typeof json.transcript === 'string' ? json.transcript : null;
  const confidence = Number.isFinite(Number(json.confidence)) ? Number(json.confidence) : null;

  for (const puzzleClass of candidateClasses(parsed, modelClass)) {
    const validation = validateAnswer(puzzleClass, rawAnswer);
    if (!validation.ok) continue;

    // A picked word must come from the puzzle's own list, when we have one.
    if (puzzleClass === PUZZLE_CLASS.ORDINAL_PICK && parsed.list.length > 0) {
      if (!parsed.list.includes(validation.answer)) {
        continue;
      }
    }

    const base = {
      ok: true,
      answer: validation.answer,
      puzzleClass,
      confidence,
      transcript: modelTranscript,
      json,
    };

    // Deterministic cross-check for arithmetic.
    if (puzzleClass === PUZZLE_CLASS.ARITHMETIC) {
      const recomputed = solveArithmetic(modelTranscript ?? parsed.tokens.join(' '));
      if (recomputed && recomputed.answer !== validation.answer) {
        return {
          ...base,
          answer: recomputed.answer,
          corrected: true,
          reason: `model said ${validation.answer}, arithmetic gives ${recomputed.answer}`,
        };
      }
    }

    return base;
  }

  const attempted = candidateClasses(parsed, modelClass)[0];
  const check = validateAnswer(attempted, rawAnswer);
  const structural =
    check.ok && attempted === PUZZLE_CLASS.ORDINAL_PICK && parsed.list.length > 0 && !parsed.list.includes(check.answer)
      ? `"${check.answer}" is not one of the puzzle's own words [${parsed.list.join(', ')}]`
      : null;
  return { ok: false, reason: structural ?? check.reason, json, modelClass, rawAnswer, puzzleClass: attempted };
}

/**
 * Majority over opinion objects `{ answer, source, method }`.
 * Used to arbitrate between the offline solver, the text model and the vision
 * model. A strict majority is required, so two conflicting opinions produce no
 * winner and the puzzle is reported unresolved instead of guessed at.
 */
export function consensus(opinions) {
  const valid = opinions.filter((o) => o && o.answer != null);
  if (valid.length === 0) return null;

  const tally = new Map();
  for (const opinion of valid) {
    const entry = tally.get(opinion.answer) ?? { answer: opinion.answer, count: 0, sources: [] };
    entry.count++;
    entry.sources.push(opinion.source);
    tally.set(opinion.answer, entry);
  }

  const ranked = [...tally.values()].sort((a, b) => b.count - a.count);
  const winner = ranked[0];
  const needed = Math.floor(valid.length / 2) + 1;
  if (winner.count < needed) {
    return { answer: null, ranked, of: valid.length, sources: winner.sources };
  }
  return { answer: winner.answer, votes: winner.count, of: valid.length, sources: winner.sources, ranked };
}

/**
 * Majority vote over validated interpretations.
 *
 * Two separate requirements, and both matter:
 *  - enough samples must have come back at all (`minValid`), so a provider that is
 *    failing does not promote a lone survivor into a confident answer; and
 *  - the winning answer must be a genuine majority of those samples.
 */
export function vote(interpretations) {
  const requested = interpretations.length;
  const valid = interpretations.filter((i) => i?.ok);
  if (valid.length === 0) return null;

  const tally = new Map();
  for (const item of valid) {
    const entry = tally.get(item.answer) ?? { answer: item.answer, count: 0, items: [] };
    entry.count++;
    entry.items.push(item);
    tally.set(item.answer, entry);
  }

  const ranked = [...tally.values()].sort((a, b) => b.count - a.count);
  const winner = ranked[0];
  const minValid = Math.ceil(requested / 2);
  const needed = Math.floor(valid.length / 2) + 1;

  if (valid.length < minValid) {
    return {
      ok: false,
      reason: `only ${valid.length}/${requested} samples produced a usable answer`,
      tally: ranked,
      validCount: valid.length,
    };
  }
  if (winner.count < needed) {
    return {
      ok: false,
      reason: `no agreement between samples (${ranked.map((t) => `${t.answer}x${t.count}`).join(', ')})`,
      tally: ranked,
      validCount: valid.length,
    };
  }

  const confidences = winner.items.map((i) => i.confidence).filter((c) => c != null);
  return {
    ok: true,
    answer: winner.answer,
    puzzleClass: winner.items[0].puzzleClass,
    votes: winner.count,
    of: requested,
    validCount: valid.length,
    transcript: winner.items.find((i) => i.transcript)?.transcript ?? null,
    confidence: confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : null,
    corrected: winner.items.some((i) => i.corrected),
    samples: interpretations,
  };
}

export function createReasoner({
  client,
  // Each may be a slug, a comma-separated list, or an array. More than one entry
  // becomes OpenRouter's ordered fallback chain: the first is the deliberate choice,
  // the rest only run when it errors, is rate-limited or is down.
  textModel = 'gpt-4o-mini',
  visionModel = 'gpt-4o',
  sampleCounts = DEFAULT_SAMPLE_COUNTS,
  temperature = 0.3,
  maxTokens = DEFAULT_MAX_TOKENS,
  promptDir,
  store = null,
  subject = 'unknown',
  logger = null,
} = {}) {
  if (!client) throw new Error('createReasoner requires a model client');

  const textChain = normalizeModelChain(textModel);
  const visionChain = normalizeModelChain(visionModel);
  if (textChain.length === 0) throw new Error('createReasoner requires a text model');
  if (visionChain.length === 0) throw new Error('createReasoner requires a vision model');

  /** Only send `models` when there is actually more than one to fall back to. */
  const chainBody = (chain) => (chain.length > 1 ? { models: chain } : null);

  const samplesFor = (parsed) => {
    const n = sampleCounts[parsed?.class] ?? 1;
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
  };

  /** Keep the routing report small enough to store, but keep it. */
  function routingSummary(routing) {
    if (!routing) return null;
    const json = typeof routing === 'string' ? routing : JSON.stringify(routing);
    return json.length > 400 ? `${json.slice(0, 400)}…` : json;
  }

  async function callModel({ stage, model, chain, messages, n }) {
    // A single sample is a deterministic lookup, so run it cold. Multiple samples
    // need some spread or they would all be identical and the vote meaningless.
    const sampleTemperature = n > 1 ? temperature : 0;
    const out = [];
    for (let i = 0; i < n; i++) {
      const started = Date.now();
      try {
        const send = (budget) =>
          client.chat({
            model,
            messages,
            temperature: sampleTemperature,
            maxTokens: budget,
            extraBody: chainBody(chain),
          });

        let reply = await send(maxTokens);

        // A truncated reply is a budget failure, not a model failure. Retrying with
        // more room is usually all it takes; treating it as a malformed reply would
        // escalate a puzzle that the model had in fact answered correctly inside its
        // own narration.
        let truncated = reply.finishReason === 'length';
        if (truncated) {
          const bigger = maxTokens * TRUNCATION_RETRY_FACTOR;
          logger?.info?.(`${stage}: reply truncated at ${maxTokens} tokens, retrying with ${bigger}`);
          reply = await send(bigger);
          truncated = reply.finishReason === 'length';
        }

        const ms = Date.now() - started;
        store?.record({
          subject,
          stage,
          // With an auto router this is the model that actually answered, not the slug.
          variant: reply.model ?? model,
          payload: {
            sample: i,
            requested: chain.length > 1 ? chain : model,
            provider: reply.provider ?? null,
            finishReason: reply.finishReason ?? null,
            truncated,
            completionTokens: reply.usage?.completion_tokens ?? null,
            routing: routingSummary(reply.routing),
            reply: reply.text.slice(0, 2000),
          },
          ms,
        });
        out.push({
          ok: true,
          text: reply.text,
          model: reply.model ?? model,
          provider: reply.provider ?? null,
          finishReason: reply.finishReason ?? null,
          truncated,
          ms,
        });
      } catch (err) {
        const ms = Date.now() - started;
        const message = err instanceof ModelError ? `${err.message}${err.body ? ` - ${err.body}` : ''}` : String(err?.message ?? err);
        store?.record({ subject, stage, variant: model, payload: { sample: i, error: message }, ok: false, ms });
        logger?.warn?.(`${stage} sample ${i + 1}/${n} failed: ${message}`);
        out.push({ ok: false, error: message, ms });
      }
    }
    return out;
  }

  function score(parsed, replies, stage) {
    const interpretations = replies.map((r) => {
      if (!r.ok) return { ok: false, reason: r.error };
      const interpreted = interpretReply(r.text, parsed);
      // Make truncation legible in the log. Otherwise a cut-off reply is
      // indistinguishable from a model that simply answered badly.
      if (!interpreted.ok && r.truncated) {
        return { ...interpreted, reason: `reply was truncated before valid JSON: ${interpreted.reason}` };
      }
      return interpreted;
    });
    if (store) {
      for (const [i, item] of interpretations.entries()) {
        store.record({
          subject,
          stage,
          variant: replies[i]?.model ?? null,
          payload: { answer: item.answer ?? null, reason: item.reason ?? null, puzzleClass: item.puzzleClass ?? null },
          // Stored on the same 0-100 scale as OCR confidence so the column means one
          // thing. Model self-reports are 0-1 and stay that way in code.
          confidence: item.confidence == null ? null : item.confidence * 100,
          ok: item.ok,
          ms: replies[i]?.ms ?? null,
        });
      }
    }
    const result = vote(interpretations);
    if (result && !result.ok) {
      logger?.info?.(`${stage}: ${result.reason} (${result.tally.map((t) => `${t.answer}x${t.count}`).join(', ')})`);
    }
    return result;
  }

  return {
    textModel: textChain[0],
    visionModel: visionChain[0],
    textChain,
    visionChain,
    samplesFor,

    /** Tier 1: reason over the OCR transcript. */
    async solveText({ transcript, parsed }) {
      const n = samplesFor(parsed);
      const replies = await callModel({
        stage: 'model-text',
        model: textChain[0],
        chain: textChain,
        n,
        messages: [
          { role: 'system', content: loadPrompt('solve', { promptDir }) },
          { role: 'user', content: `OCR-transcript: ${JSON.stringify(transcript)}` },
        ],
      });
      if (!replies.some((r) => r.ok)) return null;
      return score(parsed, replies, 'model-text');
    },

    /** Tier 2: reason over the preprocessed image itself. */
    async solveVision({ images, parsed, hintTranscript = null }) {
      if (!images?.length) return null;
      const n = Math.min(samplesFor(parsed), 2);
      const promptText =
        loadPrompt('vision', { promptDir }) +
        (hintTranscript ? `\n\nEen eerdere OCR-poging gaf (met fouten): ${JSON.stringify(hintTranscript)}` : '');
      const replies = await callModel({
        stage: 'model-vision',
        model: visionChain[0],
        chain: visionChain,
        n,
        messages: [
          { role: 'system', content: loadPrompt('solve', { promptDir }) },
          visionMessage(promptText, images[0].buffer),
        ],
      });
      if (!replies.some((r) => r.ok)) return null;
      return score(parsed, replies, 'model-vision');
    },

    /**
     * Full ladder. Returns a validated result, or null when every tier failed.
     * `tier0` is consulted only to note disagreement - it never overrides a
     * validated model answer.
     */
    async resolve({ transcript, parsed, images = [], tier0 = null }) {
      const text = await this.solveText({ transcript, parsed });
      if (text) {
        return {
          ...text,
          method: 'model:text',
          agreedWithTier0: tier0 ? tier0.answer === text.answer : null,
        };
      }

      const vision = await this.solveVision({ images, parsed, hintTranscript: transcript });
      if (vision) {
        return {
          ...vision,
          method: 'model:vision',
          agreedWithTier0: tier0 ? tier0.answer === vision.answer : null,
        };
      }

      return null;
    },
  };
}

/**
 * Re-parse a model-corrected transcript, so later stages and the log see the
 * cleaned wording. Falls back to the original parse if the correction does not
 * itself parse into a puzzle.
 */
export function reparseCorrected(transcript, fallbackParsed) {
  if (!transcript) return fallbackParsed;
  const reparsed = parsePuzzle(normalizeTranscript(transcript).text);
  return reparsed.class === PUZZLE_CLASS.UNKNOWN && fallbackParsed ? fallbackParsed : reparsed;
}
