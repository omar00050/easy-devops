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
import {
  describeManagedCertificates,
  removeManagedCertificateArtifacts,
  pathIsInside,
} from './ssl/managed-artifacts.js';
import {
  acquireArtifactLock,
  SSL_ARTIFACT_LIFECYCLE_LOCK,
} from './ssl/artifact-lock.js';
import { retireLegacyDeployLogs } from './deploy/logRetirement.js';

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
  if (!fs.existsSync(dataDir)) {
    return { ok: false, reason: `there is no data directory at ${dataDir}` };
  }

  let dest;
  try {
    fs.mkdirSync(into, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(into, 0o700);
    const base = backupName(now);
    for (let suffix = 1; suffix < 10_000; suffix += 1) {
      const candidate = path.join(into, suffix === 1 ? base : `${base}-${suffix}`);
      if (pathIsInside(dataDir, candidate)) {
        return {
          ok: false,
          reason: `the backup destination ${candidate} is inside the data directory`,
        };
      }
      try {
        fs.mkdirSync(candidate, { recursive: false, mode: 0o700 });
        if (process.platform !== 'win32') fs.chmodSync(candidate, 0o700);
        dest = candidate;
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
    }
    if (!dest) throw new Error('could not reserve a unique backup directory');
  } catch (error) {
    return { ok: false, reason: `could not create the backup directory: ${error.message}` };
  }

  const config = safeConfig();

  closeDb();
  try {
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

function containmentPath(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

function pathsOverlap(parent, child) {
  const realParent = containmentPath(parent);
  const realChild = containmentPath(child);
  return pathIsInside(parent, child)
    || pathIsInside(child, parent)
    || pathIsInside(realParent, realChild)
    || pathIsInside(realChild, realParent);
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
    const certificatePlan = describeManagedCertificates({
      dataDir,
      configuredSslDir: config.sslDir ?? null,
    });
    for (const root of certificatePlan.roots) {
      removes.push({ what: 'managed certificate files and keys', path: root });
    }
    for (const root of certificatePlan.unmanaged) {
      keeps.push({ what: 'unmanaged certificates and keys', path: root });
    }
    for (const root of certificatePlan.refused ?? []) {
      keeps.push({ what: 'unsafe or unrecognized certificates and keys', path: root.path });
    }
    if (certificatePlan.roots.length) {
      keeps.push({
        what: 'unmanaged certificate files and unrelated content in managed roots',
        path: certificatePlan.roots.join(', '),
      });
    }
    if (!certificatePlan.ok) {
      keeps.push({
        what: 'certificates that could not be verified against the managed-certificate manifest',
        path: certificatePlan.manifestPath,
      });
    }
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
export async function purge(options = {}) {
  const dataDir = options.dataDir ?? getDataDir();
  if (!fs.existsSync(dataDir)) return purgeUnlocked({ ...options, dataDir });
  const purgeLock = await acquireArtifactLock({
    dataDir,
    key: 'easy-devops-purge',
    timeoutMs: 10_000,
  });
  let lifecycleLock = null;
  try {
    lifecycleLock = await acquireArtifactLock({
      dataDir,
      key: SSL_ARTIFACT_LIFECYCLE_LOCK,
      timeoutMs: 60_000,
    });
    return await purgeUnlocked({ ...options, dataDir });
  } finally {
    lifecycleLock?.release();
    purgeLock.release();
  }
}

async function purgeUnlocked({
  dataDir = getDataDir(),
  certificates = 'keep',
  backupDir = defaultBackupDir(),
  log = () => {},
  deps = {},
} = {}) {
  const service = deps.service ?? (await import('./service/index.js'));
  const config = deps.config ?? loadConfig();
  const source = (deps.detectInstallSource ?? detectInstallSource)();

  // A backup copies the whole data directory. Refuse before that copy if an
  // existing configuration or ownership manifest places private-key material
  // inside it. Managed cleanup later cannot repair a backup that already
  // contains that material.
  if (certificates === 'remove') {
    const certificatePlan = describeManagedCertificates({
      dataDir,
      configuredSslDir: config.sslDir ?? null,
    });
    const roots = [
      config.sslDir,
      ...(certificatePlan.roots ?? []).map((entry) => entry.path),
      ...(certificatePlan.refused ?? []).map((entry) => entry.path),
      ...(certificatePlan.unmanaged ?? []),
    ].filter(Boolean);
    const overlap = roots.find((root) => pathsOverlap(dataDir, root));
    if (overlap) {
      return {
        ok: false,
        step: 'certificate-preflight',
        reason: `The certificate root ${overlap} overlaps the Easy DevOps data directory. Move it outside the data directory before removing certificates or creating a backup.`,
        untouched: true,
        hint: 'Nothing was backed up or removed. Change sslDir in Settings, then run the purge again.',
        certificatePlan,
      };
    }
  }

  // A backup must never preserve a pre-1.4.5 raw deployment log. This runs
  // before exportBackup, and an active deployment blocks the purge instead of
  // producing a backup whose safety cannot be proven.
  log('Retiring unsafe legacy deployment logs...');
  let logRetirement;
  try {
    logRetirement = (deps.retireLegacyDeployLogs ?? retireLegacyDeployLogs)({ dataDir });
  } catch (error) {
    logRetirement = { ok: false, errors: [{ reason: error.message }], activeApps: [] };
  }
  if (!logRetirement.ok || logRetirement.activeApps.length > 0) {
    const active = logRetirement.activeApps.length > 0
      ? ` Active deployment(s): ${logRetirement.activeApps.join(', ')}.`
      : '';
    const detail = logRetirement.errors?.map((entry) => entry.reason).filter(Boolean).join('; ');
    return {
      ok: false,
      step: 'log-security',
      reason: `Unsafe legacy deployment logs could not be retired.${active}${detail ? ` ${detail}` : ''}`,
      untouched: true,
      hint: 'Wait for active deployments to finish, fix the reported file error, and retry the purge.',
      logRetirement,
    };
  }

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

  const finalKeeps = plan({ dataDir, certificates, config }).keeps;
  const removed = [];
  const failed = [];
  let certificateCleanup = null;

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

  // 4. The certificates, only if asked. This deletes manifest-owned files and
  // empty recorded directories one by one. It never recursively removes sslDir.
  if (certificates === 'remove') {
    certificateCleanup = await removeManagedCertificateArtifacts({
      dataDir,
      unmanagedSslDir: config.sslDir ?? null,
    });
    for (const file of certificateCleanup.removedFiles) {
      removed.push({ what: 'managed certificate file', detail: file });
    }
    for (const directory of certificateCleanup.removedDirectories) {
      removed.push({ what: 'managed certificate directory', detail: directory });
    }
    for (const error of certificateCleanup.errors) {
      failed.push({ what: 'managed certificate cleanup', reason: `${error.path}: ${error.reason}` });
    }
    if (!certificateCleanup.removedFiles.length && !certificateCleanup.removedDirectories.length) {
      log('No manifest-owned certificate files were found; unmanaged certificate data was kept.');
    }
  }

  // 5. The data directory, last: every step above reads from it.
  //
  // The database handle is closed first (on Windows an open file cannot be
  // removed) and deliberately NOT reopened afterwards: initDb() would recreate
  // the directory that was just deleted, which is the one thing a purge must
  // not do. It IS reopened when the removal failed, so a failed purge leaves a
  // working process rather than one that throws on its next read.
  const protectedCertificateRoots = [
    config.sslDir,
    ...(certificateCleanup?.roots?.map((entry) => entry.path) ?? []),
  ].filter(Boolean);
  const nestedCertificateRoot = protectedCertificateRoots
    .find((root) => pathsOverlap(dataDir, root));
  let databaseClosed = false;
  const certificateLedgerUnsafe = certificates === 'remove' && certificateCleanup?.ok !== true;
  if (certificateLedgerUnsafe) {
    failed.push({
      what: 'the data directory',
      reason: 'certificate cleanup did not complete safely, so the data directory and its managed-artifact manifest were kept for a safe retry',
    });
  } else if (nestedCertificateRoot) {
    failed.push({
      what: 'the data directory',
      reason: `refusing recursive deletion because it overlaps certificate data at ${nestedCertificateRoot}; move sslDir outside the Easy DevOps data directory and retry`,
    });
  } else {
    log('Removing the data directory...');
    closeDb();
    databaseClosed = true;
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
      removed.push({ what: 'the data directory', detail: dataDir });
    } catch (err) {
      failed.push({ what: 'the data directory', reason: err.message });
      initDb();
      databaseClosed = false;
    }
  }

  // The machine-wide directory in Server mode, which is a second location.
  if (isWindows) {
    const machine = programDataDir();
    if (fs.existsSync(machine) && path.resolve(machine) !== path.resolve(dataDir)) {
      const nestedMachineCertificateRoot = protectedCertificateRoots
        .find((root) => pathsOverlap(machine, root));
      if (certificateLedgerUnsafe) {
        failed.push({
          what: 'the machine-wide data directory',
          reason: 'certificate cleanup did not complete safely, so the machine-wide data directory and its managed-artifact manifest were kept for a safe retry',
        });
      } else if (nestedMachineCertificateRoot) {
        failed.push({
          what: 'the machine-wide data directory',
          reason: `refusing recursive deletion because it overlaps certificate data at ${nestedMachineCertificateRoot}`,
        });
      } else {
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
  }

  return {
    ok: failed.length === 0,
    step: 'done',
    backup,
    removed,
    failed,
    certificateCleanup,
    // The caller is expected to exit after this: the data directory is gone
    // and nothing in this process can read or write settings any more.
    databaseClosed,
    kept: finalKeeps,
    // The package itself cannot remove the package: npm would be deleting the
    // files it is running from. So the last step is the user's.
    finalCommand: source.kind === 'clone'
      ? `rm -rf ${source.root}      # this clone; nothing was installed globally`
      : `npm uninstall -g ${PACKAGE}`,
    installSource: source,
  };
}
