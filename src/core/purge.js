/**
 * core/purge.js
 *
 * `ezz uninstall --purge` — remove Easy DevOps itself: the service, the pinned
 * runtime and the data directory.
 *
 * ── The backup comes first, and it is not optional ─────────────────────────
 *
 * The data directory holds the only copy of things that cannot be regenerated:
 * the domain list, the notification channels, the Hub pairing, the dashboard
 * password hash and the session secret. A purge that removed it and then
 * failed, or that the user regretted an hour later, would be unrecoverable.
 *
 * So the order is: export, verify the export, print where it is, and only then
 * remove anything. If the export fails, nothing is removed at all — that is
 * the one failure that aborts the whole operation rather than being reported
 * and worked around.
 *
 * The backup is a plain directory copy, not an archive. No new dependency can
 * be added (and none is needed): a directory is restorable with the file
 * manager the user already has, needs no tool to inspect, and cannot be
 * half-written in a way that looks complete. It goes OUTSIDE the data
 * directory, in the user's home by default, because the data directory is what
 * is about to be deleted.
 *
 * ── What is kept, deliberately ─────────────────────────────────────────────
 *
 * nginx itself, the sites it serves, and the certificates. Easy DevOps
 * configures nginx; it does not own it. Removing a working web server because
 * its configuration tool was uninstalled would take sites offline, and that is
 * never what "uninstall the tool" means. Certificates are the one part the
 * caller may choose to remove, because they are private keys — the default is
 * to keep them, and the caller has to ask for anything else.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

import { getDataDir, isWindows, programDataDir } from './platform.js';
import { loadConfig } from './config.js';
import { closeDb, initDb } from './db.js';
import { runtimeDir, runtimeNodePath, inspectLink } from './service/runtime.js';
import { detectInstallSource } from './installSource.js';
import { PACKAGE } from './updater.js';

const require = createRequire(import.meta.url);

/** `easy-devops-backup-2026-11-15T05-40-12`. */
export function backupName(now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace(/Z$/, '').slice(0, 19);
  return `easy-devops-backup-${stamp}`;
}

/** Where a backup goes unless the caller says otherwise: the user's home. */
export function defaultBackupDir() {
  return os.homedir();
}

/**
 * Copies the data directory somewhere safe and describes what is in it.
 *
 * The SQLite handle is closed first and reopened after: on Windows an open
 * database file cannot be copied reliably, and a copy taken mid-write is worse
 * than no copy because it looks like one.
 *
 * @param {Object} [opts]
 * @returns {{ ok: boolean, path?: string, bytes?: number, reason?: string }}
 */
export function exportBackup({
  dataDir = getDataDir(),
  into = defaultBackupDir(),
  now = new Date(),
  log = () => {},
} = {}) {
  const dest = path.join(into, backupName(now));

  if (!fs.existsSync(dataDir)) {
    return { ok: false, reason: `there is no data directory at ${dataDir}` };
  }

  // Refusing rather than merging into something that already exists: a second
  // purge in the same second is unlikely, but overwriting a backup is exactly
  // the kind of thing that is only noticed when it is needed.
  if (fs.existsSync(dest)) {
    return { ok: false, reason: `${dest} already exists` };
  }

  const config = safeConfig();

  closeDb();
  try {
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(dataDir, path.join(dest, 'data'), { recursive: true });
  } catch (err) {
    return { ok: false, reason: `could not copy ${dataDir}: ${err.message}` };
  } finally {
    initDb();
  }

  // Verified, not assumed: the database is the file that matters, and a copy
  // that silently skipped it would be discovered only on a restore.
  const dbName = 'easy-devops.sqlite';
  const copiedDb = path.join(dest, 'data', dbName);
  if (fs.existsSync(path.join(dataDir, dbName)) && !fs.existsSync(copiedDb)) {
    return { ok: false, reason: `the backup is missing ${dbName}; nothing was removed` };
  }

  try {
    fs.writeFileSync(path.join(dest, 'MANIFEST.txt'), manifest({ dataDir, config, now }), 'utf8');
  } catch (err) {
    log(`could not write the manifest: ${err.message}`);
  }

  log(`Backup written to ${dest}`);
  return { ok: true, path: dest, bytes: dirSize(dest) };
}

/** Config without the secrets a backup note has no business repeating. */
function safeConfig() {
  const config = loadConfig();
  return {
    dashboardPort: config.dashboardPort,
    dashboardBindAddress: config.dashboardBindAddress,
    dashboardAuth: config.dashboardAuth,
    dashboardUi: config.dashboardUi,
    nginxDir: config.nginxDir,
    sslDir: config.sslDir,
    acmeEmail: config.acmeEmail,
  };
}

function manifest({ dataDir, config, now }) {
  const version = String(require('../../package.json').version);

  return [
    'Easy DevOps backup',
    '==================',
    '',
    `taken        : ${now.toISOString()}`,
    `version      : ${version}`,
    `platform     : ${process.platform}`,
    `data dir     : ${dataDir}`,
    '',
    'What is here',
    '------------',
    'data/   a copy of the whole Easy DevOps data directory, including',
    '        easy-devops.sqlite - the domains, notification channels, Hub',
    '        pairing, dashboard password hash and session secret.',
    '',
    'What is NOT here',
    '----------------',
    `nginx configuration (${config.nginxDir ?? 'not configured'}) and the`,
    `certificates (${config.sslDir ?? 'not configured'}) were left in place on`,
    'the machine, not copied. nginx and your sites keep running.',
    '',
    'Restoring',
    '---------',
    `1. Reinstall Easy DevOps:  npm install -g ${PACKAGE}`,
    '2. Copy data/ back over the new data directory, with nothing running:',
    `     ${dataDir}`,
    '3. ezz service install',
    '',
    'The settings in the database point at the nginx and certificate paths',
    'above, so a restore onto the same machine needs no reconfiguration.',
    '',
  ].join('\n');
}

function dirSize(target) {
  let total = 0;
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.size;
  let entries = [];
  try {
    entries = fs.readdirSync(target);
  } catch {
    return 0;
  }
  for (const entry of entries) total += dirSize(path.join(target, entry));
  return total;
}

/**
 * What a purge would remove and what it would keep, without doing anything.
 *
 * Printed before the confirmation, so the answer to "what exactly is about to
 * happen" is the same list the code then walks.
 *
 * @param {Object} [opts]
 * @returns {{ removes: Array<{ what: string, path: string }>, keeps: Array<{ what: string, path: string }> }}
 */
export function plan({ dataDir = getDataDir(), certificates = 'keep', config = loadConfig() } = {}) {
  const removes = [{ what: 'the background service', path: '(service manager entry)' }];

  const runtime = isWindows ? runtimeDir(dataDir) : path.dirname(runtimeNodePath(dataDir));
  if (fs.existsSync(runtime)) {
    removes.push({ what: 'the pinned runtime', path: runtime });
  }

  removes.push({ what: 'the data directory', path: dataDir });

  if (isWindows && fs.existsSync(programDataDir()) && path.resolve(programDataDir()) !== path.resolve(dataDir)) {
    removes.push({ what: 'the machine-wide data directory', path: programDataDir() });
  }

  const keeps = [
    { what: 'nginx and its configuration', path: config.nginxDir ?? '(not configured)' },
    { what: 'your sites', path: '(served by nginx, untouched)' },
  ];

  if (certificates === 'remove') {
    removes.push({ what: 'the certificates', path: config.sslDir ?? '(not configured)' });
  } else {
    keeps.push({ what: 'the certificates and keys', path: config.sslDir ?? '(not configured)' });
  }

  return { removes, keeps };
}

/**
 * Removes Easy DevOps.
 *
 * @param {Object} opts
 * @param {'keep'|'remove'} [opts.certificates] Default 'keep'
 * @param {string} [opts.backupDir]
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<Object>}
 */
export async function purge({
  dataDir = getDataDir(),
  certificates = 'keep',
  backupDir = defaultBackupDir(),
  log = () => {},
  deps = {},
} = {}) {
  const service = deps.service ?? (await import('./service/index.js'));
  const config = deps.config ?? loadConfig();
  const source = (deps.detectInstallSource ?? detectInstallSource)();

  // 1. The backup. Nothing is removed if this fails.
  log('Exporting a backup of the data directory...');
  const backup = (deps.exportBackup ?? exportBackup)({ dataDir, into: backupDir, log });
  if (!backup.ok) {
    return {
      ok: false,
      step: 'backup',
      reason: backup.reason,
      untouched: true,
      hint: 'Nothing was removed. Fix the backup location, or pass --backup-dir, and try again.',
    };
  }

  const removed = [];
  const failed = [];

  // 2. The service. Attempted before the files it points at are deleted, so
  // the service manager is not left with an entry for a missing binary.
  log('Removing the background service...');
  let uninstalled = { ok: true, notes: ['no service was installed'] };
  try {
    uninstalled = await service.uninstall({ keepServerDataLocation: true, removeLegacy: true, log });
  } catch (err) {
    uninstalled = { ok: false, reason: err.message };
  }

  if (uninstalled.ok) {
    removed.push({ what: 'the background service', detail: uninstalled.mechanism ?? 'none' });
  } else {
    failed.push({
      what: 'the background service',
      reason: uninstalled.reason,
      needsElevation: uninstalled.needsElevation ?? false,
    });
  }

  // 3. The pinned runtime. On Linux this is a symlink and its TARGET is a real
  // Node installation that must not be touched: only the link goes.
  const runtimeTarget = isWindows ? runtimeDir(dataDir) : null;
  if (!isWindows) {
    const link = inspectLink(dataDir);
    if (link.exists) {
      try {
        fs.rmSync(link.link, { force: true });
        removed.push({ what: 'the runtime link', detail: `${link.link} (its target was left alone)` });
      } catch (err) {
        failed.push({ what: 'the runtime link', reason: err.message });
      }
    }
  } else if (runtimeTarget && fs.existsSync(runtimeTarget)) {
    try {
      fs.rmSync(runtimeTarget, { recursive: true, force: true });
      removed.push({ what: 'the pinned runtime', detail: runtimeTarget });
    } catch (err) {
      failed.push({
        what: 'the pinned runtime',
        reason: `${err.message} (removing it under ProgramData needs an Administrator terminal)`,
      });
    }
  }

  // 4. The certificates, only if asked.
  if (certificates === 'remove' && config.sslDir) {
    if (fs.existsSync(config.sslDir)) {
      try {
        fs.rmSync(config.sslDir, { recursive: true, force: true });
        removed.push({ what: 'the certificates', detail: config.sslDir });
      } catch (err) {
        failed.push({ what: 'the certificates', reason: err.message });
      }
    }
  }

  // 5. The data directory, last: every step above reads from it.
  //
  // The database handle is closed first (on Windows an open file cannot be
  // removed) and deliberately NOT reopened afterwards: initDb() would recreate
  // the directory that was just deleted, which is the one thing a purge must
  // not do. It IS reopened when the removal failed, so a failed purge leaves a
  // working process rather than one that throws on its next read.
  log('Removing the data directory...');
  closeDb();
  let databaseClosed = true;
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
    removed.push({ what: 'the data directory', detail: dataDir });
  } catch (err) {
    failed.push({ what: 'the data directory', reason: err.message });
    initDb();
    databaseClosed = false;
  }

  // The machine-wide directory in Server mode, which is a second location.
  if (isWindows) {
    const machine = programDataDir();
    if (fs.existsSync(machine) && path.resolve(machine) !== path.resolve(dataDir)) {
      try {
        fs.rmSync(machine, { recursive: true, force: true });
        removed.push({ what: 'the machine-wide data directory', detail: machine });
      } catch (err) {
        failed.push({
          what: 'the machine-wide data directory',
          reason: `${err.message} (needs an Administrator terminal)`,
        });
      }
    }
  }

  return {
    ok: failed.length === 0,
    step: 'done',
    backup,
    removed,
    failed,
    // The caller is expected to exit after this: the data directory is gone
    // and nothing in this process can read or write settings any more.
    databaseClosed,
    kept: plan({ dataDir, certificates, config }).keeps,
    // The package itself cannot remove the package: npm would be deleting the
    // files it is running from. So the last step is the user's.
    finalCommand: source.kind === 'clone'
      ? `rm -rf ${source.root}      # this clone; nothing was installed globally`
      : `npm uninstall -g ${PACKAGE}`,
    installSource: source,
  };
}
