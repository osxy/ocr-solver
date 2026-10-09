/**
 * The transport-agnostic solve core.
 *
 * This is the seam the HTTP ingress (#15) exists to create. Before it, "solve one
 * image file" was spelled out twice inside `app.js` - once for a Pushbullet push,
 * once for the tray's "solve last image" - and a third time in the CLI. The ingress
 * supplies a file path; the core runs the *unchanged* pipeline and validator; the
 * egress (note push, HTTP response body, tray log line) decides how to deliver the
 * result. Grids (#9) and Playwright (#12) each add an ingress/egress pair, so the
 * seam is cheaper than another copy of the option wiring per transport.
 *
 * It deliberately owns no transport state: no store rows, no HTTP, no Pushbullet.
 * The caller passes `subject` so attempts are attributable, and `logImages` so the
 * per-ingress byte policy can be overridden.
 *
 * The core - not any ingress - owns the one solve lock (issue #44). A Tesseract
 * worker is not safe to drive concurrently: `recognize.js` does `setParameters({psm})`
 * and `recognize` as two steps, so two interleaved solves can OCR with each other's
 * PSM. Pushbullet, HTTP and the tray all call `solve`, and the promise chain here is
 * the only serialisation point.
 */
import { solveImage as defaultSolveImage } from './pipeline.js';

/**
 * The result a skipped solve resolves to. It is shaped like a pipeline result so
 * an ingress that only inspects `answer`/`confident` behaves, but `skipped: true`
 * lets a caller tell "nobody is waiting for this any more" from "no answer found".
 */
export const SKIPPED_SOLVE_RESULT = Object.freeze({
  skipped: true,
  answer: null,
  confident: false,
  method: null,
  puzzleClass: null,
  transcript: null,
  model: null,
  opinions: [],
  disputed: false,
});

export function createSolveCore({
  worker,
  reasoner = null,
  store = null,
  config,
  solveImage: solveImageImpl = defaultSolveImage,
  logger = null,
} = {}) {
  if (!config?.ocr || !config?.solver) {
    throw new Error('createSolveCore needs the loaded config (ocr + solver sections)');
  }

  // One promise chain for the whole process. FIFO, and a rejection must not poison
  // the chain: the next task still runs (`.then(task, task)`), matching the listener's
  // existing queue shape. Unbounded on purpose - the bound is per-ingress admission
  // control (#43): a Pushbullet push is not retried by a buggy loop and must not be
  // dropped, so the shared lock never refuses work on its own.
  let lock = Promise.resolve();
  function withSolveLock(task) {
    const run = lock.then(task, task);
    lock = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  /**
   * Run the full pipeline + validator over one already-validated image file.
   * @returns {Promise<object>} the pipeline result; `answer == null` means unresolved.
   */
  function solve(
    imagePath,
    {
      subject = String(imagePath),
      logImages = config.storage?.log_images ?? false,
      store: solveStore = store,
      // #43: evaluated at dequeue, under the lock, immediately before the pipeline
      // runs. A caller whose request already timed out or was aborted while queued
      // passes a predicate that is now false, and the expensive work is skipped
      // rather than run for an answer nobody will read.
      canStart = null,
    } = {}
  ) {
    return withSolveLock(() => {
      if (canStart && !canStart()) return SKIPPED_SOLVE_RESULT;
      return solveImageImpl(worker, imagePath, {
        variants: config.ocr.variants,
        minConfidence: config.ocr.min_confidence,
        reasoner,
        store: solveStore,
        subject,
        logger,
        useTier0: config.solver.tier0,
        logImages,
        // Defence in depth behind the image gate (see `preprocess.extractMask`).
        maxPixels: config.image?.max_pixels ?? null,
      });
    });
  }

  return { solve };
}
