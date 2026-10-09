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
 */
import { solveImage as defaultSolveImage } from './pipeline.js';

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

  /**
   * Run the full pipeline + validator over one already-validated image file.
   * @returns {Promise<object>} the pipeline result; `answer == null` means unresolved.
   */
  function solve(
    imagePath,
    { subject = String(imagePath), logImages = config.storage?.log_images ?? false, store: solveStore = store } = {}
  ) {
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
  }

  return { solve };
}
