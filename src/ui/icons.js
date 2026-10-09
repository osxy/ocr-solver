/**
 * Tray icon bitmaps.
 *
 * Two 16x16 PNGs, embedded as base64 rather than generated at runtime: the tray
 * adapter must not pull `sharp` (or any image library) into the always-on path just
 * to colour a pixel. `normal` is the app is listening; `grey` is the watchdog's
 * "the listener has gone quiet" state (DESIGN 7).
 *
 * `systray2` wants raw base64 without the `data:` prefix.
 */

const BLUE_DOT_16 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAHUlEQVQ4jWOQq7jznxLMMGrA/9EwuDMaBhXDIgwAUtxxHysIn7cAAAAASUVORK5CYII=';
const GREY_DOT_16 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAHklEQVQ4jWOYNm3af0oww6gB/0fDYNpoGEwbFmEAAMJpwR95bP+5AAAAAElFTkSuQmCC';

export const TRAY_ICONS = {
  normal: BLUE_DOT_16,
  grey: GREY_DOT_16,
};

/** Icon payload for a state name; unknown states fall back to `normal`. */
export function trayIcon(state) {
  return TRAY_ICONS[state] ?? TRAY_ICONS.normal;
}
