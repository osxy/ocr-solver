/**
 * Dutch number words and arithmetic.
 *
 * This is the Tier 0 fast path: puzzles like "Wat is acht min een?" are solved
 * entirely offline, deterministically, in microseconds. It also acts as a
 * cross-check on whatever a language model returns for the same puzzle.
 */

export const UNITS = {
  nul: 0, een: 1, twee: 2, drie: 3, vier: 4, vijf: 5, zes: 6, zeven: 7, acht: 8,
  negen: 9, tien: 10, elf: 11, twaalf: 12, dertien: 13, veertien: 14, vijftien: 15,
  zestien: 16, zeventien: 17, achttien: 18, negentien: 19,
};

export const TENS = {
  twintig: 20, dertig: 30, veertig: 40, vijftig: 50,
  zestig: 60, zeventig: 70, tachtig: 80, negentig: 90,
};

const SMALL = { ...UNITS, ...TENS };

/** Strip combining diacritics so 'drieënveertig' matches the 'drie' + 'en' + 'veertig' rule. */
function undiacritic(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Parse a Dutch number word up to 999. Returns null when it is not a number word. */
export function parseNumberWord(word) {
  if (!word) return null;
  const w = undiacritic(word.toLowerCase());
  if (w in SMALL) return SMALL[w];
  if (w === 'honderd') return 100;
  if (w === 'duizend') return 1000;

  // eenentwintig, drieënveertig, ...
  const unitTens = /^([a-z]+?)en(twintig|dertig|veertig|vijftig|zestig|zeventig|tachtig|negentig)$/.exec(w);
  if (unitTens) {
    const u = SMALL[unitTens[1]];
    if (u >= 1 && u <= 9) return TENS[unitTens[2]] + u;
  }

  // honderd, tweehonderd, driehonderdvijf, ...
  const hundreds = /^([a-z]*?)honderd(.*)$/.exec(w);
  if (hundreds) {
    const [, prefix, rest] = hundreds;
    let h = 1;
    if (prefix) {
      h = SMALL[prefix];
      if (h == null || h < 1 || h > 9) return null;
    }
    if (!rest) return h * 100;
    const tail = parseNumberWord(rest);
    if (tail == null || tail >= 100) return null;
    return h * 100 + tail;
  }

  return null;
}

export const OPERATORS = {
  plus: '+', bij: '+', 'erbij': '+', optellen: '+', 'opgeteld': '+', 'en': '+',
  min: '-', minus: '-', minder: '-', eraf: '-', aftrekken: '-', 'afgetrokken': '-',
  keer: '*', maal: '*', x: '*', vermenigvuldigen: '*', 'vermenigvuldigd': '*',
  gedeeld: '/', delen: '/', 'gedeeld_door': '/',
};

/** Rewrite multi-word operators so they become single tokens. */
export function normalizeOperatorPhrases(text) {
  return text
    .replace(/\bgedeeld\s+door\b/gi, ' gedeeld ')
    .replace(/\bkeer\s+door\b/gi, ' keer ')
    .replace(/\bvermenigvuldigd\s+met\b/gi, ' vermenigvuldigd ')
    .replace(/\bopgeteld\s+bij\b/gi, ' opgeteld ')
    .replace(/\bafgetrokken\s+van\b/gi, ' afgetrokken ');
}

/**
 * Parse a token sequence into an arithmetic expression.
 * Accepts both number words and literal digits. Returns null if it is not
 * a clean arithmetic expression, so callers can fall back to the model.
 */
export function parseExpression(text) {
  const tokens = undiacritic(normalizeOperatorPhrases(text).toLowerCase())
    .replace(/[?.!,]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    // drop leading sentence scaffolding
    .filter((t, i, arr) => !(i < 4 && ['wat', 'is', 'hoeveel', 'hoe', 'bereken', 'de', 'het'].includes(t)));

  const terms = [];
  for (const tok of tokens) {
    if (/^\d+$/.test(tok)) {
      terms.push({ type: 'number', value: Number(tok) });
      continue;
    }
    // split an operator glued to digits, e.g. "8-1"
    const glued = /^(\d+)([+\-*/])(\d+)$/.exec(tok);
    if (glued) {
      terms.push({ type: 'number', value: Number(glued[1]) });
      terms.push({ type: 'operator', value: glued[2] });
      terms.push({ type: 'number', value: Number(glued[3]) });
      continue;
    }
    if (tok in OPERATORS) {
      terms.push({ type: 'operator', value: OPERATORS[tok] });
      continue;
    }
    const n = parseNumberWord(tok);
    if (n != null) {
      terms.push({ type: 'number', value: n });
      continue;
    }
    terms.push({ type: 'unknown', value: tok });
  }

  // require a clean alternating number/operator/number shape with no unknowns
  if (terms.length < 3 || terms.length % 2 === 0) return null;
  if (terms.some((t) => t.type === 'unknown')) return null;
  for (let i = 0; i < terms.length; i++) {
    const wantOperator = i % 2 === 1;
    if (wantOperator && terms[i].type !== 'operator') return null;
    if (!wantOperator && terms[i].type !== 'number') return null;
  }
  return terms;
}

/** Left-to-right evaluation honouring * and / precedence. */
export function evaluateTerms(terms) {
  const values = [];
  const ops = [];
  const apply = () => {
    const op = ops.pop();
    const b = values.pop();
    const a = values.pop();
    if (op === '+') values.push(a + b);
    else if (op === '-') values.push(a - b);
    else if (op === '*') values.push(a * b);
    else if (op === '/') values.push(b === 0 ? NaN : a / b);
  };
  const precedence = { '+': 1, '-': 1, '*': 2, '/': 2 };
  for (const term of terms) {
    if (term.type === 'number') {
      values.push(term.value);
    } else {
      while (ops.length && precedence[ops[ops.length - 1]] >= precedence[term.value]) apply();
      ops.push(term.value);
    }
  }
  while (ops.length) apply();
  const result = values[0];
  return Number.isFinite(result) ? result : null;
}

/**
 * Solve an arithmetic puzzle written in Dutch words.
 * Returns { answer, expression, terms } or null.
 */
export function solveArithmetic(text) {
  const terms = parseExpression(text);
  if (!terms) return null;
  const value = evaluateTerms(terms);
  if (value == null) return null;
  if (!Number.isInteger(value)) return null;
  const expression = terms.map((t) => t.value).join(' ');
  return { answer: String(value), expression, terms };
}
