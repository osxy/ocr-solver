/**
 * Desktop notifications, with `node-notifier` loaded lazily.
 *
 * Why lazy: notifications are an optional UI affordance, and the offline test suite
 * (and `--headless` mode) must never need the dependency or a display. Importing at
 * module load would make every test that touches the app pull in a library whose
 * only job is to draw a toast.
 *
 * Why it never throws: the same rule as the logger and the attempts store - a
 * notification is never load-bearing. If the module is missing, the platform refuses
 * the toast, or `notify` throws, the caller falls back to a log line and solving is
 * unaffected.
 */
import { redactRecord } from '../logging.js';

export function createNotifier({ loadModule = () => import('node-notifier'), logger = null } = {}) {
  let notifier = null;
  let loadError = null;
  let tried = false;

  async function resolve() {
    if (tried) return notifier;
    tried = true;
    try {
      const mod = await loadModule();
      notifier = mod?.default ?? mod ?? null;
    } catch (err) {
      loadError = err;
      logger?.debug?.(`node-notifier unavailable (${err?.message ?? err}); notifications fall back to the log`);
    }
    return notifier;
  }

  return {
    /** Resolve the backend once; exposed so the tray can report availability. */
    async available() {
      return Boolean(await resolve());
    },
    /**
     * Show a toast, or log it when no backend is available. Never rejects.
     * Options mirror node-notifier: `{ title, message, sound }`.
     */
    async notify({ title, message, sound = false } = {}) {
      const backend = await resolve();
      // Both fields pass through the shared redactor: an error message may quote a
      // puzzle (fine) but a provider error body can carry a key (not fine).
      const safeTitle = redactRecord(String(title ?? 'PuzzleSolver'));
      const safeMessage = redactRecord(String(message ?? ''));
      if (!backend || typeof backend.notify !== 'function') {
        logger?.info?.(`notification: ${safeTitle} - ${safeMessage}`);
        return { shown: false, reason: 'unavailable' };
      }
      try {
        backend.notify({ title: safeTitle, message: safeMessage, sound });
        return { shown: true };
      } catch (err) {
        logger?.warn?.(`notification failed: ${redactRecord(String(err?.message ?? err))}`);
        return { shown: false, reason: 'error' };
      }
    },
  };
}
