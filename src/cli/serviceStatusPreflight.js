/**
 * Read-only database diagnostics, used before `ezz service status` imports
 * core/db.js.
 *
 * core/db.js opens the database while its module body is evaluated and exits
 * when that fails. That makes the normal status command unavailable in exactly
 * the case where its diagnostics are most useful: a daemon that will not start
 * because it cannot open its database. This module answers the four questions
 * that separate the possible causes, and answers them without writing:
 *
 *   - does the package's better-sqlite3 load at all, and with which Node/ABI,
 *   - can the existing database file be opened read-only,
 *   - are SQLite's -wal/-shm/-journal siblings present,
 *   - is another process holding it (the daemon lock, and `fuser` on Linux).
 *
 * Everything here is read-only: no connection is opened for writing, no file is
 * created, moved, truncated or removed. The database is the only copy of the
 * user's configuration, so "it will not open" is never a reason to replace it.
 *
 * The commands themselves live in core/shell.js, as everywhere else.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { getDataDir, isWindows } from '../core/platform.js';
import { runFile } from '../core/shell.js';
import { inspect as inspectDaemonLock } from '../core/daemon/lock.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATABASE_FILE = 'easy-devops.sqlite';

/** SQLite's siblings. They are read, named, and never deleted. */
export const DATABASE_SIDECARS = ['-wal', '-shm', '-journal'];

const FUSER_TIMEOUT_MS = 5_000;

/** The folder holding package.json — what `npm rebuild` has to run in. */
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');

function errorDetails(error) {
  return {
    code: error?.code ?? error?.name ?? 'ERROR',
    message: error?.message ?? String(error),
  };
}

function isLocked(error) {
  const code = String(error?.code ?? '');
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED'
    || /database (?:is|table is) locked/i.test(String(error?.message ?? ''));
}

function inspectSidecars(database, fsImpl) {
  return DATABASE_SIDECARS.map((suffix) => {
    const file = `${database}${suffix}`;
    try {
      const stat = fsImpl.lstatSync(file, { throwIfNoEntry: false });
      return { file, suffix, exists: Boolean(stat), size: stat?.size ?? 0, error: null };
    } catch (error) {
      return { file, suffix, exists: false, size: 0, error: errorDetails(error) };
    }
  });
}

function safeResolve(requireImpl, specifier) {
  try {
    return requireImpl.resolve(specifier);
  } catch {
    return null;
  }
}

/**
 * Can this package load its native SQLite module, and with which versions?
 *
 * Loading it is the only honest answer: an ABI number that matches can still
 * belong to a half-copied `node_modules`, which is what the real incident
 * looked like. Nothing is written - the module is imported, not used.
 */
function inspectNativePackage({ requireImpl = require } = {}) {
  const report = {
    ok: false,
    version: null,
    abi: process.versions.modules,
    node: process.version,
    entry: null,
    nativeFile: null,
    detail: null,
  };

  try {
    requireImpl('better-sqlite3');
    report.ok = true;
  } catch (error) {
    report.detail = errorDetails(error);
    return report;
  }

  report.entry = safeResolve(requireImpl, 'better-sqlite3');
  report.nativeFile = safeResolve(requireImpl, 'better-sqlite3/build/Release/better_sqlite3.node');
  try {
    report.version = requireImpl('better-sqlite3/package.json')?.version ?? null;
  } catch {
    report.version = null;
  }
  return report;
}

/** What the daemon lock says, without trying to recover it. */
function inspectLockHolder(dataDir) {
  try {
    const state = inspectDaemonLock({ dataDir });
    return {
      present: Boolean(state.lock),
      pid: state.lock?.pid ?? null,
      running: state.running,
      stale: state.stale,
      ageMs: state.age,
      reason: state.reason,
      error: null,
    };
  } catch (error) {
    return { present: false, pid: null, running: false, stale: false, ageMs: null, reason: null, error: errorDetails(error) };
  }
}

/**
 * Ask `fuser` which processes have the database (or a sidecar) open.
 *
 * Linux only, and skipped quietly when fuser is not installed: psmisc is not a
 * dependency of Easy DevOps and its absence must not turn a status command into
 * an error. fuser prints its table on stderr and exits 1 when nothing holds the
 * file, so a non-zero exit is the normal "nobody" answer, not a failure.
 *
 * @param {Object} [opts]
 * @param {string} opts.database Absolute path to the database file
 * @param {Function} [opts.runFileImpl] core/shell.js runFile, for tests
 * @param {Function} [opts.existsImpl]
 * @returns {Promise<{ checked: boolean, available: boolean, output: string|null, error: Object|null }>}
 */
export async function collectDatabaseLockHolders({
  database,
  runFileImpl = runFile,
  existsImpl = fs.existsSync,
} = {}) {
  const idle = { checked: false, available: false, output: null, error: null };
  if (isWindows || !database) return idle;

  const files = [database, ...DATABASE_SIDECARS.map((suffix) => `${database}${suffix}`)]
    .filter((file) => existsImpl(file));
  if (files.length === 0) return idle;

  let result;
  try {
    result = await runFileImpl('fuser', ['-v', ...files], { timeout: FUSER_TIMEOUT_MS });
  } catch (error) {
    return { checked: false, available: false, output: null, error: errorDetails(error) };
  }

  const stderr = String(result?.stderr ?? '');
  // runFile() resolves a spawn failure (or a timeout) with no exit code. That
  // is "no answer", not "nobody holds it": report it as unavailable so the
  // caller stays quiet instead of claiming the file is free.
  const spawned = result?.exitCode !== null && result?.exitCode !== undefined;
  if (!spawned) {
    return {
      checked: false,
      available: false,
      output: null,
      error: { code: 'FUSER_UNAVAILABLE', message: stderr || 'fuser could not be run' },
    };
  }

  return {
    checked: true,
    available: true,
    output: `${String(result?.stdout ?? '')}${stderr}`.trim() || null,
    error: null,
  };
}

/**
 * The holders of the database for the directory the CLI is about to report on.
 *
 * `ezz service status` asks for the same data directory every time, so the
 * fuser probe is started once, when this module is loaded, and awaited there:
 * the caller `await import()`s this module before it builds the report, so the
 * answer is ready even though the rest of the inspection is synchronous. The
 * synchronous half (file stats, the read-only open) cannot spawn a process, and
 * spawning one from a synchronous function would mean a second, competing
 * implementation in core/shell.js.
 *
 * @type {{ checked: boolean, available: boolean, output: string|null, error: Object|null }|null}
 */
const startup = await (async () => {
  let dataDir = null;
  try {
    dataDir = getDataDir();
  } catch {
    return { dataDir: null, holders: null };
  }
  if (isWindows) return { dataDir, holders: null };
  return {
    dataDir,
    holders: await collectDatabaseLockHolders({ database: path.join(dataDir, DATABASE_FILE) }),
  };
})();

const STARTUP_DATA_DIR = startup.dataDir;
const startupHolders = startup.holders;

const sameDir = (a, b) => {
  if (!a || !b) return false;
  const left = path.resolve(a);
  const right = path.resolve(b);
  return isWindows ? left.toLowerCase() === right.toLowerCase() : left === right;
};

/**
 * Check the native SQLite dependency and open an existing database read-only.
 *
 * A missing or zero-byte database is healthy for this probe: the normal
 * database bootstrap will initialize it after this preflight returns.
 *
 * @param {Object} [opts]
 * @param {string} opts.dataDir
 * @param {Function} [opts.requireImpl]
 * @param {Object} [opts.fsImpl]
 * @param {Object} [opts.holders] Pre-collected holder data, for tests
 * @returns {Object}
 */
export function inspectServiceStatusDatabase({
  dataDir,
  requireImpl = require,
  fsImpl = fs,
  holders = null,
} = {}) {
  const database = path.join(dataDir, DATABASE_FILE);
  const report = {
    ok: true,
    dataDir,
    database,
    package: inspectNativePackage({ requireImpl }),
    file: { exists: false, size: 0, mode: null, regular: false, error: null },
    readOnly: { ok: false, skipped: false, checked: false, phase: null, error: null },
    sidecars: inspectSidecars(database, fsImpl),
    locked: false,
    lock: inspectLockHolder(dataDir),
    fuser: holders?.fuser ?? (sameDir(dataDir, STARTUP_DATA_DIR) ? startupHolders : null),
    step: null,
  };

  // The file's own facts need nothing but fs, so they are gathered first: they
  // are still worth printing when the native module is the broken half.
  try {
    const stat = fsImpl.lstatSync(database, { throwIfNoEntry: false });
    report.file.exists = Boolean(stat);
    report.file.size = stat?.size ?? 0;
    report.file.regular = Boolean(stat?.isFile());
    report.file.mode = stat && !isWindows ? `0${(stat.mode & 0o777).toString(8)}` : null;
  } catch (error) {
    report.ok = false;
    report.step = 'inspect the database file';
    report.file.error = errorDetails(error);
    return report;
  }

  if (!report.package.ok) {
    report.ok = false;
    report.step = 'load better-sqlite3 (the native SQLite addon)';
    return report;
  }

  if (!report.file.exists || report.file.size === 0) {
    report.readOnly.skipped = true;
    report.readOnly.ok = true;
    return report;
  }

  if (!report.file.regular) {
    report.ok = false;
    report.step = 'inspect the database file';
    report.file.error = {
      code: 'NOT_A_REGULAR_FILE',
      message: 'the database path is not a regular file',
    };
    return report;
  }

  let Database;
  let db;
  try {
    Database = requireImpl('better-sqlite3');
    report.readOnly.checked = true;
    report.readOnly.phase = 'open';
    db = new Database(database, { readonly: true, fileMustExist: true });
    report.readOnly.phase = 'read the schema';
    db.prepare('SELECT name FROM sqlite_master LIMIT 1').get();
    report.readOnly.ok = true;
    report.readOnly.phase = null;
  } catch (error) {
    report.ok = false;
    report.step = `read-only open: ${report.readOnly.phase ?? 'open'}`;
    report.locked = report.locked || isLocked(error);
    report.readOnly.error = errorDetails(error);
  } finally {
    try { db?.close(); } catch { /* the original failure remains authoritative */ }
  }

  return report;
}

/** The advice for one failed check: the command to run, not a description. */
function adviceFor(report) {
  const lines = [];

  if (!report.package?.ok) {
    lines.push(
      `Rebuild the native SQLite module in ${PACKAGE_ROOT}, with the same Node the service uses:`,
      `  cd ${PACKAGE_ROOT} && npm rebuild better-sqlite3`,
    );
  }

  if (report.locked || (report.readOnly?.error && isLocked(report.readOnly.error))) {
    lines.push('Another process is holding the database. Find it, then stop it:');
    if (isWindows) {
      lines.push('  ezz service stop');
    } else {
      lines.push(`  fuser -v ${report.database}*`, `  lsof ${report.database}`);
    }
  }

  const error = report.readOnly?.error;
  if (error) {
    const code = String(error.code ?? '');
    if (code === 'SQLITE_NOTADB' || code.startsWith('SQLITE_CORRUPT')) {
      lines.push(
        'The file is not a readable SQLite database. Keep it and copy it aside for inspection:',
        `  cp "${report.database}" "${report.database}.broken"`,
        'then restore the backup taken before the failed update. Do not delete the original.',
      );
    } else if (code === 'EACCES' || code === 'EPERM' || code === 'SQLITE_PERM' || code === 'SQLITE_READONLY') {
      lines.push(
        `The account running this command cannot read ${report.database}.`,
        'Check the file and its folder with `ls -ld` (Linux) or `icacls` (Windows).',
      );
    } else if (code === 'SQLITE_CANTOPEN' || code === 'ENOENT') {
      lines.push(
        `The database file cannot be opened: ${report.database}`,
        `Check the path, its folder and the mount: ls -la "${report.dataDir}" and df -h "${report.dataDir}"`,
      );
    }
  }

  if (report.file?.error && !error) {
    lines.push(`The database file could not be inspected: ${report.file.error.code}: ${report.file.error.message}`);
  }

  if (lines.length === 0) {
    lines.push(
      `Failed step: ${report.step ?? 'database preflight'}.`,
      'Keep the database file. Do not delete, move or recreate it.',
      'See the service troubleshooting guide before restoring a backup.',
    );
  }

  return lines;
}

function lockLine(report) {
  const lock = report.lock;
  if (!lock || lock.error) {
    return lock?.error
      ? { ok: null, text: `could not be read (${lock.error.code}: ${lock.error.message})`, advice: null }
      : { ok: null, text: 'not read', advice: null };
  }
  if (!lock.present) {
    return { ok: true, text: 'no lock file: no daemon is recorded as running', advice: null };
  }
  const age = Number.isFinite(lock.ageMs) ? `${Math.round(lock.ageMs / 1000)}s ago` : 'unknown age';
  if (lock.running) {
    return {
      ok: null,
      text: `pid ${lock.pid} is running (heartbeat ${age}) - the daemon is up`,
      advice: 'a running daemon holds the database normally; `ezz service stop` before checking further',
    };
  }
  return {
    ok: true,
    text: `pid ${lock.pid} is gone (heartbeat ${age}) - a leftover lock, not a live daemon`,
    advice: null,
  };
}

/**
 * Render the diagnostics. Used for a failed preflight (`ezz service status`
 * prints it and stops before core/db.js) and readable on its own.
 *
 * Every check that failed is followed by the command or step that fixes it;
 * nothing prints the database's contents.
 *
 * @param {Object} report
 * @returns {string}
 */
export function formatDatabasePreflightFailure(report) {
  const mark = (ok) => (ok === true ? '✓' : ok === false ? '✗' : '·');
  const lines = [
    '',
    'Easy DevOps background service - database check',
    '================================================',
    `  Data directory  ${report.dataDir}`,
    `  Database        ${report.database}`,
    '',
  ];

  const pkg = report.package ?? {};
  if (pkg.ok) {
    const version = pkg.version ? ` ${pkg.version}` : '';
    lines.push(
      `  ${mark(true)} better-sqlite3${version} loads with Node ${pkg.node} (ABI ${pkg.abi})`,
    );
    if (pkg.nativeFile) lines.push(`      native module: ${pkg.nativeFile}`);
  } else {
    const detail = pkg.detail ?? { code: 'ERROR', message: 'not checked' };
    lines.push(`  ${mark(false)} better-sqlite3 does not load: ${detail.code}: ${detail.message}`);
  }

  const file = report.file ?? {};
  if (file.error) {
    lines.push(`  ${mark(false)} database file: ${file.error.code}: ${file.error.message}`);
  } else if (!file.exists) {
    lines.push(`  ${mark(null)} database file: not created yet (it is created on first use)`);
  } else {
    const mode = file.mode ? `, mode ${file.mode}` : '';
    lines.push(`  ${mark(true)} database file: ${file.size} byte(s)${mode}`);
  }

  const ro = report.readOnly ?? {};
  if (ro.error) {
    lines.push(`  ${mark(false)} read-only open: ${ro.error.code}: ${ro.error.message}`);
  } else if (ro.skipped) {
    lines.push(`  ${mark(null)} read-only open: skipped (an empty database will be initialized)`);
  } else if (ro.ok) {
    lines.push(`  ${mark(true)} read-only open: the schema was read; the file is intact`);
  }

  const present = (report.sidecars ?? []).filter((item) => item.exists);
  if (present.length === 0) {
    lines.push(`  ${mark(true)} SQLite sidecars: none present`);
  } else {
    for (const sidecar of present) {
      lines.push(`  ${mark(null)} SQLite sidecar: ${path.basename(sidecar.file)} (${sidecar.size} bytes)`);
    }
    lines.push('      left by an unclean shutdown; SQLite reuses them. Stop a leftover process, never delete them.');
  }

  const lock = lockLine(report);
  lines.push(`  ${mark(lock.ok)} daemon lock: ${lock.text}`);
  if (lock.advice) lines.push(`      ${lock.advice}`);

  if (report.fuser?.checked) {
    if (report.fuser.output) {
      lines.push(`  ${mark(false)} fuser -v: ${report.fuser.output.replace(/\s+$/, '').split('\n').join('\n      ')}`);
      lines.push('      stop that process, then start the service again');
    } else {
      lines.push(`  ${mark(true)} fuser -v: no process has the database open`);
    }
  }

  const advice = report.ok ? [] : adviceFor(report);
  if (advice.length > 0) {
    lines.push('');
    for (const line of advice) lines.push(`  ${line}`);
  }

  if (!report.ok) lines.push('', `  Failed step: ${report.step ?? 'database preflight'}`);
  lines.push('', '  This check only read: nothing was written, created or deleted.', '');
  return `${lines.join('\n')}\n`;
}
