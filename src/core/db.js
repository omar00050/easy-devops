import { GoodDB, SQLiteDriver } from 'good.db';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDataDir, isDevDataDir } from './platform.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolved once per process. The location lives in core/platform.js so the
// database, sessions and logs all agree on it — see getDataDir().
const DATA_DIR = getDataDir();

const DB_PATH = path.join(DATA_DIR, 'easy-devops.sqlite');

// ─── One-time migration from old package-relative location ───────────────────
const OLD_DATA_DIR = path.join(__dirname, '..', '..', 'data');
const OLD_DB_PATH = path.join(OLD_DATA_DIR, 'easy-devops.sqlite');
function migrateIfNeeded() {
  // Never migrate into a dev/test data directory: the migration RENAMES the
  // legacy database, so running with --dev (or any EASY_DEVOPS_DATA_DIR)
  // would consume the real installation's data.
  if (isDevDataDir()) return;

  try {
    if (fs.existsSync(OLD_DB_PATH) && !fs.existsSync(DB_PATH)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.copyFileSync(OLD_DB_PATH, DB_PATH);
      // Rename old file so migration doesn't run again
      fs.renameSync(OLD_DB_PATH, OLD_DB_PATH + '.migrated');
    }
  } catch { /* non-fatal — new install will start fresh */ }
}
migrateIfNeeded();

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (err) {
  process.stderr.write(`[ERROR] Failed to create database directory: ${DATA_DIR}\n`);
  process.stderr.write(`Hint: Check that the current user has write access to: ${path.dirname(DATA_DIR)}\n`);
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
  return new GoodDB(new SQLiteDriver({ path: DB_PATH }), {
    nested: "..",
    nestedIsEnabled: true,
    cache: {
      capacity: 1024,
      isEnabled: false,
    }
  });
}

try {
  db = createDbConnection();
} catch (err) {
  process.stderr.write(`[ERROR] Failed to initialize database at: ${DB_PATH}\n`);
  process.stderr.write(`Hint: Check that the current user has write access to: ${DATA_DIR}\n`);
  process.exit(1);
}

export { db };
export const dbGet = (key) => db.get(key);
export const dbSet = (key, value) => db.set(key, value);
export const dbDelete = (key) => db.delete(key);

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
 * Reinitializes the database connection after it was closed.
 * Call this after closeDb() when you need to use the database again.
 */
export function initDb() {
  try {
    // Check if connection is still open
    db.driver?.db?.prepare('SELECT 1');
  } catch {
    // Connection is closed, create a new one
    db = createDbConnection();
  }
}
