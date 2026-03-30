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
try {
  db = new GoodDB(new SQLiteDriver({ path: DB_PATH }));
} catch (err) {
  process.stderr.write(`[ERROR] Failed to initialize database at: ${DB_PATH}\n`);
  process.stderr.write(`Hint: Check that the current user has write access to: ${DATA_DIR}\n`);
  process.exit(1);
}

export { db };
export const dbGet = (key) => db.get(key);
export const dbSet = (key, value) => db.set(key, value);
export const dbDelete = (key) => db.delete(key);
