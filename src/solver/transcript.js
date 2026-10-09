/**
 * Transcript cleanup and OCR repair.
 *
 * Tesseract's residue on this corpus is small but real: 'Wat js acht min een?'
 * (a broken 's' read as 'j'), 'hoof d' (a split glyph), 'cen' for 'een'.
 * A bounded, dictionary-guided repair fixes these deterministically and offline.
 *
 * Repair is deliberately conservative: a token is only rewritten when it is
 * unknown AND close to a known word. Distractor words that we simply do not have
 * in the lexicon are left untouched rather than being force-fitted, because
 * silently turning an unknown word into a known one would corrupt word counts.
 */
import { isKnownWord, nearestKnownWord, KNOWN_WORDS } from './lexicon.js';

/**
 * Characters Tesseract mixes up on this artwork, and what they may really be.
 * A broken 'i' next to 's' is the classic failure here: 'is' is read as 'js'.
 * Restricting short-token repair to these substitutions keeps it safe, because
 * an unknown list item only gets rewritten along a confusion the OCR really makes.
 */
const CHAR_CONFUSIONS = {
  j: ['i'],
  '1': ['i', 'l'],
  '5': ['s'],
  '0': ['o'],
  '8': ['b'],
  '6': ['b'],
  l: ['i'],
  i: ['l'],
  s: ['5'],
  o: ['0'],
};

/** Multi-character misreads. */
const DIGRAPH_CONFUSIONS = [
  ['rn', 'm'],
  ['vv', 'w'],
  ['cl', 'd'],
  ['ii', 'u'],
  ['lj', 'h'],
];

/**
 * Strip characters Tesseract hallucinates around this artwork.
 * Note: leading AND trailing punctuation is removed outright, so 'aap?' -> 'aap'
 * and 'lichaamsdeel?' -> 'lichaamsdeel'. Internal slashes survive, so the
 * question phrasing 'de/het' stays intact.
 */
function cleanToken(token) {
  return token
    .toLowerCase()
    .replace(/[«»""''`´‚„]/g, '')
    .replace(/^[^a-zà-ÿ0-9]+/, '')
    .replace(/[^a-zà-ÿ0-9]+$/, '')
    .replace(/\s+/g, '');
}

/**
 * Split hyphenated artefacts such as 'lijst-lijst' or 'buik-' into separate
 * tokens, but only when the whole token is not already a real word.
 */
function expandHyphens(token) {
  const lower = token.toLowerCase();
  if (!lower.includes('-') || isKnownWord(lower)) return [token];
  return lower.split('-');
}

/**
 * 'js' -> 'is', '1s' -> 'is', 'kiw1' -> 'kiwi', by walking known confusions
 * until the result is a real word. Works for tokens of any length.
 */
function repairConfusions(token) {
  const chars = [...token];

  for (let i = 0; i < chars.length - 1; i++) {
    const pair = chars[i] + chars[i + 1];
    for (const [from, to] of DIGRAPH_CONFUSIONS) {
      if (pair !== from) continue;
      const attempt = chars.slice(0, i).join('') + to + chars.slice(i + 2).join('');
      if (isKnownWord(attempt)) return attempt;
    }
  }

  for (let i = 0; i < chars.length; i++) {
    for (const candidate of CHAR_CONFUSIONS[chars[i]] ?? []) {
      const attempt = chars.map((c, j) => (j === i ? candidate : c)).join('');
      if (isKnownWord(attempt)) return attempt;
    }
  }

  return null;
}

/**
 * Rewrite the transcript into clean, lowercased tokens.
 * Returns { text, tokens, repairs, unknownTokens }.
 */
export function normalizeTranscript(raw) {
  const repairs = [];
  let tokens = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .flatMap(expandHyphens)
    .map(cleanToken)
    .filter(Boolean);

  // 1. Re-join a single stray character onto the previous token when the result
  //    is a real word: 'hoof d' -> 'hoofd'.
  const merged = [];
  for (const tok of tokens) {
    const prev = merged[merged.length - 1];
    if (tok.length === 1 && prev && isKnownWord(prev + tok)) {
      repairs.push({ from: `${prev} ${tok}`, to: prev + tok, rule: 'rejoin' });
      merged[merged.length - 1] = prev + tok;
      continue;
    }
    merged.push(tok);
  }
  tokens = merged;

  // 2. Per-token repair for anything not already a known word.
  const out = [];
  for (const tok of tokens) {
    if (isKnownWord(tok)) {
      out.push(tok);
      continue;
    }
    // Safe at any length: only rewrites along a confusion the OCR actually makes.
    const confused = repairConfusions(tok);
    if (confused) {
      repairs.push({ from: tok, to: confused, rule: 'confusion' });
      out.push(confused);
      continue;
    }
    // Only attempt fuzzy repair on tokens long enough to be meaningful.
    if (tok.length >= 3 && /^[a-zà-ÿ]+$/.test(tok)) {
      const maxDistance = tok.length <= 4 ? 1 : 2;
      const near = nearestKnownWord(tok, maxDistance);
      if (near && near.word !== tok) {
        repairs.push({ from: tok, to: near.word, rule: `edit-distance-${near.distance}` });
        out.push(near.word);
        continue;
      }
    }
    out.push(tok);
  }

  const unknownTokens = out.filter((t) => !isKnownWord(t) && !/^\d+$/.test(t) && t !== 'de/het');
  return { text: out.join(' '), tokens: out, repairs, unknownTokens };
}

/** Tokens that carry no puzzle meaning and can be ignored by the parser. */
export const STOPWORDS = new Set([
  'wat', 'is', 'de', 'het', 'een', 'in', 'op', 'van', 'met', 'en', 'of',
  'lijst', 'lijstje', 'rij', 'reeks', 'hoeveel', 'hoe', 'veel', 'aantal',
  'welke', 'welk', 'zit', 'staat', 'staan', 'komt', 'voor', 'bij', 'hoort', 'behoort',
]);

export { KNOWN_WORDS };
