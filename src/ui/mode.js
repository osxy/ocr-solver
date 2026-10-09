/**
 * Which UI mode to run.
 *
 * Tray is the default for the installed app (DESIGN 11: first run ends with a tray
 * icon). `--headless` forces it off, and `ui.tray = false` in the config disables it
 * for an unattended machine. The platform ability to actually show a tray is not
 * decided here - that is `systray2`'s loader, which throws the actionable
 * `--headless` error if it cannot.
 */
export function resolveTrayMode({ requested = false, configTray = true } = {}) {
  return requested === true && configTray !== false;
}
