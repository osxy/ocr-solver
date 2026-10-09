/**
 * Tray controller: the menu and everything a click does, with no widget.
 *
 * Every action is a pure function of injected collaborators, so the whole menu can
 * be exercised on Linux without `systray2`, a display or a real process. The
 * `systray2` adapter in `tray-systray.js` is a thin forwarder: it renders `menu()`
 * and calls `handleClick(id)`, nothing more. Any logic in the adapter would be logic
 * that cannot be tested here.
 *
 * "Pause" stops and restarts the *listener*, not the process, because the point is
 * to stop answering without losing the database, the worker or the tray icon. While
 * paused the watchdog is deliberately ignored: an explicitly paused listener is not
 * a silently dead one, and greying it out would teach the user to distrust grey.
 */
import { iconState } from './watchdog.js';
import { formatTray } from '../accuracy.js';

/** The eight documented actions, in order (DESIGN 4.14). */
export const TRAY_MENU = Object.freeze([
  Object.freeze({ id: 'status', title: 'Status' }),
  Object.freeze({ id: 'accuracy', title: 'Accuracy' }),
  Object.freeze({ id: 'pause', title: 'Pause' }),
  Object.freeze({ id: 'solve-last', title: 'Solve last image' }),
  Object.freeze({ id: 'open-log', title: 'Open log' }),
  Object.freeze({ id: 'open-config', title: 'Open config' }),
  Object.freeze({ id: 'settings', title: 'Settings' }),
  Object.freeze({ id: 'quit', title: 'Quit' }),
]);

export function createTrayController({
  listener = null,
  watchdog = null,
  solveLastImage = null,
  paths = {},
  openPath = null,
  // Opens the settings editor; injected so the controller stays free of prompts and
  // of the config file. `runApp` supplies the terminal editor.
  openSettings = null,
  quit = null,
  notify = null,
  logger = null,
  // Returns `{ corpus, store }` - the cached offline report plus the live store
  // report. Injected so the controller stays free of file and database access and
  // can be exercised with a plain fake in tests.
  accuracyProvider = null,
  now = () => Date.now(),
} = {}) {
  let paused = false;
  let accuracy = null;

  /** A fresh array; the adapter mutates its own copy and must not see ours change. */
  function menu() {
    return TRAY_MENU.map((item) => (item.id === 'pause' ? { ...item, title: paused ? 'Resume' : 'Pause' } : { ...item }));
  }

  /**
   * Refresh the cached accuracy snapshot. The provider is synchronous by design:
   * a cached file read plus one SQLite query, cheap enough for the 30 s poll. A
   * provider that throws must never take the tray down - the metric is decoration
   * next to a listener that is still working.
   */
  function refreshAccuracy() {
    if (!accuracyProvider) return accuracy;
    try {
      accuracy = accuracyProvider();
    } catch (err) {
      logger?.warn?.(`accuracy refresh failed: ${err?.message ?? err}`);
      accuracy = null;
    }
    return accuracy;
  }

  function accuracyText() {
    return formatTray(accuracy);
  }

  function snapshot() {
    const status = listener?.status?.() ?? {};
    return {
      paused,
      connected: Boolean(status.connected),
      quiet: Boolean(watchdog?.quiet),
      lastActivityAt: status.lastActivityAt ?? null,
      watermark: status.watermark ?? null,
      reasoner: status.reasoner ?? null,
      reply: status.reply ?? null,
      accuracy,
    };
  }

  function statusText() {
    const s = snapshot();
    const acc = accuracyText();
    const suffix = acc ? ` · ${acc}` : '';
    if (s.paused) return `PuzzleSolver: paused${suffix}`;
    const link = s.connected ? 'stream connected' : 'stream reconnecting';
    const quiet = s.quiet ? ', listener quiet' : '';
    return `PuzzleSolver: listening (${link}${quiet})${suffix}`;
  }

  /** The tray tooltip: status plus the one-line accuracy summary. */
  function tooltip() {
    return `PuzzleSolver — ${statusText()}`;
  }

  async function togglePause() {
    if (!listener) return { paused };
    if (!paused) {
      paused = true;
      try {
        listener.stop();
      } catch (err) {
        logger?.warn?.(`pause failed: ${err?.message ?? err}`);
      }
      logger?.info?.('tray: paused; the listener is stopped until Resume');
    } else {
      paused = false;
      try {
        await listener.start();
      } catch (err) {
        // A failed resume must not claim success: keep the user's intent visible.
        logger?.warn?.(`resume failed: ${err?.message ?? err}`);
      }
      logger?.info?.('tray: resumed');
    }
    return { paused };
  }

  async function handleClick(id) {
    switch (id) {
      case 'status': {
        const text = statusText();
        logger?.info?.(`tray: ${text}`);
        return { id, text };
      }
      case 'accuracy': {
        const bundle = refreshAccuracy();
        const text = accuracyText() ?? 'no accuracy data yet (run `puzzlesolver accuracy`)';
        logger?.info?.(`tray: accuracy ${text}`);
        return { id, text, accuracy: bundle };
      }
      case 'pause':
        return { id, ...(await togglePause()), text: statusText() };
      case 'solve-last': {
        if (!solveLastImage) return { id, solved: false, reason: 'unavailable' };
        let result;
        try {
          result = await solveLastImage();
        } catch (err) {
          logger?.warn?.(`solve-last failed: ${err?.message ?? err}`);
          return { id, solved: false, reason: 'error' };
        }
        const answer = result?.answer ?? null;
        // Tuning without a live push is the whole reason this action exists, so the
        // answer is surfaced even though nothing was replied to.
        await notify?.({
          title: answer != null ? 'PuzzleSolver: solved' : 'PuzzleSolver: unresolved',
          message: answer != null ? String(answer) : String(result?.reason ?? 'no answer'),
        });
        return { id, solved: answer != null, answer, result };
      }
      case 'open-log': {
        if (!openPath || !paths.log) return { id, opened: false, reason: 'unavailable' };
        await openPath(paths.log);
        return { id, opened: true, path: paths.log };
      }
      case 'open-config': {
        if (!openPath || !paths.config) return { id, opened: false, reason: 'unavailable' };
        await openPath(paths.config);
        return { id, opened: true, path: paths.config };
      }
      case 'settings': {
        if (!openSettings) return { id, opened: false, reason: 'unavailable' };
        try {
          const result = await openSettings();
          return { id, opened: true, result };
        } catch (err) {
          // A closed editor is not a reason to take the tray down.
          logger?.warn?.(`settings editor failed: ${err?.message ?? err}`);
          return { id, opened: false, reason: 'error', detail: err?.message ?? String(err) };
        }
      }
      case 'quit':
        logger?.info?.('tray: quit requested');
        await quit?.();
        return { id, quitting: true };
      default:
        logger?.warn?.(`tray: unknown menu action ${JSON.stringify(id)}`);
        return { id, unknown: true };
    }
  }

  /**
   * Feed the listener's last activity into the watchdog and evaluate it.
   * Returns the icon state the adapter should render. Called on a timer by the
   * adapter; also the seam the tests drive directly.
   */
  function poll() {
    const last = listener?.status?.()?.lastActivityAt ?? null;
    if (Number.isFinite(last)) watchdog?.noteActivity(last * 1000);
    watchdog?.check();
    refreshAccuracy();
    const quiet = Boolean(watchdog?.quiet) && !paused;
    return { icon: iconState(quiet), quiet, paused, accuracy };
  }

  return {
    menu,
    handleClick,
    statusText,
    tooltip,
    snapshot,
    poll,
    refreshAccuracy,
    get accuracy() {
      return accuracy;
    },
    get paused() {
      return paused;
    },
    get now() {
      return now;
    },
  };
}
