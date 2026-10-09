/**
 * Real OCR damage, observed on the three real puzzle images.
 *
 * Each string is an error Tesseract actually produced on that exact image while
 * the preprocessing constants were being tuned. They are the only honest fixtures
 * for the repair layer: damage we invent ourselves tests our imagination, while
 * these test a mistake the OCR really makes. `scripts/live-eval.js` and the corpus
 * builder both read from here, so the derived fixtures and the live evaluation can
 * never drift apart.
 */
export const OBSERVED_OCR_DAMAGE = {
  '001-count-kleuren.png': 'Hoeveel kleuren in lijst wit kw: hoofd paars olifant aap?',
  '002-ordinal-lichaamsdeel.png':
    'In de lijst lijst hoofd buik citroen borst olifant paard wat 1s de/het eerste lichaamsdeel?',
  '003-arithmetic-acht-min-een.png': 'Wat js acht min een?',
};
