/**
 * Rotating file log, with an optional console sink.
 *
 * Three properties matter more than features:
 *
 *  1. **Every record is redacted.** The redactors live in `redact.js` - `redact` for
 *     OpenAI-style keys, `redactPushbullet` for Pushbullet tokens, and
 *     `stripImageBytes` for the DESIGN 8 image policy - and this logger and the state
 *     store both call the same `redactRecord`. A second copy would eventually drift,
 *     and the copy that drifts is the one that leaks.
 *  2. **A failure to log must not break solving.** Every filesystem call here is
 *     wrapped and a logger that cannot write disables its own file sink instead of
 *     throwing on every subsequent puzzle. The attempts store makes the same trade.
 *  3. **Rotation is real and testable.** `app.log` rolls to `app.log.1`, `.1` to
 *     `.2`, and the oldest is dropped, so the set never exceeds `maxFiles`. A
 *     logger that claims to rotate but never does is worse than none.
 *
 * Default location per DESIGN 4.14: `%LOCALAPPDATA%\PuzzleSolver\logs\app.log` on
 * Windows, `${XDG_STATE_HOME:-~/.local/state}/puzzlesolver/logs/app.log` elsewhere.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { dirname, join } from 'node:path';
import { redactRecord } from './redact.js';

export { redactRecord };

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_FILES = 3;
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

export function defaultLogPath({ platform = process.platform, env = process.env, homedir = osHomedir } = {}) {
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return join(base, 'PuzzleSolver', 'logs', 'app.log');
  }
  const base = env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
  return join(base, 'puzzlesolver', 'logs', 'app.log');
}

/** Run a record through the shared redactors; callers never do it themselves. */
function formatArg(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Create a logger. `path = null` disables the file sink (tests, console-only mode).
 */
export function createLogger({
  path = null,
  maxBytes = DEFAULT_MAX_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
  console = false,
  consoleImpl = console,
  now = () => new Date().toISOString(),
  // Overridable so a test can simulate a full/unwritable disk; defaults to node:fs.
  fs = { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync },
} = {}) {
  let size = null;
  let fileSinkBroken = false;

  function currentSize() {
    if (size != null) return size;
    try {
      size = path && fs.existsSync(path) ? fs.statSync(path).size : 0;
    } catch {
      size = 0;
    }
    return size;
  }

  function rotate() {
    // A single-file cap means "truncate", not "rotate": there is no older slot.
    if (maxFiles <= 1) {
      try {
        if (fs.existsSync(path)) fs.rmSync(path, { force: true });
      } catch {
        // keep appending rather than lose the record
      }
      size = 0;
      return;
    }
    // Drop the oldest first, then walk everything down one slot. With maxFiles=3
    // the set is app.log, app.log.1, app.log.2 - never a fourth file.
    const oldest = `${path}.${maxFiles - 1}`;
    try {
      if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true });
      for (let i = maxFiles - 2; i >= 1; i--) {
        const from = `${path}.${i}`;
        if (fs.existsSync(from)) fs.renameSync(from, `${path}.${i + 1}`);
      }
      if (fs.existsSync(path)) fs.renameSync(path, `${path}.1`);
    } catch {
      // If rotation fails, keep appending rather than losing the record entirely.
    }
    size = 0;
  }

  function write(level, args) {
    const text = args.map(formatArg).join(' ');
    const safe = redactRecord(text);
    if (path && !fileSinkBroken) {
      const line = `${now()} ${level} ${safe}\n`;
      try {
        fs.mkdirSync(dirname(path), { recursive: true });
        const bytes = Buffer.byteLength(line);
        const before = currentSize();
        if (before > 0 && before + bytes > maxBytes) rotate();
        fs.appendFileSync(path, line);
        size = (size ?? 0) + bytes;
      } catch {
        // Never let logging break solving: disable the sink, keep going.
        fileSinkBroken = true;
      }
    }
    if (console) {
      try {
        const sink = consoleImpl[level] ?? consoleImpl.log;
        sink.call(consoleImpl, `${level} ${safe}`);
      } catch {
        // console unavailable (e.g. a detached process) - not fatal
      }
    }
  }

  const logger = {
    path,
    maxBytes,
    maxFiles,
    get fileSinkBroken() {
      return fileSinkBroken;
    },
    log: (level, ...args) => write(LOG_LEVELS.includes(level) ? level : 'info', args),
  };
  for (const level of LOG_LEVELS) logger[level] = (...args) => write(level, args);
  return logger;
}
