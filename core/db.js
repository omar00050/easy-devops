import { GoodDB, SQLiteDriver } from 'good.db';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'easy-devops.sqlite');

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (err) {
  process.stderr.write(`[ERROR] Failed to create database directory: ${DATA_DIR}\n`);
  process.stderr.write(`Hint: Check that the current user has write access to: ${path.dirname(DATA_DIR)}\n`);
  process.exit(1);
}

let db;

function createDbConnection() {
  return new GoodDB(new SQLiteDriver({ path: DB_PATH }));
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
