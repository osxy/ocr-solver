/**
 * Puzzle classification, parsing and the Tier 0 (offline) solver.
 *
 * Three puzzle shapes are handled, all observed in the corpus:
 *   count        "Hoeveel kleuren in lijst wit kiwi hoofd paars olifant aap?"
 *   ordinal-pick "In de lijst hoofd buik citroen ... wat is de/het eerste lichaamsdeel?"
 *   arithmetic   "Wat is acht min een?"
 *
 * `count` and `ordinal-pick` are solvable with no network at all because the
 * lexicon knows which words are colours, body parts, animals and fruits.
 * That makes Tier 0 a genuine solver, not just a fallback - and it gives an
 * independent answer to cross-check whatever a model returns later.
 */
import { resolveCategory, isCategory, isKnownWord } from './lexicon.js';
import { solveArithmetic } from './numbers.js';

export const PUZZLE_CLASS = {
  COUNT: 'count',
  ORDINAL_PICK: 'ordinal-pick',
  ARITHMETIC: 'arithmetic',
  UNKNOWN: 'unknown',
};

const ORDINALS = {
  eerste: { index: 0, from: 'start' },
  tweede: { index: 1, from: 'start' },
  derde: { index: 2, from: 'start' },
  vierde: { index: 3, from: 'start' },
  vijfde: { index: 4, from: 'start' },
  zesde: { index: 5, from: 'start' },
  zevende: { index: 6, from: 'start' },
  achtste: { index: 7, from: 'start' },
  negende: { index: 8, from: 'start' },
  tiende: { index: 9, from: 'start' },
  laatste: { index: 0, from: 'end' },
};

/** Index just past the "in (de) lijst" scaffolding phrase, or -1. */
function listPhraseEnd(tokens) {
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i] !== 'in') continue;
    let j = i + 1;
    if (tokens[j] === 'de' || tokens[j] === 'het') j++;
    if (tokens[j] === 'lijst' || tokens[j] === 'lijstje' || tokens[j] === 'rij' || tokens[j] === 'reeks') {
      return j + 1;
    }
  }
  return -1;
}

/** The word right after an ordinal, skipping articles. */
function categoryAfterOrdinal(tokens, ordinalIndex) {
  for (let i = ordinalIndex + 1; i < Math.min(tokens.length, ordinalIndex + 4); i++) {
    const word = tokens[i];
    if (word === 'de/het' || word === 'de' || word === 'het') continue;
    const category = resolveCategory(word);
    if (category) return { category, word, index: i };
  }
  return null;
}

/**
 * Work out what kind of puzzle this is and pull out its structure.
 * Returns a plain object so it can be logged and unit tested directly.
 */
export function parsePuzzle(text) {
  const tokens = String(text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const base = { tokens, category: null, list: [], ordinal: null, categoryWord: null };

  // Arithmetic is the most specific shape: it must parse as a clean expression.
  const arithmetic = solveArithmetic(text);
  if (arithmetic) {
    return { ...base, class: PUZZLE_CLASS.ARITHMETIC, arithmetic };
  }

  // "Hoeveel <categorie> in lijst <items>"
  const hoeveelIndex = tokens.indexOf('hoeveel');
  if (hoeveelIndex !== -1) {
    let category = null;
    let categoryWord = null;
    for (let i = hoeveelIndex + 1; i < Math.min(tokens.length, hoeveelIndex + 4); i++) {
      const resolved = resolveCategory(tokens[i]);
      if (resolved) {
        category = resolved;
        categoryWord = tokens[i];
        break;
      }
    }
    if (category) {
      let start = listPhraseEnd(tokens);
      if (start === -1) start = tokens.findIndex((t) => resolveCategory(t) === category) + 1;
      const list = tokens.slice(start).filter((t) => t !== '?' && t !== 'de/het');
      return { ...base, class: PUZZLE_CLASS.COUNT, category, categoryWord, list };
    }
  }

  // "In de lijst <items> wat is de/het <ordinal> <categorie>"
  for (const [ordinalWord, ordinal] of Object.entries(ORDINALS)) {
    const ordinalIndex = tokens.indexOf(ordinalWord);
    if (ordinalIndex === -1) continue;
    const found = categoryAfterOrdinal(tokens, ordinalIndex);
    if (!found) continue;

    let start = listPhraseEnd(tokens);
    if (start === -1) start = 0;
    const watIndex = tokens.lastIndexOf('wat', ordinalIndex);
    let end = watIndex > start ? watIndex : ordinalIndex;
    const list = tokens.slice(start, end).filter((t) => t !== '?' && t !== 'de/het');
    if (list.length === 0) continue;

    return {
      ...base,
      class: PUZZLE_CLASS.ORDINAL_PICK,
      category: found.category,
      categoryWord: found.word,
      ordinal: { word: ordinalWord, ...ordinal },
      list,
    };
  }

  return { ...base, class: PUZZLE_CLASS.UNKNOWN };
}

/**
 * Solve a parsed puzzle with no network access.
 * Returns null when the puzzle needs real reasoning (the model path).
 *
 * `confident` is false when the word list contains tokens the lexicon does not
 * recognise, because a misread item would silently change a count.
 */
export function solveTier0(parsed) {
  if (parsed.class === PUZZLE_CLASS.ARITHMETIC) {
    return {
      answer: parsed.arithmetic.answer,
      method: 'tier0:arithmetic',
      confident: true,
      detail: parsed.arithmetic.expression,
    };
  }

  if (parsed.class === PUZZLE_CLASS.COUNT) {
    const matches = parsed.list.filter((w) => isCategory(w, parsed.category));
    const unknown = parsed.list.filter((w) => !isKnownWord(w));
    return {
      answer: String(matches.length),
      method: 'tier0:count',
      confident: unknown.length === 0,
      detail: `${matches.length} of ${parsed.list.length} (${matches.join(', ') || 'none'})` +
        (unknown.length ? ` unknown=[${unknown.join(', ')}]` : ''),
    };
  }

  if (parsed.class === PUZZLE_CLASS.ORDINAL_PICK) {
    const matches = parsed.list.filter((w) => isCategory(w, parsed.category));
    const unknown = parsed.list.filter((w) => !isKnownWord(w));
    if (matches.length === 0) return null;
    const answer = parsed.ordinal.from === 'end' ? matches[matches.length - 1] : matches[parsed.ordinal.index];
    if (!answer) return null;
    return {
      answer,
      method: 'tier0:ordinal-pick',
      confident: unknown.length === 0,
      detail: `matches=[${matches.join(', ')}]` + (unknown.length ? ` unknown=[${unknown.join(', ')}]` : ''),
    };
  }

  return null;
}
