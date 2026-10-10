/**
 * Which OCR languages this installation can actually load, and what happens when a
 * configured one cannot be.
 *
 * The app is offline-first: traineddata must be present in `node_modules`, so a
 * language is usable exactly when its `@tesseract.js-data/<code>` package resolves
 * from this installation. The set is discovered, not hardcoded — `npm install
 * @tesseract.js-data/eng` makes `eng` available without a code change.
 *
 * There is deliberately **no fallback**. If a configured language has no bundled
 * data, this module refuses by name instead of quietly loading `nld`: silently OCRing
 * an English puzzle with Dutch data is the same defect as a config key that does
 * nothing (issue #143).
 *
 * tesseract.js loads every language from a single `langPath`, and each
 * `@tesseract.js-data/<code>` package ships its own directory, so a set that spans two
 * packages is refused rather than half-loaded. In practice only `nld` is a dependency,
 * so the single-package case is the one that runs; the check exists so installing a
 * second package cannot turn into a silent partial load.
 */
import { createRequire } from 'node:module';

const requireFromHere = createRequire(import.meta.url);

/** The language the app ships with, and the default when none is configured. */
export const DEFAULT_OCR_LANGUAGE = 'nld';

/** A configured OCR language that cannot be loaded offline. Names the language. */
export class OcrLanguageUnavailableError extends Error {
  constructor(language, message) {
    super(message);
    this.name = 'OcrLanguageUnavailableError';
    this.language = language;
  }
}

/**
 * The bundled package metadata for one language, or `null` when it is not installed.
 *
 * `createRequire` resolves relative to this file, so it finds the app's own
 * `node_modules` regardless of the process working directory. The package is tiny
 * (an `index.js` and a `langPath`), so requiring it is cheap and cached.
 */
export function bundledLanguage(code) {
  if (typeof code !== 'string' || code.trim() === '') return null;
  const name = code.trim();
  try {
    const pkg = requireFromHere(`@tesseract.js-data/${name}`);
    return {
      code: typeof pkg.code === 'string' && pkg.code !== '' ? pkg.code : name,
      langPath: pkg.langPath,
      // tesseract.js reads the shipped `.gz`; the packages set `gzip: true`, but a
      // future plain-`.traineddata` package would not, so carry the flag through.
      gzip: pkg.gzip !== false,
    };
  } catch {
    // MODULE_NOT_FOUND is the expected miss; anything else is also "cannot load it",
    // and both must surface as a named refusal rather than a fallback.
    return null;
  }
}

/** The refusal sentence for `code`; naming the language, the offline rule and the install. */
function unavailableMessage(code) {
  return (
    `"${code}" has no bundled traineddata: PuzzleSolver only uses OCR data installed under ` +
    `node_modules and never downloads it at runtime, so "${code}" cannot be used offline. ` +
    `The app ships "nld"; install another language with \`npm install @tesseract.js-data/${code}\`, ` +
    'or remove it from ocr.languages.'
  );
}

/**
 * Resolve configured language codes to one tesseract.js call.
 *
 * @param {string[]|string} [codes]
 * @param {{ load?: (code: string) => object|null }} [options] `load` is injected by the
 *   tests so the resolver can be exercised without installing a second language package.
 * @returns {{ lang: string, langPath: string, gzip: boolean }}
 * @throws {OcrLanguageUnavailableError} for an empty list, an uninstalled language, or a
 *   set that spans more than one traineddata directory.
 */
export function resolveOcrLanguages(codes = [DEFAULT_OCR_LANGUAGE], { load = bundledLanguage } = {}) {
  const requested = [...new Set((Array.isArray(codes) ? codes : [codes]).map((c) => String(c).trim()).filter(Boolean))];
  if (requested.length === 0) {
    throw new OcrLanguageUnavailableError('', 'ocr.languages must name at least one language');
  }

  const packages = requested.map((code) => {
    const pkg = load(code);
    if (!pkg) throw new OcrLanguageUnavailableError(code, unavailableMessage(code));
    return { ...pkg, requested: code };
  });

  const langPaths = [...new Set(packages.map((pkg) => pkg.langPath))];
  if (langPaths.length > 1) {
    throw new OcrLanguageUnavailableError(
      requested.join(', '),
      `the requested languages (${requested.join(', ')}) ship in separate traineddata directories and ` +
        'Tesseract loads every language from one directory; install a single language or a package that ' +
        'ships them together'
    );
  }

  return {
    // Use each package's own `code`, so a package that normalises its name is loaded
    // under the name its traineddata file actually has.
    lang: packages.map((pkg) => pkg.code).join('+'),
    langPath: langPaths[0],
    gzip: packages.every((pkg) => pkg.gzip),
  };
}
