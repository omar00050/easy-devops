/**
 * Leftover Server-mode data (1.4.8, item 5).
 *
 * The real 1.4.7 Windows Server held the REAL database (15 keys) in
 * `C:\ProgramData\easy-devops` with no `.server-mode` marker, and a near-empty
 * one (4 keys) in `%APPDATA%\easy-devops` that the CLI had just created. The
 * service install refused because the folder was "not empty", and the moment
 * the user removed the folder the near-empty database would have replaced the
 * real one.
 *
 * This suite covers the data layer of the fix:
 *
 *   - core/db.js inspectDatabaseFile(): key NAMES only, read-only, never
 *     creates the file or its -wal/-shm siblings, works on a database another
 *     connection has open;
 *   - core/service/dataDir.js detect/adopt/set-aside;
 *   - moveDataDir: service code folders in the target are not content, are
 *     never copied over and never deleted, and no existing target entry is
 *     ever overwritten;
 *   - enableServerMode()/disableServerMode() refuse to migrate %APPDATA% over
 *     a leftover ProgramData database.
 *
 * Everything happens in temporary directories. The ProgramData and user data
 * roots are INJECTED as parameters (or, for the enable/disable checks, through
 * the EZ_TEST-aware %ProgramData% override), never resolved to the real ones.
 *
 * Run with:  node e2e/run.mjs leftover-data
 */

// MUST be the first static import — see e2e/lib/guard.mjs.
import './lib/guard.mjs';
import { TEST_DATA_DIR } from './lib/guard.mjs';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const srcUrl = (rel) => pathToFileURL(path.join(ROOT, 'src', rel)).href;
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const results = [];
let skipped = 0;
let group = '';

function setGroup(name) {
  group = name;
  process.stdout.write(`\n── ${name}\n`);
}

function check(label, passed, detail = '') {
  results.push({ group, label, passed, detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}

function skip(label, why) {
  skipped += 1;
  process.stdout.write(`   SKIP  ${label}  (${why})\n`);
}

// ─── Isolation ──────────────────────────────────────────────────────────────

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-leftover-data-'));

function scratch(name) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function listNames(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

const REAL_KEYS = [
  'config', 'domains', 'hub-link', 'hub-permissions', 'hub-revision',
  'service-state', 'deployApps', 'dashboard-pid', 'dashboard-port',
  'setup-code', 'sslAutoRenewState', 'system-detection', 'session_secret',
  'notification_channels', 'domain_notification_config',
];
const SMALL_KEYS = ['config', 'system-detection', 'update-pre-dashboard', 'service-state'];

const REAL_VALUE = 'PROGRAMDATA-SECRET-VALUE-MUST-NOT-BE-PRINTED';
const SMALL_VALUE = 'APPDATA-SECRET-VALUE-MUST-NOT-BE-PRINTED';

/**
 * A real SQLite file with good.db's table, exactly as good.db creates it
 * (node_modules/good.db/dist/Drivers/SQLite.js:15): `gooddb(key TEXT PRIMARY
 * KEY, value TEXT)`, values JSON-encoded. Used here only to build fixtures;
 * the product reads key names through core/db.js.
 */
function createDatabase(file, keys, valuePrefix) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const handle = new Database(file);
  try {
    handle.exec('CREATE TABLE IF NOT EXISTS gooddb (key TEXT PRIMARY KEY, value TEXT)');
    const insert = handle.prepare('INSERT OR REPLACE INTO gooddb (key, value) VALUES (?, ?)');
    for (const key of keys) {
      insert.run(key, JSON.stringify({ note: `${valuePrefix}-${key}`, config: { value: valuePrefix } }));
    }
  } finally {
    handle.close();
  }
}

async function main() {
  const platform = await import(srcUrl('core/platform.js'));
  const isWindows = platform.isWindows;
  const dbMod = await import(srcUrl('core/db.js'));
  const dataDirMod = await import(srcUrl('core/service/dataDir.js'));

  try {
    // ─── 1. inspectDatabaseFile ─────────────────────────────────────────────
    setGroup('1. a foreign database is inspected read-only, names only');

    const inspectRoot = scratch('inspect');
    const realDb = path.join(inspectRoot, 'programdata', 'easy-devops', 'easy-devops.sqlite');
    createDatabase(realDb, REAL_KEYS, REAL_VALUE);
    const realDbHash = sha256(realDb);

    const info = dbMod.inspectDatabaseFile(realDb);
    check('a good.db database is readable', info.ok === true && info.exists === true,
      info.error ?? '');
    check('every key name comes back', info.keyCount === 15, String(info.keyCount));
    check('the key names are exactly the stored ones, sorted',
      JSON.stringify(info.keys) === JSON.stringify([...REAL_KEYS].sort()));
    check('size and modified time are reported',
      info.size > 0 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(info.mtime ?? ''),
      `${info.size} / ${info.mtime}`);
    const printed = JSON.stringify(info);
    check('no VALUE text appears anywhere in the answer', !printed.includes(REAL_VALUE));
    check('the answer has no "value" field', !('value' in info));
    check('inspection did not modify the database bytes', sha256(realDb) === realDbHash);

    const beforeSidecars = listNames(path.dirname(realDb));
    dbMod.inspectDatabaseFile(realDb);
    check('inspection creates no -wal/-shm files that were not there',
      JSON.stringify(listNames(path.dirname(realDb))) === JSON.stringify(beforeSidecars),
      beforeSidecars.join(','));

    const missing = dbMod.inspectDatabaseFile(path.join(inspectRoot, 'nope.sqlite'));
    check('a missing file reports exists:false and creates nothing',
      missing.exists === false && missing.ok === false
        && !fs.existsSync(path.join(inspectRoot, 'nope.sqlite')));
    check('and creates no empty -wal/-shm beside it',
      JSON.stringify(listNames(inspectRoot)) === JSON.stringify(['programdata']),
      listNames(inspectRoot).join(','));

    const notADb = path.join(inspectRoot, 'not-a-database.sqlite');
    fs.writeFileSync(notADb, 'this is not sqlite');
    const broken = dbMod.inspectDatabaseFile(notADb);
    check('a non-database file reports ok:false with a code and a message',
      broken.exists === true && broken.ok === false
        && /SQLITE_|not a database/i.test(broken.error ?? ''), broken.error ?? '');
    check('and its bytes are untouched', fs.readFileSync(notADb, 'utf8') === 'this is not sqlite');

    // WAL: the real state on the server, where the daemon holds the file open.
    const walFile = path.join(inspectRoot, 'live-wal.sqlite');
    const live = new Database(walFile);
    let walInfo;
    let walBefore;
    let walAfter;
    try {
      live.pragma('journal_mode = WAL');
      live.exec('CREATE TABLE IF NOT EXISTS gooddb (key TEXT PRIMARY KEY, value TEXT)');
      live.prepare('INSERT OR REPLACE INTO gooddb (key, value) VALUES (?, ?)')
        .run('config', JSON.stringify({ note: REAL_VALUE }));
      walBefore = listNames(inspectRoot);
      walInfo = dbMod.inspectDatabaseFile(walFile);
      walAfter = listNames(inspectRoot);
    } finally {
      live.close();
    }
    check('a database a live connection holds open (WAL) is inspected',
      walInfo?.ok === true && walInfo?.keyCount === 1, walInfo?.error ?? '');
    check('and the WAL inspection leaves its sidecar files exactly as they were',
      JSON.stringify(walAfter) === JSON.stringify(walBefore),
      `${walBefore.join(',')} -> ${walAfter.join(',')}`);

    // A WAL database that was closed cleanly has no -wal/-shm beside it. A
    // read-only open still creates them; the inspection must remove only the
    // ones it created, leaving the folder exactly as it found it.
    const closedWalDir = scratch('inspect-closed-wal');
    const closedWalFile = path.join(closedWalDir, 'closed-wal.sqlite');
    const seed = new Database(closedWalFile);
    try {
      seed.pragma('journal_mode = WAL');
      seed.exec('CREATE TABLE IF NOT EXISTS gooddb (key TEXT PRIMARY KEY, value TEXT)');
      seed.prepare('INSERT OR REPLACE INTO gooddb (key, value) VALUES (?, ?)')
        .run('domains', JSON.stringify({ note: REAL_VALUE }));
    } finally {
      seed.close();
    }
    const closedBefore = listNames(closedWalDir);
    const closedInfo = dbMod.inspectDatabaseFile(closedWalFile);
    const closedAfter = listNames(closedWalDir);
    check('a cleanly closed WAL database is inspected',
      closedInfo.ok === true && closedInfo.keyCount === 1 && closedInfo.keys[0] === 'domains',
      closedInfo.error ?? '');
    check('and no -wal/-shm is left behind that was not there',
      JSON.stringify(closedBefore) === JSON.stringify(closedAfter),
      `${closedBefore.join(',')} -> ${closedAfter.join(',')}`);

    // ─── 2. detectLeftoverServerData ────────────────────────────────────────
    setGroup('2. a leftover ProgramData database is detected, with a recommendation');

    if (!isWindows) {
      skip('leftover detection', 'Windows-only: C:\\ProgramData is not used on this platform');
      skip('adopt', 'Windows-only');
      skip('set aside', 'Windows-only');
      skip('enable/disable Server mode', 'Windows-only');
    }

    let leftover;
    if (isWindows) {
      const detectionRoot = scratch('detect');
      const programRoot = path.join(detectionRoot, 'programdata', 'easy-devops');
      const userRoot = path.join(detectionRoot, 'appdata', 'easy-devops');
      const programDb = path.join(programRoot, 'easy-devops.sqlite');
      const userDb = path.join(userRoot, 'easy-devops.sqlite');
      createDatabase(programDb, REAL_KEYS, REAL_VALUE);
      createDatabase(userDb, SMALL_KEYS, SMALL_VALUE);

      leftover = await dataDirMod.detectLeftoverServerData({
        programDataDir: programRoot,
        userDataDir: userRoot,
      });
      check('the ProgramData database with no marker is a leftover',
        leftover.leftover === true);
      check('both sides are described with key counts, not values',
        leftover.programData.db.keyCount === 15 && leftover.userData.db.keyCount === 4,
        `${leftover.programData.db.keyCount} vs ${leftover.userData.db.keyCount}`);
      check('the bigger database is recommended for adoption',
        leftover.recommended === 'adopt', leftover.recommended);
      check('detection leaks no value text', !JSON.stringify(leftover).includes(REAL_VALUE)
        && !JSON.stringify(leftover).includes(SMALL_VALUE));
      check('no folder was turned into code-only', leftover.codeOnly === false);

      // The other way round: the per-user database is the real one.
      const reversedRoot = scratch('detect-reversed');
      const reversedProgram = path.join(reversedRoot, 'programdata', 'easy-devops');
      const reversedUser = path.join(reversedRoot, 'appdata', 'easy-devops');
      createDatabase(path.join(reversedProgram, 'easy-devops.sqlite'), SMALL_KEYS, SMALL_VALUE);
      createDatabase(path.join(reversedUser, 'easy-devops.sqlite'), REAL_KEYS, REAL_VALUE);
      const reversed = await dataDirMod.detectLeftoverServerData({
        programDataDir: reversedProgram,
        userDataDir: reversedUser,
      });
      check('with more keys in %APPDATA% the recommendation is keep-aside',
        reversed.recommended === 'keep-aside', reversed.recommended);

      // A tie goes to adopt: adopting only writes a marker.
      const tieRoot = scratch('detect-tie');
      const tieProgram = path.join(tieRoot, 'programdata', 'easy-devops');
      const tieUser = path.join(tieRoot, 'appdata', 'easy-devops');
      createDatabase(path.join(tieProgram, 'easy-devops.sqlite'), SMALL_KEYS, REAL_VALUE);
      createDatabase(path.join(tieUser, 'easy-devops.sqlite'), SMALL_KEYS, SMALL_VALUE);
      const tie = await dataDirMod.detectLeftoverServerData({
        programDataDir: tieProgram,
        userDataDir: tieUser,
      });
      check('a tie is recommended for adoption', tie.recommended === 'adopt');

      // A marker means Server mode is already established: no leftover.
      fs.writeFileSync(path.join(programRoot, '.server-mode'), '{"enabledAt":"x"}\n');
      const marked = await dataDirMod.detectLeftoverServerData({
        programDataDir: programRoot,
        userDataDir: userRoot,
      });
      check('an existing .server-mode marker makes it not a leftover',
        marked.leftover === false);
      fs.rmSync(path.join(programRoot, '.server-mode'));

      // Code folders only (a previous install): no database, not a leftover.
      const codeRoot = scratch('detect-code');
      const codeProgram = path.join(codeRoot, 'programdata', 'easy-devops');
      fs.mkdirSync(path.join(codeProgram, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(codeProgram, 'runtime'), { recursive: true });
      fs.mkdirSync(path.join(codeProgram, 'runtime.prev'), { recursive: true });
      const codeOnly = await dataDirMod.detectLeftoverServerData({
        programDataDir: codeProgram,
        userDataDir: path.join(codeRoot, 'appdata', 'easy-devops'),
      });
      check('code folders without a database are reported as code-only, not leftover',
        codeOnly.leftover === false && codeOnly.codeOnly === true);
    }

    // ─── 3. adoptLeftoverServerData ─────────────────────────────────────────
    if (isWindows) {
      setGroup('3. adopting writes only the marker and leaves %APPDATA% alone');

      const adoptRoot = scratch('adopt');
      const programRoot = path.join(adoptRoot, 'programdata', 'easy-devops');
      const userRoot = path.join(adoptRoot, 'appdata', 'easy-devops');
      const programDb = path.join(programRoot, 'easy-devops.sqlite');
      const userDb = path.join(userRoot, 'easy-devops.sqlite');
      createDatabase(programDb, REAL_KEYS, REAL_VALUE);
      createDatabase(userDb, SMALL_KEYS, SMALL_VALUE);

      const programHash = sha256(programDb);
      const userHash = sha256(userDb);

      const adopted = await dataDirMod.adoptLeftoverServerData({ programDataDir: programRoot });
      check('adoption succeeds', adopted.ok === true, adopted.reason);
      const marker = path.join(programRoot, '.server-mode');
      check('the marker is written in the Server-mode folder', fs.existsSync(marker));
      let payload = null;
      try {
        payload = JSON.parse(fs.readFileSync(marker, 'utf8'));
      } catch { /* checked below */ }
      check('the marker says what it was and where it came from',
        payload?.migratedFrom === null && payload?.backup === null
          && typeof payload?.enabledAt === 'string' && typeof payload?.adoptedAt === 'string',
        JSON.stringify(payload));
      const markerStat = fs.lstatSync(marker);
      check('the marker is a regular single-link file',
        markerStat.isFile() && !markerStat.isSymbolicLink() && markerStat.nlink === 1);
      check('the adopted database is byte-identical', sha256(programDb) === programHash);
      check('%APPDATA% was not touched at all', sha256(userDb) === userHash);
      check('and nothing was created beside %APPDATA%\'s database',
        JSON.stringify(listNames(userRoot)) === JSON.stringify(['easy-devops.sqlite']),
        listNames(userRoot).join(','));

      const again = await dataDirMod.adoptLeftoverServerData({ programDataDir: programRoot });
      check('adopting again is a no-op that keeps the original marker bytes',
        again.ok === true && fs.readFileSync(marker, 'utf8') === `${JSON.stringify(payload)}\n`);

      // A marker that is a hard link is refused, and the foreign file survives.
      const hardRoot = scratch('adopt-hardlink');
      const hardProgram = path.join(hardRoot, 'programdata', 'easy-devops');
      createDatabase(path.join(hardProgram, 'easy-devops.sqlite'), SMALL_KEYS, SMALL_VALUE);
      const foreign = path.join(hardRoot, 'foreign.txt');
      fs.writeFileSync(foreign, 'FOREIGN');
      fs.linkSync(foreign, path.join(hardProgram, '.server-mode'));
      const hardRefused = await dataDirMod.adoptLeftoverServerData({ programDataDir: hardProgram });
      check('a hard-linked marker is refused', hardRefused.ok === false, hardRefused.reason);
      check('and the foreign file is untouched', fs.readFileSync(foreign, 'utf8') === 'FOREIGN');

      const emptyRoot = scratch('adopt-empty');
      const emptyAdopt = await dataDirMod.adoptLeftoverServerData({
        programDataDir: path.join(emptyRoot, 'easy-devops'),
      });
      check('adopting a folder with no database is refused',
        emptyAdopt.ok === false && /could not be inspected|not a regular/i.test(emptyAdopt.reason),
        emptyAdopt.reason);
    }

    // ─── 4. setAsideLeftoverServerData ──────────────────────────────────────
    if (isWindows) {
      setGroup('4. setting aside renames once, verifies, and never loses data');

      const asideRoot = scratch('aside');
      const programParent = path.join(asideRoot, 'programdata');
      const source = path.join(programParent, 'easy-devops');
      const userRoot = path.join(asideRoot, 'appdata', 'easy-devops');
      const programDb = path.join(source, 'easy-devops.sqlite');
      const userDb = path.join(userRoot, 'easy-devops.sqlite');
      fs.mkdirSync(path.join(source, 'logs'), { recursive: true });
      createDatabase(programDb, REAL_KEYS, REAL_VALUE);
      fs.writeFileSync(path.join(source, 'logs', 'daemon.log'), 'LOG LINE\n');
      createDatabase(userDb, SMALL_KEYS, SMALL_VALUE);

      // The first name for that date is taken by an older aside.
      const firstAside = path.join(programParent, 'easy-devops.old-2026-01-02');
      fs.mkdirSync(firstAside, { recursive: true });
      fs.writeFileSync(path.join(firstAside, 'keep.txt'), 'OLDER ASIDE');

      const programHash = sha256(programDb);
      const userHash = sha256(userDb);
      const olderHash = sha256(path.join(firstAside, 'keep.txt'));

      const aside = await dataDirMod.setAsideLeftoverServerData({
        programDataDir: source,
        now: new Date('2026-01-02T10:00:00Z'),
      });
      check('the folder is renamed with the next free suffix',
        aside.ok === true && path.basename(aside.movedTo) === 'easy-devops.old-2026-01-02-2',
        aside.movedTo ?? aside.reason);
      check('the original path is gone', !fs.existsSync(source));
      check('the database arrived byte-identically',
        aside.ok === true && sha256(path.join(aside.movedTo, 'easy-devops.sqlite')) === programHash);
      check('the rest of the folder came with it',
        fs.readFileSync(path.join(aside.movedTo, 'logs', 'daemon.log'), 'utf8') === 'LOG LINE\n');
      check('the older aside was not touched', sha256(path.join(firstAside, 'keep.txt')) === olderHash);
      check('%APPDATA%\'s database is byte-identical', sha256(userDb) === userHash);

      // A rename that fails (service running / open handle) changes nothing.
      const busyRoot = scratch('aside-busy');
      const busySource = path.join(busyRoot, 'programdata', 'easy-devops');
      createDatabase(path.join(busySource, 'easy-devops.sqlite'), REAL_KEYS, REAL_VALUE);
      const busyHash = sha256(path.join(busySource, 'easy-devops.sqlite'));
      const failingFs = Object.create(fs);
      failingFs.renameSync = () => {
        const error = new Error('resource busy or locked');
        error.code = 'EBUSY';
        throw error;
      };
      const busy = await dataDirMod.setAsideLeftoverServerData({
        programDataDir: busySource,
        now: new Date('2026-01-02T10:00:00Z'),
        fsApi: failingFs,
      });
      check('a rename that fails reports ok:false', busy.ok === false);
      check('the failure names the code and says what to stop',
        /EBUSY/.test(busy.reason) && /stop the service and close ezz\/dashboard/i.test(busy.reason),
        busy.reason);
      check('nothing moved and the database is byte-identical',
        fs.existsSync(busySource) && sha256(path.join(busySource, 'easy-devops.sqlite')) === busyHash);
      check('no aside folder was created by the failed rename',
        !fs.existsSync(path.join(busyRoot, 'programdata', 'easy-devops.old-2026-01-02'))
        && !fs.existsSync(path.join(busyRoot, 'programdata', 'easy-devops.old-2026-01-02-2')));

      // The live database of this process is refused, so a command can never
      // rename the database it is reading.
      const liveDb = await dataDirMod.setAsideLeftoverServerData({
        programDataDir: TEST_DATA_DIR,
        now: new Date('2026-01-02T10:00:00Z'),
      });
      check('the database this process is using is refused',
        liveDb.ok === false && /live database|stop the service/i.test(liveDb.reason),
        liveDb.reason);
      check('and it stays where it is', fs.existsSync(path.join(TEST_DATA_DIR, 'easy-devops.sqlite')));
    }

    // ─── 5. enable/disable Server mode refuse the leftover state ────────────
    if (isWindows) {
      setGroup('5. Server mode refuses to migrate over leftover data');

      const previousProgramData = process.env.ProgramData;
      const previousAppData = process.env.APPDATA;
      const gateRoot = scratch('gate');
      try {
        process.env.ProgramData = path.join(gateRoot, 'programdata');
        process.env.APPDATA = path.join(gateRoot, 'appdata');
        platform.resetDataDirCache();

        const programRoot = platform.programDataDir();
        const userRoot = path.join(gateRoot, 'appdata', 'easy-devops');
        const programDb = path.join(programRoot, 'easy-devops.sqlite');
        const userDb = path.join(userRoot, 'easy-devops.sqlite');
        createDatabase(programDb, REAL_KEYS, REAL_VALUE);
        createDatabase(userDb, SMALL_KEYS, SMALL_VALUE);
        const programHash = sha256(programDb);
        const userHash = sha256(userDb);

        const enabled = await dataDirMod.enableServerMode({});
        check('enabling Server mode refuses with code leftover_data',
          enabled.ok === false && enabled.code === 'leftover_data', enabled.reason);
        check('it reports what was found',
          enabled.leftover?.leftover === true
            && enabled.leftover?.programData?.db?.keyCount === 15);
        check('no marker was written', !fs.existsSync(path.join(programRoot, '.server-mode')));
        check('the ProgramData database is byte-identical', sha256(programDb) === programHash);
        check('the %APPDATA% database was NOT copied over it and is byte-identical',
          sha256(userDb) === userHash);

        const disabled = await dataDirMod.disableServerMode({});
        check('disabling Server mode also refuses with code leftover_data',
          disabled.ok === false && disabled.code === 'leftover_data', disabled.reason);
        check('and leaves both databases alone',
          sha256(programDb) === programHash && sha256(userDb) === userHash);
      } finally {
        if (previousProgramData === undefined) delete process.env.ProgramData;
        else process.env.ProgramData = previousProgramData;
        if (previousAppData === undefined) delete process.env.APPDATA;
        else process.env.APPDATA = previousAppData;
        platform.resetDataDirCache();
      }
    }

    // ─── 6. moveDataDir and service code folders ────────────────────────────
    setGroup('6. data moves beside code folders, never over them');

    const moveRoot = scratch('move');
    const source = path.join(moveRoot, 'appdata', 'easy-devops');
    const target = path.join(moveRoot, 'programdata', 'easy-devops');
    fs.mkdirSync(path.join(source, 'sessions'), { recursive: true });
    createDatabase(path.join(source, 'easy-devops.sqlite'), SMALL_KEYS, SMALL_VALUE);
    fs.writeFileSync(path.join(source, 'sessions', 's1.json'), '{"a":1}');
    const sourceDbHash = sha256(path.join(source, 'easy-devops.sqlite'));

    fs.mkdirSync(path.join(target, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(target, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(target, 'runtime.prev'), { recursive: true });
    fs.writeFileSync(path.join(target, 'bin', 'EasyDevOps.exe'), 'BIN');
    fs.writeFileSync(path.join(target, 'runtime', 'node.exe'), 'NODE');
    fs.writeFileSync(path.join(target, 'runtime.prev', 'node.exe'), 'OLD NODE');

    const moved = await dataDirMod.moveDataDir({ from: source, to: target });
    check('a target holding only code folders accepts the data', moved.ok === true, moved.reason ?? '');
    check('the data arrived byte-identically',
      sha256(path.join(target, 'easy-devops.sqlite')) === sourceDbHash);
    check('nested data arrived', fs.readFileSync(path.join(target, 'sessions', 's1.json'), 'utf8') === '{"a":1}');
    check('the code folders are still there, untouched',
      fs.readFileSync(path.join(target, 'bin', 'EasyDevOps.exe'), 'utf8') === 'BIN'
      && fs.readFileSync(path.join(target, 'runtime', 'node.exe'), 'utf8') === 'NODE'
      && fs.readFileSync(path.join(target, 'runtime.prev', 'node.exe'), 'utf8') === 'OLD NODE');
    check('the source was moved to a backup',
      moved.backup !== null && fs.existsSync(moved.backup) && !fs.existsSync(source));

    // Any other entry is content, and is still a refusal.
    const contentSource = path.join(moveRoot, 'content-source');
    fs.mkdirSync(contentSource, { recursive: true });
    createDatabase(path.join(contentSource, 'easy-devops.sqlite'), SMALL_KEYS, SMALL_VALUE);
    const contentTarget = path.join(moveRoot, 'content-target');
    fs.mkdirSync(path.join(contentTarget, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(contentTarget, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(contentTarget, 'logs', 'leftover.log'), 'KEEP');
    const contentRefused = await dataDirMod.moveDataDir({ from: contentSource, to: contentTarget });
    check('log files in the target are still a refusal',
      contentRefused.ok === false && /is not empty/.test(contentRefused.reason), contentRefused.reason);
    check('and nothing was copied into it',
      !fs.existsSync(path.join(contentTarget, 'easy-devops.sqlite'))
      && fs.readFileSync(path.join(contentTarget, 'logs', 'leftover.log'), 'utf8') === 'KEEP');
    check('the source is still where it was',
      fs.existsSync(path.join(contentSource, 'easy-devops.sqlite')));

    // A name that exists on both sides is never overwritten, even when it is a
    // code folder name: the target copy wins and the move refuses.
    const clashSource = path.join(moveRoot, 'clash-source');
    fs.mkdirSync(path.join(clashSource, 'runtime'), { recursive: true });
    createDatabase(path.join(clashSource, 'easy-devops.sqlite'), SMALL_KEYS, SMALL_VALUE);
    fs.writeFileSync(path.join(clashSource, 'runtime', 'user-file.txt'), 'USER');
    const clashTarget = path.join(moveRoot, 'clash-target');
    fs.mkdirSync(path.join(clashTarget, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(clashTarget, 'runtime', 'node.exe'), 'TARGET NODE');
    const clashRefused = await dataDirMod.moveDataDir({ from: clashSource, to: clashTarget });
    check('a top-level name present on both sides is refused',
      clashRefused.ok === false && /Refusing to overwrite/i.test(clashRefused.reason),
      clashRefused.reason);
    check('the target entry is untouched',
      fs.readFileSync(path.join(clashTarget, 'runtime', 'node.exe'), 'utf8') === 'TARGET NODE'
      && !fs.existsSync(path.join(clashTarget, 'runtime', 'user-file.txt')));
    check('the source is untouched', fs.readFileSync(path.join(clashSource, 'runtime', 'user-file.txt'), 'utf8') === 'USER');

    // A target database file is content: refused, and its bytes survive.
    const dbTarget = path.join(moveRoot, 'db-target');
    fs.mkdirSync(path.join(dbTarget, 'bin'), { recursive: true });
    createDatabase(path.join(dbTarget, 'easy-devops.sqlite'), REAL_KEYS, REAL_VALUE);
    const existingDbHash = sha256(path.join(dbTarget, 'easy-devops.sqlite'));
    const dbRefused = await dataDirMod.moveDataDir({ from: contentSource, to: dbTarget });
    check('an existing target database is never overwritten',
      dbRefused.ok === false && sha256(path.join(dbTarget, 'easy-devops.sqlite')) === existingDbHash,
      dbRefused.reason);
  } finally {
    // Release the live SQLite handle so the runner can remove its temp folder,
    // then our own scratch tree.
    try { dbMod.closeDb(); } catch { /* never opened */ }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const failed = results.filter((r) => !r.passed);
  process.stdout.write(`\n${'─'.repeat(62)}\n`);
  process.stdout.write(
    `TOTAL ${results.length}   PASS ${results.length - failed.length}   FAIL ${failed.length}   SKIP ${skipped}\n`,
  );
  if (failed.length) {
    process.stdout.write('\nFailures:\n');
    for (const f of failed) {
      process.stdout.write(`  [${f.group}] ${f.label}${f.detail ? ` — ${f.detail}` : ''}\n`);
    }
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(1);
});
