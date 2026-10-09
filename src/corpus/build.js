/**
 * Corpus construction for M4: turns the lexicon and the observed puzzle shapes
 * into items with answers known by construction.
 *
 * Two families:
 *   - image items  - rendered by `render.js` in the observed style
 *   - text items   - already-normalised transcripts that test the lexicon/parser
 *                    and, when lightly damaged, the repair layer
 *
 * Nothing here decides provenance: the caller labels an item when it is written.
 * These builders only guarantee that an item's `expected` is correct by
 * construction, so a "failure" in the report is the pipeline's, never the fixture's.
 *
 * Every text item is round-tripped through the real parser and Tier 0 solver
 * before it is returned. A fixture that the pipeline cannot answer is a bug in the
 * fixture, and it would silently depress the accuracy number while looking like a
 * pipeline regression (the exact trap M4 is exposed to). Refusing to emit it is
 * cheaper than debugging it later.
 */
import { CATEGORIES } from '../solver/lexicon.js';
import { parsePuzzle, solveTier0 } from '../solver/puzzle.js';
import { validateAnswer } from '../solver/validate.js';
import { normalizeTranscript } from '../solver/transcript.js';
import { solveArithmetic } from '../solver/numbers.js';
import { seededRandom } from './render.js';

/** Plural used in the question text ("hoeveel <plural> in lijst ..."). */
export const CATEGORY_PLURALS = {
  kleur: 'kleuren',
  lichaamsdeel: 'lichaamsdelen',
  dier: 'dieren',
  vrucht: 'vruchten',
  groente: 'groenten',
  getal: 'getallen',
  kleding: 'kleding',
  meubel: 'meubels',
  beroep: 'beroepen',
  vervoer: 'vervoer',
};

export const OFFLINE_CATEGORIES = Object.keys(CATEGORY_PLURALS);

const FUNCTION_ONLY = new Set([
  'de', 'het', 'een', 'in', 'op', 'van', 'met', 'en', 'of', 'wat', 'is',
  'lijst', 'lijstje', 'rij', 'reeks', 'hoeveel', 'wat', 'eerste', 'tweede', 'derde',
]);

function shuffle(rand, values) {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Words from other categories, usable as list distractors. */
function distractorsFor(category, count, rand) {
  const pool = [];
  for (const [name, words] of Object.entries(CATEGORIES)) {
    if (name === category) continue;
    for (const w of words) {
      // A distractor must not accidentally belong to the category under test, and
      // must not be a function word the parser strips.
      if (!FUNCTION_ONLY.has(w)) pool.push(w);
    }
  }
  return shuffle(rand, pool).slice(0, count);
}

/**
 * Build one count puzzle: "hoeveel <plural> in lijst <words>".
 * `matchCount` category words plus `distractorCount` words from other categories.
 */
export function buildCount({ category, matchCount, distractorCount, rand }) {
  const words = shuffle(rand, CATEGORIES[category]).slice(0, matchCount);
  const extras = distractorsFor(category, distractorCount, rand);
  const list = shuffle(rand, [...words, ...extras]);
  const transcript = `hoeveel ${CATEGORY_PLURALS[category]} in lijst ${list.join(' ')}`;
  return { class: 'count', category, list, transcript, expected: String(matchCount) };
}

/**
 * Build one ordinal-pick puzzle. `ordinal` is the Dutch ordinal word; the answer is
 * the category word it selects from the list. `laatste` counts from the end, the
 * rest from the start, matching `puzzle.js`.
 */
export function buildOrdinal({ category, ordinal, matchCount, distractorCount, rand }) {
  const matches = shuffle(rand, CATEGORIES[category]).slice(0, matchCount);
  const extras = distractorsFor(category, distractorCount, rand);
  const list = shuffle(rand, [...matches, ...extras]);
  const singular = category;
  const transcript = `in de lijst ${list.join(' ')} wat is de/het ${ordinal} ${singular}`;

  const parsed = parsePuzzle(transcript);
  const solved = solveTier0(parsed);
  if (!solved) return null;
  return { class: 'ordinal-pick', category, list, transcript, expected: solved.answer, ordinal };
}

const ORDINALS = ['eerste', 'tweede', 'derde', 'vierde', 'vijfde', 'zesde', 'zevende', 'achtste', 'negende', 'tiende', 'laatste'];

/**
 * Build one arithmetic puzzle from single Dutch number words. The transcript is
 * fed to the real calculator, so `expected` is never guessed.
 */
export function buildArithmetic({ aWord, op, bWord }) {
  const transcript = `wat is ${aWord} ${op} ${bWord}`;
  const solved = solveArithmetic(transcript);
  if (!solved) return null;
  // The class validator is the contract the pipeline will be held to; a fixture
  // whose answer could never be posted is not a solvable puzzle, it is a bug.
  if (!validateAnswer('arithmetic', solved.answer).ok) return null;
  return { class: 'arithmetic', category: null, list: [], transcript, expected: solved.answer };
}

const UNIT_WORDS = ['nul', 'een', 'twee', 'drie', 'vier', 'vijf', 'zes', 'zeven', 'acht', 'negen', 'tien', 'elf', 'twaalf'];
const TENS_WORDS = ['twintig', 'dertig', 'veertig', 'vijftig', 'zestig', 'zeventig', 'tachtig', 'negentig'];

/**
 * Wrap a transcript into at most `maxLines` lines for rendering. The parser does
 * not care about line breaks (whitespace is whitespace), so this only affects how
 * the image looks - and the observed samples do wrap a long list onto two lines.
 */
export function wrapTranscript(transcript, { maxChars = 40, maxLines = 2 } = {}) {
  const words = String(transcript).split(' ');
  if (transcript.length <= maxChars || maxLines <= 1) return [transcript];
  const lines = [];
  let current = '';
  for (const word of words) {
    if (current && `${current} ${word}`.length > maxChars && lines.length < maxLines - 1) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** A valid arithmetic item, retrying the draw until the real calculator accepts it. */
export function drawArithmetic(rand) {
  const opWords = ['plus', 'min', 'keer', 'gedeeld'];
  const numbers = [...UNIT_WORDS, ...TENS_WORDS];
  for (let attempt = 0; attempt < 200; attempt++) {
    const aWord = numbers[Math.floor(rand() * numbers.length)];
    const bWord = numbers[Math.floor(rand() * numbers.length)];
    const op = opWords[Math.floor(rand() * opWords.length)];
    const item = buildArithmetic({ aWord, op, bWord });
    if (item) return item;
  }
  return null;
}

/**
 * The real text path: repair -> parse -> Tier 0 -> validate. Shared by the corpus
 * builder and the accuracy runner so a fixture and its measurement cannot diverge.
 */
export function solveText(transcript) {
  const normalized = normalizeTranscript(transcript).text;
  const parsed = parsePuzzle(normalized);
  const solved = solveTier0(parsed);
  const validation = solved ? validateAnswer(parsed.class, solved.answer) : { ok: false };
  return { normalized, parsed, solved, validation };
}

/** Assert a built text item is genuinely solvable offline, or throw naming it. */
export function assertSolvable(item, id) {
  // Mirror the real text path: repair first, then parse. A raw-transcript check
  // would fail every damaged fixture even though the repair layer handles it.
  const { parsed, solved, validation } = solveText(item.transcript);
  if (!solved) throw new Error(`corpus fixture ${id} did not parse into a solvable puzzle: ${item.transcript}`);
  if (!validation.ok) throw new Error(`corpus fixture ${id} produced an invalid answer: ${solved.answer}`);
  if (validation.answer !== item.expected) {
    throw new Error(`corpus fixture ${id} expected ${item.expected} but the solver gives ${validation.answer}`);
  }
  return true;
}

/**
 * Light, realistic OCR damage: the single-character confusions `transcript.js`
 * knows how to undo. Kept separate from the clean fixtures so a repair failure is
 * attributable to the repair layer rather than to the lexicon.
 */
const CONFUSIONS = [
  ['i', 'j'],
  ['s', '5'],
  ['o', '0'],
  ['m', 'rn'],
  ['w', 'vv'],
  ['d', 'cl'],
  ['u', 'ii'],
  ['h', 'lj'],
];

/** Damage one token along a known confusion, at most once per transcript. */
export function damageTranscript(transcript, rand) {
  const tokens = transcript.split(' ');
  // Only consider (token, confusion) pairs that actually apply, so the function
  // never returns a no-op just because it drew an un-damageable token.
  const candidates = [];
  tokens.forEach((token, index) => {
    if (token.length < 3 || !/^[a-zà-ÿ]+$/.test(token)) return;
    for (const [from, to] of CONFUSIONS) {
      const at = token.indexOf(from);
      if (at !== -1) candidates.push({ index, token, at, from, to });
    }
  });
  if (candidates.length === 0) return null;
  const pick = candidates[Math.floor(rand() * candidates.length)];
  const damaged = pick.token.slice(0, pick.at) + pick.to + pick.token.slice(pick.at + pick.from.length);
  const out = [...tokens];
  out[pick.index] = damaged;
  return out.join(' ');
}

/**
 * Build `n` clean text fixtures spread across every offline category and class.
 * `kind` is left to the caller (synthetic or derived).
 */
export function buildTextFixtures({ count, seed = 1 } = {}) {
  const rand = seededRandom(seed);
  const items = [];
  const categories = OFFLINE_CATEGORIES.filter((c) => c !== 'getal');
  while (items.length < count) {
    // Class and category are indexed off the number of *emitted* items, not the
    // loop counter, so a skipped ordinal does not shift the category/class pairing
    // into a fixed correlation (which once left whole categories unexercised).
    const index = items.length;
    const category = categories[Math.floor(index / 3) % categories.length];
    const matchCount = 1 + Math.floor(rand() * Math.min(4, CATEGORIES[category].length));
    const distractorCount = Math.floor(rand() * 4);
    let item;
    const classWanted = index % 3;
    if (classWanted === 0) {
      item = buildCount({ category, matchCount, distractorCount, rand });
      item.id = `text-count-${category}-${items.length}`;
    } else if (classWanted === 1) {
      const ordinal = ORDINALS[Math.floor(rand() * ORDINALS.length)];
      item = buildOrdinal({ category, ordinal, matchCount, distractorCount, rand });
      if (!item) continue;
      item.id = `text-ordinal-${category}-${items.length}`;
    } else {
      item = drawArithmetic(rand);
      if (!item) continue;
      item.id = `text-arith-${items.length}`;
    }
    assertSolvable(item, item.id);
    items.push(item);
  }
  return items;
}

/** Damaged copies of the fixtures above, for the repair layer. */
export function buildDamagedTextFixtures({ count, seed = 2, source = null } = {}) {
  const rand = seededRandom(seed);
  const base = source ?? buildTextFixtures({ count: count * 6, seed: seed + 1 });
  const items = [];
  for (const item of base) {
    if (items.length >= count) break;
    const damaged = damageTranscript(item.transcript, rand);
    if (!damaged || damaged === item.transcript) continue;
    const candidate = { ...item, transcript: damaged, undamaged: item.transcript, id: item.id.replace(/^text-/, 'damaged-') };
    // Only keep damage the repair layer can actually undo. Unrepairable damage is
    // model-tier work, not an offline corpus item; including it would measure the
    // model tier's absence and call it a repair failure.
    try {
      assertSolvable(candidate, candidate.id);
    } catch {
      continue;
    }
    items.push(candidate);
  }
  return items;
}

/**
 * A small set of deliberate edge cases the random draw would rarely produce:
 * a zero-match count, a `laatste` pick, and integer division. Each is asserted
 * solvable like every other fixture, so an edge case can never ship broken.
 */
export function buildEdgeTextFixtures() {
  const items = [
    { id: 'edge-count-zero', class: 'count', category: 'kleur',
      transcript: 'hoeveel kleuren in lijst hond tafel stoel', expected: '0',
      list: ['hond', 'tafel', 'stoel'] },
    { id: 'edge-count-all', class: 'count', category: 'dier',
      transcript: 'hoeveel dieren in lijst hond kat paard koe', expected: '4',
      list: ['hond', 'kat', 'paard', 'koe'] },
    { id: 'edge-ordinal-last', class: 'ordinal-pick', category: 'kleur',
      transcript: 'in de lijst rood hond blauw kat groen wat is de/het laatste kleur', expected: 'groen',
      list: ['rood', 'hond', 'blauw', 'kat', 'groen'] },
    { id: 'edge-arith-divide', class: 'arithmetic', category: null, list: [],
      transcript: 'wat is twintig gedeeld door vijf', expected: '4' },
    { id: 'edge-arith-negative', class: 'arithmetic', category: null, list: [],
      transcript: 'wat is drie min tien', expected: '-7' },
  ];
  for (const item of items) assertSolvable(item, item.id);
  return items;
}

const IMAGE_CLASS_CYCLE = ['count', 'ordinal-pick', 'count', 'arithmetic'];

/**
 * Logical specs for the synthetic images. The caller renders and verifies them;
 * this function only guarantees the expected answer is correct by construction.
 */
export function buildImageSpecs({ count = 36, seed = 7 } = {}) {
  const rand = seededRandom(seed);
  const categories = OFFLINE_CATEGORIES.filter((c) => c !== 'getal');
  const specs = [];
  let n = 0;
  while (specs.length < count) {
    n++;
    const klass = IMAGE_CLASS_CYCLE[specs.length % IMAGE_CLASS_CYCLE.length];
    if (klass === 'count') {
      const category = categories[n % categories.length];
      const item = buildCount({
        category,
        matchCount: Math.floor(rand() * 5),
        distractorCount: 1 + Math.floor(rand() * 4),
        rand,
      });
      specs.push({ ...item, id: `synthetic-count-${specs.length}`, seed: seed * 1000 + specs.length });
    } else if (klass === 'ordinal-pick') {
      const category = categories[n % categories.length];
      const ordinal = ORDINALS[Math.floor(rand() * ORDINALS.length)];
      const item = buildOrdinal({ category, ordinal, matchCount: 2 + Math.floor(rand() * 3), distractorCount: Math.floor(rand() * 3), rand });
      if (!item) continue;
      assertSolvable(item, `synthetic-ordinal-${specs.length}`);
      specs.push({ ...item, id: `synthetic-ordinal-${specs.length}`, seed: seed * 1000 + specs.length });
    } else {
      const item = drawArithmetic(rand);
      if (!item) continue;
      specs.push({ ...item, id: `synthetic-arith-${specs.length}`, seed: seed * 1000 + specs.length });
    }
  }
  return specs;
}
