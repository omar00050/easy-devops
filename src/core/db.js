import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { getDataDir, isDefaultDataDir, isWindows } from './platform.js';
import { copyFileWithRetry, renameWithRetry } from './atomicState.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const require = createRequire(import.meta.url);

// The folder holding package.json and node_modules/. Its dependencies, the
// native SQLite addon among them, are rebuilt from here.
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');

// Resolved once per process. The location lives in core/platform.js so the
// database, sessions and logs all agree on it — see getDataDir().
const DATA_DIR = getDataDir();

const DB_PATH = path.join(DATA_DIR, 'easy-devops.sqlite');

// The file the open connection uses. It equals DB_PATH for the life of almost
// every process; only reopenDb() moves it, after the Windows Server-mode
// migration has changed what getDataDir() answers.
let dbPath = DB_PATH;

// ─── Startup failure reporting ───────────────────────────────────────────────
//
// A database that will not open used to say one thing: "check that the current
// user has write access", whether or not that was true. On the real server that
// produced it (a root install, where permissions were never the problem) it
// hid the actual cause for days. Every startup failure below prints:
//
//   - the step that failed (creating the directory, loading the native addon,
//     opening the file, its first read, its first write),
//   - the underlying error's code AND message, and
//   - a next step that fits THAT cause, naming the command to run.
//
// Nothing here writes, moves, deletes or truncates the database or its
// -wal/-shm/-journal siblings. A database that cannot be opened is kept exactly
// as it is: it is the only copy of the user's configuration.

const LOCK_CODES = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_BUSY_RECOVERY', 'EBUSY']);
const PERMISSION_CODES = new Set(['EACCES', 'EPERM', 'SQLITE_PERM', 'SQLITE_READONLY']);
const NOT_A_DATABASE = /file is (?:not a database|encrypted)|database disk image is malformed/i;
const DISK_CODES = new Set(['ENOSPC', 'EDQUOT', 'SQLITE_FULL', 'EIO']);
const OPEN_CODES = new Set(['SQLITE_CANTOPEN', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EROFS']);

/** `CODE: message`, or just the message when the error carries no code. */
function describeError(error) {
  const code = String(error?.code ?? '').trim();
  const message = String(error?.message ?? error ?? 'unknown error').trim();
  return { code, message, text: code ? `${code}: ${message}` : message };
}

/**
 * The step a failed open reached, named from the SQLite error.
 *
 * better-sqlite3 opens the file and then good.db's driver immediately issues
 * `CREATE TABLE IF NOT EXISTS`, so a single try block covers both. The error
 * code says which half failed, which is what an operator needs.
 *
 * @param {Error} error
 * @returns {string}
 */
function openStepFor(error) {
  const { code, message } = describeError(error);
  if (code === 'SQLITE_NOTADB' || code.startsWith('SQLITE_CORRUPT') || NOT_A_DATABASE.test(message)) {
    return 'first read of the database file (its SQLite header and schema)';
  }
  if (code === 'SQLITE_READONLY' || code.startsWith('SQLITE_READONLY_')
      || DISK_CODES.has(code) || code.startsWith('SQLITE_IOERR') || code === 'SQLITE_FULL') {
    return 'first write to the database file (creating the schema table)';
  }
  if (LOCK_CODES.has(code)) {
    return 'open the database file and take the write lock';
  }
  return 'open the database file';
}

/**
 * The next steps that fit one startup failure.
 *
 * Deliberately a list of lines rather than one sentence: the operator reads
 * this in a systemd journal, often through a screenshot, and needs the command
 * to copy.
 *
 * @param {Object} opts
 * @param {Error} opts.error The underlying error
 * @param {string} opts.step  The step that failed
 * @param {string} opts.databasePath
 * @param {string} opts.dataDir
 * @param {string} [opts.packageRoot]
 * @returns {string[]}
 */
export function databaseFailureAdvice({
  error,
  step,
  databasePath = DB_PATH,
  dataDir = DATA_DIR,
  packageRoot = PACKAGE_ROOT,
} = {}) {
  const { code, message, text } = describeError(error);
  const sidecars = `${path.basename(databasePath)}*`;

  // 1. The module that talks to SQLite is not loadable with this Node.
  //    The same advice covers a missing prebuilt binary, an addon built for
  //    another ABI, and a half-copied node_modules: rebuild, do not reinstall.
  if (step.startsWith('load')
      || code === 'ERR_DLOPEN_FAILED'
      || code === 'MODULE_NOT_FOUND'
      || /NODE_MODULE_VERSION|compiled against a different Node|Could not locate the bindings|invalid ELF header|not a valid Win32 application|undefined symbol/i.test(text)) {
    const lines = [
      'The SQLite module does not load with this Node'
        + ` (${process.version}, ABI ${process.versions.modules}).`,
      'Rebuild it in the package folder, with the same Node the service uses:',
      `  cd ${packageRoot} && npm rebuild better-sqlite3`,
    ];
    if (/NODE_MODULE_VERSION|compiled against a different Node/i.test(text)) {
      lines.push(`It was built for another Node version; this one needs ABI ${process.versions.modules}.`);
    }
    lines.push(
      'This is an install problem, not a data problem: leave the database file alone.',
    );
    return lines;
  }

  // 2. Another process holds the database.
  if (LOCK_CODES.has(code) || /database (?:table )?is locked/i.test(message)) {
    const lines = ['Another process is holding the database. Find it, then stop it:'];
    if (isWindows) {
      lines.push(
        '  ezz service status          (shows the daemon pid and whether it is running)',
        '  Get-Process node | Select-Object Id, StartTime   (in PowerShell)',
      );
    } else {
      lines.push(
        `  fuser -v ${databasePath}*`,
        `  lsof ${databasePath}        (when fuser is not installed)`,
      );
    }
    lines.push(
      'Stop the leftover process (for the daemon: `ezz service stop`), then start it again.',
      'Do not delete the database or its -wal/-shm files: SQLite reuses them safely.',
    );
    return lines;
  }

  // 3. Permissions - the only case where the old hint was the right answer.
  if (PERMISSION_CODES.has(code) || /permission denied|attempt to write a readonly database/i.test(message)) {
    return [
      `The account running this command cannot write to: ${dataDir}`,
      'Check the folder and its parents with `ls -ld` (Linux) or `icacls` (Windows),',
      'then run the command again as the account that owns the installation.',
      isWindows && /^C:\\ProgramData/i.test(dataDir)
        ? 'For the Windows service (Server mode) run `ezz service repair` from an elevated PowerShell.'
        : 'If the file itself is read-only, make it writable; never recreate it.',
    ];
  }

  // 4. The file is there but is not a SQLite database: a half-written copy, a
  //    truncated file, or something else was put in its place.
  if (code === 'SQLITE_NOTADB' || code.startsWith('SQLITE_CORRUPT') || NOT_A_DATABASE.test(message)) {
    const copy = isWindows
      ? `Copy-Item "${databasePath}" "${databasePath}.broken"`
      : `cp "${databasePath}" "${databasePath}.broken"`;
    return [
      'The file exists but is not a readable SQLite database.',
      'Keep it: copy it aside before anything else, for example',
      `  ${copy}`,
      'then restore the backup taken before the failed update, or ask for help with the copy.',
      'Do not delete or recreate the original.',
    ];
  }

  // 5. No space, or the filesystem returned an I/O error. The generic write
  //    hint sent operators looking at permissions that were already correct.
  if (DISK_CODES.has(code) || code.startsWith('SQLITE_IOERR') || /disk (?:i\/o error|is full)|no space left/i.test(message)) {
    return [
      'The storage under the data directory failed the write.',
      `Check free space and the filesystem: df -h "${dataDir}" and dmesg | tail`,
      'Free space or fix the volume, then start the service again.',
      'The database was not modified by this command.',
    ];
  }

  // 6. The path itself cannot be opened: a directory in the way, a read-only
  //    mount, a missing parent.
  if (OPEN_CODES.has(code) || /unable to open database file/i.test(message)) {
    return [
      `The database file cannot be opened: ${databasePath}`,
      `Check the path, its parent folder and the mount: ls -la "${dataDir}" and df -h "${dataDir}"`,
      'Then start the service again. If the filesystem is mounted read-only, remount it read-write first.',
      'Nothing was moved or deleted.',
    ];
  }

  return [
    'The cause above does not match a known pattern.',
    `Run \`ezz service status\` for a read-only diagnosis of ${sidecars}.`,
    'Keep the database file: do not delete or recreate it.',
  ];
}

/**
 * The whole startup failure as printable lines.
 *
 * @param {Object} opts Passed to databaseFailureAdvice()
 * @param {string|null} [opts.note] An earlier, non-fatal step that also failed
 * @returns {string[]}
 */
export function diagnoseDatabaseFailure(opts = {}) {
  const { error, step, databasePath = DB_PATH, note = null } = opts;
  const { text } = describeError(error);
  const lines = [`  Step : ${step}`, `  Cause: ${text}`];
  if (note) lines.push(`  Note : an earlier step also failed: ${note}`);
  lines.push('');
  for (const line of databaseFailureAdvice({ ...opts, databasePath })) lines.push(`  ${line}`);
  lines.push(
    '',
    '  Nothing was written, moved or deleted by this command.',
    '  `ezz service status` runs a read-only check of the same database.',
  );
  return lines;
}

/**
 * A complete, printable startup failure, header included.
 *
 * @param {Object} opts
 * @param {string} opts.heading First line, e.g. '[ERROR] Failed to initialize database at: ...'
 * @returns {string}
 */
export function formatDatabaseStartupFailure(opts = {}) {
  const heading = opts.heading ?? `[ERROR] Failed to initialize database at: ${opts.databasePath ?? DB_PATH}`;
  return `${heading}\n${diagnoseDatabaseFailure(opts).join('\n')}\n`;
}

// ─── One-time migration from old package-relative location ───────────────────
const OLD_DATA_DIR = path.join(__dirname, '..', '..', 'data');
const OLD_DB_PATH = path.join(OLD_DATA_DIR, 'easy-devops.sqlite');

/**
 * A failure of the one-time migration is still non-fatal - a new install must
 * start with a fresh database - but it is remembered and printed with any
 * later failure, because "cannot write the data directory" is often the same
 * cause twice.
 * @type {string|null}
 */
let migrationFailure = null;

function migrateIfNeeded() {
  // Only ever migrate INTO the default data directory. The migration RENAMES
  // the legacy database, so running against any other directory — `--dev`, a
  // test's temp directory, or anything else pointed at by
  // EASY_DEVOPS_DATA_DIR — would consume the real installation's data.
  //
  // This used to ask `isDevDataDir()`, which returned true for ANY redirected
  // directory and so happened to express the same rule. It no longer does:
  // dev mode is now about intent, and every installed service passes a data
  // directory without being a dev run. `isDefaultDataDir()` states the actual
  // requirement — "this is a real installation's own directory" — rather than
  // relying on a second question that used to have the same answer.
  if (!isDefaultDataDir(DATA_DIR)) return;

  try {
    if (!fs.existsSync(OLD_DB_PATH) || fs.existsSync(DB_PATH)) return;
    fs.mkdirSync(DATA_DIR, { recursive: true });

    // COPYFILE_EXCL, not copyFileSync's default: if a database appeared between
    // the check and the copy — another process migrating, or the Windows
    // Server-mode switch filling this directory — an existing database is
    // NEVER overwritten. A database that is already there is the live one; the
    // legacy file is simply left where it is.
    //
    // The copy retries the Windows sharing codes through the shared helper. A
    // sharing denial is an open-time failure — the source is held by another
    // process for a moment — so a retry cannot find a half-copied destination
    // of its own; an EEXIST from a real race is still handled below.
    try {
      copyFileWithRetry(OLD_DB_PATH, DB_PATH, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if (error?.code === 'EEXIST') return;
      throw error;
    }

    // Rename old file so migration doesn't run again. A previous `.migrated`
    // file is another copy of a database, so this must not replace it: a
    // rename onto an existing name succeeds on Linux and would delete it.
    let retired = `${OLD_DB_PATH}.migrated`;
    if (fs.existsSync(retired)) retired = `${retired}-${Date.now()}`;
    renameWithRetry(OLD_DB_PATH, retired);
  } catch (err) {
    // non-fatal — new install will start fresh
    migrationFailure = describeError(err).text;
  }
}
migrateIfNeeded();

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (err) {
  process.stderr.write(formatDatabaseStartupFailure({
    heading: `[ERROR] Failed to create database directory: ${DATA_DIR}`,
    error: err,
    step: 'create the data directory',
    databasePath: DB_PATH,
    dataDir: DATA_DIR,
    note: migrationFailure,
  }));
  process.exit(1);
}

let db;

/**
 * The read cache is deliberately OFF.
 *
 * good.db's cache is a plain in-process LRU with no TTL and no invalidation
 * across connections: the first `get` of a key stores the value, and every
 * later `get` in that process returns it forever (the map holds 1024 entries
 * and this app uses a handful of keys, so nothing is ever evicted).
 *
 * Easy DevOps runs as SEVERAL processes against ONE database file — the CLI,
 * the dashboard (which hosts the hub agent) and any `ezz` invocation. With the
 * cache on, a value written by the CLI was invisible to the running dashboard
 * for the life of that process, so the agent's revision poll could never see a
 * CLI-side change and those changes never reached the Hub.
 *
 * Measured cost of reading straight from SQLite: ~50us for a scalar key and
 * ~150us for the whole domain list. The dashboard reads at a few hundred ops
 * per minute, so this is invisible — and correctness here cannot be opted into
 * per call site without every future caller having to remember.
 */
function createDbConnection() {
  return new GoodDB(new SQLiteDriver({ path: dbPath }), {
    nested: "..",
    nestedIsEnabled: true,
    cache: {
      capacity: 1024,
      isEnabled: false,
    }
  });
}

/**
 * The native SQLite addon and the database layer, loaded as explicit steps.
 *
 * They used to be static imports at the top of this file, which meant a broken
 * addon - the classic "upgraded while the old process was running" state -
 * failed with a raw module-resolution stack trace and no idea what to do about
 * it. Loaded here, the failure is caught, keeps its real code, and names its
 * step. `require('better-sqlite3')` comes first so the addon's own error
 * (ERR_DLOPEN_FAILED, NODE_MODULE_VERSION, "Could not locate the bindings
 * file") is what gets reported, not good.db's wrapper around it.
 */
let GoodDB;
let SQLiteDriver;

try {
  require('better-sqlite3');
} catch (err) {
  process.stderr.write(formatDatabaseStartupFailure({
    error: err,
    step: 'load better-sqlite3 (the native SQLite addon)',
    packageRoot: PACKAGE_ROOT,
    note: migrationFailure,
  }));
  process.exit(1);
}

try {
  ({ GoodDB, SQLiteDriver } = await import('good.db'));
} catch (err) {
  process.stderr.write(formatDatabaseStartupFailure({
    error: err,
    step: 'load good.db (the database layer)',
    packageRoot: PACKAGE_ROOT,
    note: migrationFailure,
  }));
  process.exit(1);
}

try {
  db = createDbConnection();
} catch (err) {
  process.stderr.write(formatDatabaseStartupFailure({
    error: err,
    step: openStepFor(err),
    note: migrationFailure,
  }));
  process.exit(1);
}

export { db };
export const dbGet = (key) => db.get(key);
export const dbSet = (key, value) => db.set(key, value);
export const dbDelete = (key) => db.delete(key);

/**
 * Reads the KEY NAMES of a database file that is not this process's live
 * connection, without opening it through good.db.
 *
 * ── Why this is not dbGet()/dbSet() (CLAUDE.md rule 10) ────────────────────
 *
 * Rule 10 says every read and write goes through dbGet/dbSet. This is the one
 * deliberate exception, and it is narrow: it inspects a FOREIGN file — the
 * leftover `C:\ProgramData\easy-devops\easy-devops.sqlite` from an earlier
 * Server-mode install (see core/service/dataDir.js). It cannot use good.db:
 * good.db's constructor runs `CREATE TABLE IF NOT EXISTS gooddb` and opens the
 * file READ-WRITE, which would (a) modify a file the user has not chosen yet
 * and (b) fail on exactly the unreadable/permission cases this check exists to
 * report. So the handle is opened by better-sqlite3 directly, READ-ONLY, with
 * `fileMustExist`, and the only statement issued is
 *
 *     SELECT key FROM gooddb ORDER BY key
 *
 * over the table and columns good.db itself creates
 * (node_modules/good.db/dist/Drivers/SQLite.js:15: `CREATE TABLE IF NOT EXISTS
 * <table> (key TEXT PRIMARY KEY, value TEXT)`). The `value` column is never
 * selected, so no user data — domain config, hub tokens, the password hash —
 * can leave this function.
 *
 * @param {string} file
 * @returns {{ exists: boolean, ok: boolean, keyCount: number, keys: string[],
 *             size: number, mtime: string|null, error: string|null }}
 */
export function inspectDatabaseFile(file) {
  const result = {
    exists: false,
    ok: false,
    keyCount: 0,
    keys: [],
    size: 0,
    mtime: null,
    error: null,
  };

  if (!file || typeof file !== 'string') {
    return { ...result, error: 'no database file was given' };
  }

  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return result;
    return { ...result, error: describeError(error).text };
  }

  result.exists = true;
  result.size = stat.size;
  result.mtime = stat.mtime instanceof Date && !Number.isNaN(stat.mtime.getTime())
    ? stat.mtime.toISOString()
    : null;

  if (!stat.isFile()) {
    return { ...result, error: `${file} exists but is not a regular file` };
  }

  // WAL sidecars, snapshotted before the open.
  //
  // A READ-ONLY SQLite connection to a database whose header says "WAL" but
  // which has no -wal/-shm beside it (a cleanly closed database, or one copied
  // off a server) still CREATES an empty `<db>-wal` and a `<db>-shm` wal-index.
  // That is a write to the user's folder, and this function must not leave one
  // behind. Measured, not assumed: better-sqlite3 gives -wal 0 bytes and -shm
  // 32768 bytes, and close() keeps them.
  //
  // So: record which sidecars already exist, and afterwards remove only the
  // ones this call created. A sidecar that was already there belongs to
  // someone else's connection and is never touched. On Windows an open sidecar
  // cannot be unlinked at all (EBUSY), so a concurrent reader is protected
  // twice; callers stop the service and close ezz/dashboard before inspecting
  // ProgramData (see core/service/dataDir.js setAsideLeftoverServerData).
  const sidecarsBefore = new Map();
  for (const sidecar of [`${file}-wal`, `${file}-shm`]) {
    try {
      sidecarsBefore.set(sidecar, fs.lstatSync(sidecar));
    } catch {
      sidecarsBefore.set(sidecar, null);
    }
  }

  let handle = null;
  try {
    const Database = require('better-sqlite3');
    // readonly: never writes. fileMustExist: never creates the file or its
    // -wal/-shm siblings for a path that is not there.
    handle = new Database(file, { readonly: true, fileMustExist: true });
    const rows = handle.prepare('SELECT key FROM gooddb ORDER BY key').all();
    result.keys = rows.map((row) => String(row.key));
    result.keyCount = result.keys.length;
    result.ok = true;
  } catch (error) {
    result.error = describeError(error).text;
  } finally {
    if (handle) {
      try { handle.close(); } catch { /* the handle is already unusable */ }
    }
    for (const [sidecar, before] of sidecarsBefore) {
      if (before) continue;
      try {
        const created = fs.lstatSync(sidecar);
        if (!created.isFile() || created.nlink !== 1) continue;
        // The wal-index is rebuildable and the -wal this call made is empty.
        if (sidecar.endsWith('-wal') && created.size !== 0) continue;
        fs.unlinkSync(sidecar);
      } catch {
        // Not created by this call, or already gone / held open. Leave it.
      }
    }
  }

  return result;
}

/**
 * Closes the underlying SQLite connection.
 * Call this before any operation that needs to rename or replace the db file
 * (e.g. npm install -g), otherwise the open file handle causes EBUSY on Windows.
 */
export function closeDb() {
  try {
    db.driver?.db?.close?.();
  } catch { /* ignore */ }
}

/**
 * Opens a connection, or throws an error that says what failed and what to do.
 *
 * Used by the two entry points that reopen the database inside a live process
 * (initDb after closeDb, reopenDb after a data-directory change). They cannot
 * print and exit: the caller owns the process and has its own reporting - see
 * core/updater.js. The error keeps the SQLite code and carries the same
 * diagnosis the startup path prints.
 *
 * @param {string} file The database file the new connection will use
 * @returns {Object} The good.db handle
 */
function openDatabaseOrThrow(file = dbPath) {
  try {
    return createDbConnection();
  } catch (error) {
    const failure = new Error(diagnoseDatabaseFailure({
      error,
      step: openStepFor(error),
      databasePath: file,
      dataDir: path.dirname(file),
    }).join('\n'));
    failure.code = error?.code ?? error?.name ?? 'E_DB_OPEN';
    failure.cause = error;
    throw failure;
  }
}

/**
 * Reinitializes the database connection after it was closed.
 * Call this after closeDb() when you need to use the database again.
 */
export function initDb() {
  try {
    // Check if connection is still open
    db.driver?.db?.prepare('SELECT 1');
  } catch {
    // Connection is closed, create a new one
    db = openDatabaseOrThrow();
  }
}

/**
 * Closes the connection and opens the database in the CURRENT data directory.
 *
 * For the one place where the data directory changes within a process: the
 * Windows Server-mode switch during `ezz service install`. Without it, the
 * installing process kept writing to the per-user database it opened at
 * startup — a file every later process ignores — and Windows refused to
 * rename that directory to its backup name because this handle held it open.
 *
 * @returns {string} The database file now in use
 */
export function reopenDb() {
  closeDb();
  const dir = getDataDir();
  fs.mkdirSync(dir, { recursive: true });
  dbPath = path.join(dir, 'easy-devops.sqlite');
  db = openDatabaseOrThrow(dbPath);
  return dbPath;
}
