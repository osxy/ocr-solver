/**
 * `systray2` adapter: forwards widget events to the pure controller.
 *
 * UNVERIFIED ON WINDOWS. This repository is developed and tested on Linux; the
 * `systray2` process has never been started here. Everything with a decision in it
 * lives in `tray.js`; this file only renders `controller.menu()`, translates a click
 * back to an action id, and swaps the icon. The action ids travel as the menu item
 * `tooltip` because `systray2` does not carry an application id through its click
 * event.
 *
 * `systray2` is imported lazily so the offline suite, `--headless` mode and the
 * corpus tests never load a native tray binary. When it is missing, the error names
 * `--headless` instead of leaking an import stack.
 */
import { createWatchdog } from './watchdog.js';
import { createTrayController } from './tray.js';
import { createNotifier } from './notifications.js';
import { openPath as openPathImpl } from './open-path.js';
import { trayIcon } from './icons.js';

export class TrayUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TrayUnavailableError';
  }
}

const DEFAULT_POLL_MS = 30_000;

/**
 * @returns {Promise<{controller: object, tray: object, stop: () => Promise<void>}>}
 */
export async function startTray({
  app,
  logger = null,
  quietMs,
  solveLastImage = null,
  openPath = openPathImpl,
  // The Settings item's editor. Injected from `runApp`, which owns the config and the
  // credential provider; this adapter only forwards the click.
  openSettings = null,
  notify = null,
  // #128: the Restart item. `restart` performs the process restart; `restartPlan`
  // decides whether the item can do anything here. Forwarded verbatim.
  restart = null,
  restartPlan = null,
  quit = null,
  accuracyProvider = null,
  loadSystray = () => import('systray2'),
  pollIntervalMs = DEFAULT_POLL_MS,
} = {}) {
  let SysTray;
  try {
    const mod = await loadSystray();
    SysTray = mod?.default ?? mod;
  } catch (err) {
    throw new TrayUnavailableError(
      "the tray needs the optional 'systray2' package, which could not be loaded " +
        `(${err?.message ?? err}). Run with --headless to skip the tray, or install it with ` +
        "'npm install systray2'."
    );
  }
  if (typeof SysTray !== 'function') {
    throw new TrayUnavailableError(
      "the 'systray2' module did not export a SysTray class; run with --headless to skip the tray."
    );
  }

  const notifier = notify ?? createNotifier({ logger });
  const watchdog = createWatchdog({ quietMs });
  const controller = createTrayController({
    listener: app?.listener ?? null,
    watchdog,
    solveLastImage,
    paths: { log: app?.logger?.path ?? null, config: app?.configPath ?? null },
    openPath,
    openSettings,
    restart,
    restartPlan,
    quit,
    notify: (options) => notifier?.notify?.(options),
    accuracyProvider,
    logger,
  });

  const items = controller.menu().map((item) => ({
    title: item.title,
    tooltip: item.id,
    enabled: true,
    click: () => {},
  }));

  const tray = new SysTray({
    menu: {
      icon: trayIcon(controller.poll().icon),
      title: 'PuzzleSolver',
      tooltip: 'PuzzleSolver',
      items,
    },
    debug: false,
    copyDir: true,
  });

  const byTooltip = new Map(controller.menu().map((item, i) => [item.id, items[i]]));

  await tray.onClick(async (action) => {
    const id = action?.item?.tooltip ?? action?.__id;
    if (!byTooltip.has(id)) return;
    const result = await controller.handleClick(id);
    // The Pause item's title changes with state; keep the widget in step.
    if (id === 'pause') {
      const next = controller.menu().find((item) => item.id === 'pause');
      try {
        await tray.sendAction({ type: 'update-item', item: { ...byTooltip.get('pause'), title: next.title } });
      } catch {
        // A failed menu update is cosmetic and must not take down the tray.
      }
    }
    return result;
  });

  function refreshIcon() {
    const { icon } = controller.poll();
    try {
      tray.sendAction({ type: 'update-menu', menu: { icon: trayIcon(icon), title: 'PuzzleSolver', tooltip: controller.tooltip(), items } });
    } catch {
      // same: an icon that fails to repaint is not a reason to crash
    }
  }

  const timer = setInterval(refreshIcon, pollIntervalMs);
  timer.unref?.();

  return {
    controller,
    tray,
    stop: async () => {
      clearInterval(timer);
      try {
        await tray.kill(false);
      } catch {
        // killing an already-dead tray process is not an error
      }
    },
  };
}
