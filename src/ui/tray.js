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

/** The six documented actions, in order (DESIGN 4.14). */
export const TRAY_MENU = Object.freeze([
  Object.freeze({ id: 'status', title: 'Status' }),
  Object.freeze({ id: 'pause', title: 'Pause' }),
  Object.freeze({ id: 'solve-last', title: 'Solve last image' }),
  Object.freeze({ id: 'open-log', title: 'Open log' }),
  Object.freeze({ id: 'open-config', title: 'Open config' }),
  Object.freeze({ id: 'quit', title: 'Quit' }),
]);

export function createTrayController({
  listener = null,
  watchdog = null,
  solveLastImage = null,
  paths = {},
  openPath = null,
  quit = null,
  notify = null,
  logger = null,
  now = () => Date.now(),
} = {}) {
  let paused = false;

  /** A fresh array; the adapter mutates its own copy and must not see ours change. */
  function menu() {
    return TRAY_MENU.map((item) => (item.id === 'pause' ? { ...item, title: paused ? 'Resume' : 'Pause' } : { ...item }));
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
    };
  }

  function statusText() {
    const s = snapshot();
    if (s.paused) return 'PuzzleSolver: paused';
    const link = s.connected ? 'stream connected' : 'stream reconnecting';
    const quiet = s.quiet ? ', listener quiet' : '';
    return `PuzzleSolver: listening (${link}${quiet})`;
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
    const quiet = Boolean(watchdog?.quiet) && !paused;
    return { icon: iconState(quiet), quiet, paused };
  }

  return {
    menu,
    handleClick,
    statusText,
    snapshot,
    poll,
    get paused() {
      return paused;
    },
    get now() {
      return now;
    },
  };
}
