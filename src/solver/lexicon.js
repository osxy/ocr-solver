/**
 * Dutch domain lexicon.
 *
 * Two jobs:
 *  1. OCR repair - snap a garbled token to the nearest known word.
 *  2. Offline semantics - decide whether a word belongs to a category, which is
 *     what makes `count` and `ordinal-pick` puzzles solvable without a network call.
 *
 * The categories are deliberately the ones this puzzle generator draws from:
 * colours, body parts, animals, fruits, numbers.
 */

export const CATEGORIES = {
  kleur: [
    'rood', 'blauw', 'groen', 'geel', 'paars', 'oranje', 'roze', 'bruin', 'zwart',
    'wit', 'grijs', 'lila', 'turkoois', 'beige', 'goud', 'zilver', 'roodbruin',
    'lichtblauw', 'donkerblauw', 'donkergroen', 'lichtgroen',
  ],
  lichaamsdeel: [
    'hoofd', 'haar', 'oog', 'ogen', 'oor', 'oren', 'neus', 'mond', 'tand', 'tanden',
    'lip', 'lippen', 'kin', 'nek', 'keel', 'schouder', 'oksel', 'arm', 'elleboog',
    'pols', 'hand', 'handen', 'vinger', 'vingers', 'duim', 'nagel', 'borst', 'buik',
    'rug', 'heup', 'been', 'benen', 'knie', 'scheen', 'enkel', 'voet', 'voeten',
    'teen', 'tenen', 'hart', 'longen', 'maag', 'lever', 'nieren', 'hersenen',
    'wenkbrauw', 'wimper', 'wang', 'voorhoofd', 'hiel', 'dij',
  ],
  dier: [
    'hond', 'kat', 'paard', 'koe', 'varken', 'schaap', 'geit', 'kip', 'haan', 'vogel',
    'vis', 'olifant', 'aap', 'leeuw', 'tijger', 'beer', 'muis', 'rat', 'konijn',
    'hert', 'vos', 'wolf', 'slang', 'kikker', 'eend', 'uil', 'gans', 'ezel', 'hamster',
    'cavia', 'papegaai', 'schildpad', 'giraffe', 'zebra', 'neushoorn', 'nijlpaard',
    'krokodil', 'pinguïn', 'dolfijn', 'walvis', 'haai', 'vlinder', 'bij', 'mier', 'spin',
  ],
  vrucht: [
    'appel', 'peer', 'banaan', 'citroen', 'sinaasappel', 'druif', 'druiven', 'aardbei',
    'kers', 'kersen', 'meloen', 'kiwi', 'perzik', 'pruim', 'ananas', 'mango', 'framboos',
    'bosbes', 'braam', 'abrikoos', 'nectarine', 'watermeloen', 'mandarijn', 'papaya',
  ],
  groente: [
    'wortel', 'aardappel', 'tomaat', 'komkommer', 'sla', 'ui', 'prei', 'boon', 'bonen',
    'erwt', 'erwten', 'broccoli', 'bloemkool', 'spinazie', 'paprika', 'courgette',
    'aubergine', 'kool', 'radijs', 'asperge',
  ],
  getal: [
    'nul', 'een', 'twee', 'drie', 'vier', 'vijf', 'zes', 'zeven', 'acht', 'negen',
    'tien', 'elf', 'twaalf', 'dertien', 'veertien', 'vijftien', 'zestien', 'zeventien',
    'achttien', 'negentien', 'twintig', 'dertig', 'veertig', 'vijftig', 'zestig',
    'zeventig', 'tachtig', 'negentig', 'honderd', 'duizend',
  ],
};

/** Singular/plural category names as they appear in the question text. */
export const CATEGORY_ALIASES = {
  kleur: 'kleur', kleuren: 'kleur',
  lichaamsdeel: 'lichaamsdeel', lichaamsdelen: 'lichaamsdeel', lichaam: 'lichaamsdeel',
  dier: 'dier', dieren: 'dier',
  vrucht: 'vrucht', vruchten: 'vrucht', fruit: 'vrucht',
  groente: 'groente', groenten: 'groente',
  getal: 'getal', getallen: 'getal', cijfer: 'getal', cijfers: 'getal',
  nummer: 'getal', nummers: 'getal',
};

/** Question scaffolding and operators. These are the tokens worth repairing. */
export const FUNCTION_WORDS = [
  'wat', 'is', 'de', 'het', 'een', 'in', 'op', 'van', 'met', 'en', 'of', 'niet',
  'lijst', 'lijstje', 'rij', 'reeks', 'reeksje', 'volgorde',
  'hoeveel', 'hoe', 'veel', 'aantal', 'tel', 'tellen',
  'eerste', 'tweede', 'derde', 'vierde', 'vijfde', 'zesde', 'zevende', 'achtste',
  'negende', 'tiende', 'laatste', 'middelste', 'volgende', 'vorige',
  'plus', 'min', 'keer', 'maal', 'gedeeld', 'door', 'optellen', 'aftrekken',
  'vermenigvuldigen', 'delen', 'som', 'verschil', 'uitkomst', 'antwoord',
  'welke', 'welk', 'behoort', 'hoort', 'bij', 'zit', 'staat', 'staan', 'komt',
  'voor', 'na', 'als', 'dan', 'dezelfde', 'zelfde', 'ander', 'andere',
];

const CATEGORY_INDEX = new Map();
for (const [category, words] of Object.entries(CATEGORIES)) {
  for (const w of words) {
    if (!CATEGORY_INDEX.has(w)) CATEGORY_INDEX.set(w, new Set());
    CATEGORY_INDEX.get(w).add(category);
  }
}

export const KNOWN_WORDS = new Set([
  ...CATEGORY_INDEX.keys(),
  ...FUNCTION_WORDS,
  ...Object.keys(CATEGORY_ALIASES),
]);

/** Categories a word belongs to, e.g. 'wit' -> {'kleur'}. */
export function categoriesOf(word) {
  return CATEGORY_INDEX.get(word) ?? new Set();
}

export function isKnownWord(word) {
  return KNOWN_WORDS.has(word);
}

export function isCategory(word, category) {
  return CATEGORY_INDEX.get(word)?.has(category) ?? false;
}

/** Resolve a category name (singular or plural) from the question text. */
export function resolveCategory(word) {
  return CATEGORY_ALIASES[word] ?? null;
}

/** Levenshtein distance with an early exit once `max` is exceeded. */
export function editDistance(a, b, max = Infinity) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Find the closest known word within `maxDistance`.
 * Returns null when nothing is close enough, so callers can leave unknown
 * distractor words alone instead of forcing them into the lexicon.
 */
export function nearestKnownWord(word, maxDistance = 2) {
  let best = null;
  let bestDist = maxDistance + 1;
  for (const candidate of KNOWN_WORDS) {
    const d = editDistance(word, candidate, maxDistance);
    if (d < bestDist) {
      bestDist = d;
      best = candidate;
      if (d === 0) break;
    }
  }
  return bestDist <= maxDistance ? { word: best, distance: bestDist } : null;
}
