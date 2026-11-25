/**
 * Tests for `ezz uninstall --purge`.
 *
 * Run with:  npm run test:e2e -- purge
 *
 * Plain Node, no framework — the constitution forbids adding one here.
 *
 * The ordering is the feature, so it is what is asserted: the backup exists
 * and contains the database BEFORE anything is removed, and a failed backup
 * removes nothing at all. Everything else — nginx, the sites, the
 * certificates — has to survive, and the certificates are the only part the
 * caller can choose to remove.
 *
 * The service is driven through an injected stub, never the real one: this
 * suite must not touch a real systemd unit, a real Windows service or a real
 * Startup folder. The assertions are on what the stub was asked to do.
 */

import './lib/guard.mjs';
import { TEST_DATA_DIR, assertInsideTestDataDir } from './lib/guard.mjs';

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const results = [];
let group = '';
function setGroup(g) { group = g; process.stdout.write(`\n-- ${g}\n`); }
function check(label, passed, detail = '') {
  results.push({ group, label, passed, detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}

const srcUrl = (rel) => pathToFileURL(path.join(ROOT, 'src', rel)).href;

function scratch(name) {
  const dir = path.join(TEST_DATA_DIR, 'scratch', name);
  assertInsideTestDataDir(dir, `create the scratch dir ${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function seed(target, contents = 'x') {
  assertInsideTestDataDir(target, `seed ${target}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}

function rawManifest(dataDir, root, {
  files = [],
  directories = [],
  rootCreated = false,
  version = 2,
} = {}) {
  const target = path.join(dataDir, 'ssl-managed-artifacts.json');
  assertInsideTestDataDir(target, 'write a synthetic managed-certificate manifest');
  const records = version === 1 ? files : files.map((relative) => {
    const absolute = path.join(root, ...relative.split('/'));
    let data = Buffer.from('');
    let stat;
    try {
      data = fs.readFileSync(absolute);
      stat = fs.lstatSync(absolute);
    } catch {
      stat = { size: 0, dev: 0, ino: 0 };
    }
    return {
      path: relative,
      sha256: crypto.createHash('sha256').update(data).digest('hex'),
      size: stat.size,
      dev: String(stat.dev),
      ino: String(stat.ino),
    };
  });
  fs.writeFileSync(target, `${JSON.stringify({
    version,
    roots: [{ sslDir: root, rootCreated, files: records, directories }],
  }, null, 2)}\n`, { mode: 0o600 });
  return target;
}

function directoryLink(target, link) {
  assertInsideTestDataDir(target, 'create a link target');
  assertInsideTestDataDir(link, 'create a test directory link');
  fs.mkdirSync(target, { recursive: true });
  if (fs.existsSync(link)) {
    const stat = fs.lstatSync(link);
    if (!stat.isDirectory() || fs.readdirSync(link).length) {
      throw new Error(`Refusing to replace non-empty test path ${link}`);
    }
    fs.rmdirSync(link);
  }
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

/**
 * A data directory that looks like a real installation, plus the nginx and
 * certificate directories that must survive.
 */
function installation(name) {
  const dataDir = scratch(`${name}-data`);
  const nginxDir = scratch(`${name}-nginx`);
  const sslDir = scratch(`${name}-ssl`);

  seed(path.join(dataDir, 'easy-devops.sqlite'), 'SQLite format 3\u0000the-domains-and-the-pairing');
  seed(path.join(dataDir, 'logs', 'dashboard.log'), 'log lines');
  seed(path.join(nginxDir, 'conf.d', 'example.com.conf'), 'server { listen 443 ssl; }');
  seed(path.join(sslDir, 'example.com', 'fullchain.pem'), 'cert');
  seed(path.join(sslDir, 'example.com', 'privkey.pem'), 'key');

  return { dataDir, nginxDir, sslDir, config: { nginxDir, sslDir, dashboardPort: 6443 } };
}

/** A service stub that records what it was asked to do. */
function serviceStub({ uninstallOk = true, reason = '' } = {}) {
  const calls = [];
  return {
    calls,
    async uninstall(opts) {
      calls.push({ call: 'uninstall', opts });
      return uninstallOk
        ? { ok: true, mechanism: 'stub', mode: 'personal', notes: [] }
        : { ok: false, reason, needsElevation: false };
    },
  };
}

// ─── 1. The backup comes first ───────────────────────────────────────────────

async function testBackupFirst() {
  setGroup('1. the backup is written before anything is removed');

  const purgeCore = await import(srcUrl('core/purge.js'));
  const { dataDir, nginxDir, sslDir, config } = installation('purge-order');
  const backupDir = scratch('purge-order-backups');

  // The data directory is removed last, so by the time the service stub is
  // called the backup must already be complete. Asserted by reading it from
  // inside the stub, which runs before any removal.
  let backupSeenByService = null;
  const service = {
    calls: [],
    async uninstall(opts) {
      this.calls.push(opts);
      const dirs = fs.readdirSync(backupDir);
      const name = dirs[0];
      backupSeenByService = name
        ? {
          name,
          hasDb: fs.existsSync(path.join(backupDir, name, 'data', 'easy-devops.sqlite')),
          hasManifest: fs.existsSync(path.join(backupDir, name, 'MANIFEST.txt')),
        }
        : null;
      return { ok: true, mechanism: 'stub', mode: 'personal', notes: [] };
    },
  };

  const result = await purgeCore.purge({
    dataDir,
    certificates: 'keep',
    backupDir,
    deps: { service, config },
  });

  check('the purge succeeds', result.ok === true,
    result.failed?.map((f) => `${f.what}: ${f.reason}`).join('; ') ?? '');

  check('the backup already existed when the service was removed',
    Boolean(backupSeenByService), JSON.stringify(backupSeenByService));
  check('and it already contained the database',
    backupSeenByService?.hasDb === true);
  check('and its manifest', backupSeenByService?.hasManifest === true);

  check('the backup path is reported', typeof result.backup.path === 'string'
    && fs.existsSync(result.backup.path), result.backup.path);
  check('the database in the backup is readable and intact',
    fs.readFileSync(path.join(result.backup.path, 'data', 'easy-devops.sqlite'), 'utf8')
      .includes('the-domains-and-the-pairing'));

  // What must be gone, and what must not.
  check('the data directory is gone', !fs.existsSync(dataDir));
  check('nginx configuration survives', fs.existsSync(path.join(nginxDir, 'conf.d', 'example.com.conf')));
  check('the certificates survive by default',
    fs.existsSync(path.join(sslDir, 'example.com', 'privkey.pem')));

  check('the service was asked to uninstall itself', service.calls.length === 1);
  check('keeping the server data location, so nothing is moved on the way out',
    service.calls[0]?.keepServerDataLocation === true);

  // The last step belongs to the user: npm cannot delete what it is running.
  check('the final command is printed', /npm uninstall -g easy-devops|rm -rf/.test(result.finalCommand),
    result.finalCommand);

  // And the manifest explains how to get back.
  const manifest = fs.readFileSync(path.join(result.backup.path, 'MANIFEST.txt'), 'utf8');
  check('the manifest says how to restore', /Restoring/.test(manifest) && /service install/.test(manifest));
  check('and names what was NOT copied', /nginx configuration/.test(manifest) && /certificates/.test(manifest));
  check('the manifest is ASCII-only, it is read in a terminal',
    [...manifest].every((c) => c.charCodeAt(0) <= 126),
    [...manifest].filter((c) => c.charCodeAt(0) > 126).join(' '));

  // A backup is a file a user may copy around: it must not contain the
  // password hash in a config summary. (The database copy is the database;
  // the manifest is the part we write.)
  check('the manifest carries no password hash', !/scrypt\$/.test(manifest));

  // A successful purge deliberately leaves the database closed: reopening it
  // would recreate the directory that was just deleted. The CLI exits right
  // after, and this suite reopens its own handle to carry on.
  check('the database is left closed, so nothing recreates the directory',
    result.databaseClosed === true);

  const { initDb } = await import(srcUrl('core/db.js'));
  initDb();
}

// ─── 2. A failed backup removes nothing ──────────────────────────────────────

async function testBackupFailureAborts() {
  setGroup('2. a failed backup aborts the whole purge');

  const purgeCore = await import(srcUrl('core/purge.js'));
  const { dataDir, nginxDir, sslDir, config } = installation('purge-nobackup');
  const service = serviceStub();

  const result = await purgeCore.purge({
    dataDir,
    certificates: 'keep',
    backupDir: scratch('purge-nobackup-dest'),
    deps: {
      service,
      config,
      // The one failure that must stop everything.
      exportBackup: () => ({ ok: false, reason: 'the destination is full' }),
    },
  });

  check('the purge refuses', result.ok === false && result.step === 'backup', result.step);
  check('and says so plainly', /full/.test(result.reason), result.reason);
  check('it reports that nothing was touched', result.untouched === true);
  check('the data directory is still there', fs.existsSync(path.join(dataDir, 'easy-devops.sqlite')));
  check('the service was never asked to uninstall', service.calls.length === 0);
  check('nginx is untouched', fs.existsSync(path.join(nginxDir, 'conf.d', 'example.com.conf')));
  check('the certificates are untouched', fs.existsSync(path.join(sslDir, 'example.com', 'privkey.pem')));
  check('and the hint says what to do next', /try again/i.test(result.hint ?? ''), result.hint);
}

// ─── 3. Certificates are an explicit choice ──────────────────────────────────

async function testCertificateChoice() {
  const { initDb } = await import(srcUrl('core/db.js'));
  initDb();

  setGroup('3. certificates: kept by default, unmanifested data is fail-safe');

  const purgeCore = await import(srcUrl('core/purge.js'));

  // Default.
  const keep = installation('purge-certs-keep');
  const keptPlan = purgeCore.plan({ dataDir: keep.dataDir, certificates: 'keep', config: keep.config });
  check('the plan lists the certificates under "keeps" by default',
    keptPlan.keeps.some((k) => k.path === keep.sslDir),
    JSON.stringify(keptPlan.keeps));
  check('and never under "removes"',
    !keptPlan.removes.some((r) => r.path === keep.sslDir));

  // Explicitly asked for.
  const remove = installation('purge-certs-remove');
  const removePlan = purgeCore.plan({ dataDir: remove.dataDir, certificates: 'remove', config: remove.config });
  check('asking for removal does not claim the configured root itself will be deleted',
    !removePlan.removes.some((r) => r.path === remove.sslDir),
    JSON.stringify(removePlan.removes));
  check('the plan reports unmanifested certificates as kept',
    removePlan.keeps.some((r) => r.path === remove.sslDir && /unmanaged/.test(r.what)),
    JSON.stringify(removePlan.keeps));

  const result = await purgeCore.purge({
    dataDir: remove.dataDir,
    certificates: 'remove',
    backupDir: scratch('purge-certs-remove-dest'),
    deps: { service: serviceStub(), config: remove.config },
  });

  check('without a manifest the certificates are still present', fs.existsSync(remove.sslDir));
  check('the unmanifested certificate is reported as kept',
    result.certificateCleanup?.kept.includes(path.join(remove.sslDir, 'example.com', 'fullchain.pem')),
    JSON.stringify(result.certificateCleanup));
  check('the unmanifested private key is reported as kept',
    result.certificateCleanup?.kept.includes(path.join(remove.sslDir, 'example.com', 'privkey.pem')),
    JSON.stringify(result.certificateCleanup));
  check('while nginx still is not', fs.existsSync(path.join(remove.nginxDir, 'conf.d', 'example.com.conf')));

  // The plan and purge still agree on the data directory.
  check('the plan and the purge agree on the data directory',
    removePlan.removes.some((r) => r.path === remove.dataDir)
    && result.removed.some((r) => r.detail === remove.dataDir),
    JSON.stringify(result.removed));
}

// ─── 4. Only manifest-owned paths are deleted ───────────────────────────────

async function testManagedArtifactsOnly() {
  const { initDb } = await import(srcUrl('core/db.js'));
  initDb();

  setGroup('4. purge deletes only managed artifacts and preserves unrelated content');

  const purgeCore = await import(srcUrl('core/purge.js'));
  const managed = await import(srcUrl('core/ssl/managed-artifacts.js'));
  const { dataDir, nginxDir, sslDir, config } = installation('purge-managed-only');

  const unrelatedRoot = seed(path.join(sslDir, 'README.txt'), 'not Easy DevOps data');
  const unrelatedDomain = seed(path.join(sslDir, 'example.com', 'notes.txt'), 'operator notes');
  const unmanagedCert = seed(path.join(sslDir, 'other.example', 'fullchain.pem'), 'other cert');

  await managed.recordManagedArtifacts({
    dataDir,
    sslDir,
    directories: ['example.com'],
    files: ['example.com/fullchain.pem', 'example.com/privkey.pem'],
  });
  // Exercise an exclusive temporary plus atomic replacement of an existing
  // manifest, not only creation of the first one.
  await managed.recordManagedArtifacts({
    dataDir,
    sslDir,
    directories: ['example.com'],
    files: ['example.com/fullchain.pem', 'example.com/privkey.pem'],
  });

  const manifestPath = managed.managedManifestPath(dataDir);
  const manifestStat = fs.statSync(manifestPath);
  const storedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  check('the manifest is versioned and records the canonical sslDir',
    storedManifest.version === 2
      && storedManifest.roots?.[0]?.sslDir === fs.realpathSync.native(sslDir),
    JSON.stringify(storedManifest));
  check('the manifest records exact files and the domain directory',
    storedManifest.roots?.[0]?.files?.some((file) => file.path === 'example.com/fullchain.pem')
      && storedManifest.roots?.[0]?.files?.some((file) => file.path === 'example.com/privkey.pem')
      && storedManifest.roots?.[0]?.directories?.includes('example.com'),
    JSON.stringify(storedManifest.roots?.[0]));
  check('every managed file records a SHA-256, size and inode identity',
    storedManifest.roots?.[0]?.files?.every((file) =>
      /^[0-9a-f]{64}$/.test(file.sha256)
      && Number.isSafeInteger(file.size)
      && String(file.dev).length > 0
      && String(file.ino).length > 0));
  if (process.platform === 'win32') {
    check('the managed-certificate manifest is a regular file', manifestStat.isFile(), manifestPath);
  } else {
    check('the managed-certificate manifest is mode 0600',
      (manifestStat.mode & 0o777) === 0o600, (manifestStat.mode & 0o777).toString(8));
  }
  check('the lock and exclusive temporary file were cleaned up',
    fs.readdirSync(dataDir).filter((name) => name.includes('.lock') || name.endsWith('.tmp')).length === 0,
    fs.readdirSync(dataDir).join(', '));

  const removalPlan = purgeCore.plan({ dataDir, certificates: 'remove', config });
  check('the plan names managed certificate files rather than a whole root',
    removalPlan.removes.some((entry) => entry.what === 'managed certificate files and keys'
      && entry.path === sslDir),
    JSON.stringify(removalPlan.removes));

  const result = await purgeCore.purge({
    dataDir,
    certificates: 'remove',
    backupDir: scratch('purge-managed-only-dest'),
    deps: { service: serviceStub(), config },
  });

  check('the purge succeeds', result.ok === true,
    result.failed?.map((entry) => `${entry.what}: ${entry.reason}`).join('; '));
  check('the manifest-owned certificate is removed',
    !fs.existsSync(path.join(sslDir, 'example.com', 'fullchain.pem')));
  check('the manifest-owned key is removed',
    !fs.existsSync(path.join(sslDir, 'example.com', 'privkey.pem')));
  check('an unrelated root file survives', fs.existsSync(unrelatedRoot));
  check('an unrelated domain file survives', fs.existsSync(unrelatedDomain));
  check('an unmanifested certificate survives', fs.existsSync(unmanagedCert));
  check('the non-empty domain directory survives', fs.existsSync(path.join(sslDir, 'example.com')));
  check('nginx still survives', fs.existsSync(path.join(nginxDir, 'conf.d', 'example.com.conf')));
  check('the result reports the unmanifested certificate',
    result.certificateCleanup?.kept.includes(unmanagedCert),
    JSON.stringify(result.certificateCleanup?.kept));
  check('the manifest is included in the backup before dataDir is removed',
    fs.existsSync(path.join(result.backup.path, 'data', 'ssl-managed-artifacts.json')));
}

// ─── 5. Certificate lifecycle operations share one cross-process lock ───────

async function testCertificateLifecycleExclusion() {
  const { initDb } = await import(srcUrl('core/db.js'));
  initDb();
  setGroup('5. certificate issuance, deletion and purge share one lifecycle lock');

  const purgeCore = await import(srcUrl('core/purge.js'));
  const configModule = await import(srcUrl('core/config.js'));
  const locks = await import(srcUrl('core/ssl/artifact-lock.js'));
  const issuer = await import(srcUrl('core/ssl-issuer.js'));
  const { dataDir, config } = installation('purge-lifecycle');

  const heldForPurge = await locks.acquireArtifactLock({
    dataDir,
    key: locks.SSL_ARTIFACT_LIFECYCLE_LOCK,
    timeoutMs: 2_000,
  });
  let purgeSettled = false;
  const pendingPurge = purgeCore.purge({
    dataDir,
    certificates: 'keep',
    backupDir: scratch('purge-lifecycle-backup'),
    deps: {
      service: serviceStub(),
      config,
      exportBackup: () => ({ ok: false, reason: 'stop after lock exclusion' }),
    },
  }).finally(() => { purgeSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 120));
  const purgeWaited = purgeSettled === false;
  heldForPurge.release();
  const purgeResult = await pendingPurge;
  check('purge waits for the shared certificate lifecycle lock',
    purgeWaited && purgeResult.step === 'backup',
    JSON.stringify({ purgeWaited, step: purgeResult.step }));

  const savedConfig = configModule.loadConfig();
  configModule.saveConfig({
    ...savedConfig,
    sslDir: config.sslDir,
    nginxDir: config.nginxDir,
    acmeEmail: '',
  });
  const heldForIssue = await locks.acquireArtifactLock({
    dataDir: TEST_DATA_DIR,
    key: locks.SSL_ARTIFACT_LIFECYCLE_LOCK,
    timeoutMs: 2_000,
  });
  let issueSettled = false;
  const pendingIssue = issuer.issueCertificate('lifecycle.example.com')
    .finally(() => { issueSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 120));
  const issueWaited = issueSettled === false;
  heldForIssue.release();
  const issueResult = await pendingIssue;
  configModule.saveConfig(savedConfig);
  check('issuance waits for the same lock before any ACME or filesystem work',
    issueWaited
      && issueResult.success === false
      && issueResult.error?.step === 'email configuration',
    JSON.stringify({
      issueWaited,
      step: issueResult.error?.step ?? null,
    }));
}

// ─── 5. Account keys and metadata require an explicit record ────────────────

async function testAccountAndMetadataRecords() {
  const { initDb } = await import(srcUrl('core/db.js'));
  initDb();

  setGroup('5. account keys and certificate metadata are managed only when recorded');

  const purgeCore = await import(srcUrl('core/purge.js'));
  const managed = await import(srcUrl('core/ssl/managed-artifacts.js'));
  const { dataDir, sslDir, config } = installation('purge-exact-artifacts');

  const accountKey = seed(path.join(sslDir, '.account', 'account.key'), 'account key');
  const unmanagedKey = seed(path.join(sslDir, 'example.com', 'privkey.pem'), 'key');
  const unmanagedMeta = seed(path.join(sslDir, 'example.com', 'ez-cert.json'), '{}');
  const managedMeta = seed(path.join(sslDir, 'meta.example', 'ez-cert.json'), '{}');
  seed(path.join(sslDir, 'meta.example', 'fullchain.pem'), 'unrecorded cert');

  await managed.recordManagedArtifacts({
    dataDir,
    sslDir,
    directories: ['.account'],
    files: ['example.com/fullchain.pem', '.account/account.key', 'meta.example/ez-cert.json'],
  });

  const result = await purgeCore.purge({
    dataDir,
    certificates: 'remove',
    backupDir: scratch('purge-exact-artifacts-dest'),
    deps: { service: serviceStub(), config },
  });

  check('the purge succeeds', result.ok === true,
    result.failed?.map((entry) => `${entry.what}: ${entry.reason}`).join('; '));
  check('the recorded account key is removed', !fs.existsSync(accountKey));
  check('its now-empty recorded account directory is removed',
    !fs.existsSync(path.dirname(accountKey)));
  check('an unrecorded private key survives', fs.existsSync(unmanagedKey));
  check('unrecorded certificate metadata survives', fs.existsSync(unmanagedMeta));
  check('recorded certificate metadata is removed', !fs.existsSync(managedMeta));

  initDb();
  const createdRoot = installation('purge-created-root');
  await managed.recordManagedArtifacts({
    dataDir: createdRoot.dataDir,
    sslDir: createdRoot.sslDir,
    rootCreated: true,
    directories: ['example.com'],
    files: ['example.com/fullchain.pem', 'example.com/privkey.pem'],
  });
  const emptyRootResult = await purgeCore.purge({
    dataDir: createdRoot.dataDir,
    certificates: 'remove',
    backupDir: scratch('purge-created-root-dest'),
    deps: { service: serviceStub(), config: createdRoot.config },
  });
  check('a recorded, now-empty managed root is removed without recursive deletion',
    emptyRootResult.ok === true && !fs.existsSync(createdRoot.sslDir),
    JSON.stringify(emptyRootResult.failed));
  check('the root removal is reported path by path',
    emptyRootResult.certificateCleanup?.removedDirectories.includes(createdRoot.sslDir),
    JSON.stringify(emptyRootResult.certificateCleanup?.removedDirectories));
}

// ─── 6. Linked and system roots are refused ─────────────────────────────────

async function testUnsafeRoots() {
  const { initDb } = await import(srcUrl('core/db.js'));
  initDb();

  setGroup('6. linked, reparse-point and system roots are refused');

  const purgeCore = await import(srcUrl('core/purge.js'));
  const managed = await import(srcUrl('core/ssl/managed-artifacts.js'));

  const linked = installation('purge-linked-root');
  const link = scratch('purge-linked-root-alias');
  directoryLink(linked.sslDir, link);
  rawManifest(linked.dataDir, link, {
    files: ['example.com/fullchain.pem', 'example.com/privkey.pem'],
  });
  const linkedConfig = { ...linked.config, sslDir: link };
  const linkedPlan = purgeCore.plan({
    dataDir: linked.dataDir,
    certificates: 'remove',
    config: linkedConfig,
  });
  check('the plan refuses to promise deletion through a linked root',
    !linkedPlan.removes.some((entry) => entry.path === link)
      && linkedPlan.keeps.some((entry) => entry.path === link && /unsafe/.test(entry.what)),
    JSON.stringify(linkedPlan));
  const linkedResult = await purgeCore.purge({
    dataDir: linked.dataDir,
    certificates: 'remove',
    backupDir: scratch('purge-linked-root-dest'),
    deps: { service: serviceStub(), config: linkedConfig },
  });

  check('a linked root makes certificate cleanup fail safely', linkedResult.ok === false);
  check('the link itself is preserved', fs.lstatSync(link).isSymbolicLink());
  check('the target certificate is preserved',
    fs.existsSync(path.join(linked.sslDir, 'example.com', 'fullchain.pem')));

  initDb();
  const parent = installation('purge-linked-artifact');
  const external = scratch('purge-linked-artifact-target');
  const externalCert = seed(path.join(external, 'fullchain.pem'), 'external cert');
  directoryLink(external, path.join(parent.sslDir, 'linked.example'));
  rawManifest(parent.dataDir, parent.sslDir, {
    files: ['linked.example/fullchain.pem'],
    directories: ['linked.example'],
  });
  const artifactResult = await purgeCore.purge({
    dataDir: parent.dataDir,
    certificates: 'remove',
    backupDir: scratch('purge-linked-artifact-dest'),
    deps: { service: serviceStub(), config: parent.config },
  });

  check('a linked managed directory makes cleanup fail safely', artifactResult.ok === false);
  check('the linked directory remains a link',
    fs.lstatSync(path.join(parent.sslDir, 'linked.example')).isSymbolicLink());
  check('the file behind the linked directory is preserved', fs.existsSync(externalCert));

  initDb();
  const system = installation('purge-system-root');
  const filesystemRoot = path.parse(TEST_DATA_DIR).root;
  rawManifest(system.dataDir, filesystemRoot, { files: ['example.com/fullchain.pem'] });
  const systemResult = await purgeCore.purge({
    dataDir: system.dataDir,
    certificates: 'remove',
    backupDir: scratch('purge-system-root-dest'),
    deps: {
      service: serviceStub(),
      config: { ...system.config, sslDir: filesystemRoot },
    },
  });

  check('a manifest naming a filesystem root is refused',
    systemResult.ok === false
      && systemResult.step === 'certificate-preflight'
      && systemResult.untouched === true,
    JSON.stringify({
      step: systemResult.step,
      reason: systemResult.reason,
      untouched: systemResult.untouched,
    }));
  check('the configured certificate root itself is never passed to recursive rm',
    systemResult.removed === undefined && systemResult.untouched === true,
    JSON.stringify(systemResult.removed));

  initDb();
  const unknown = installation('purge-unknown-artifact');
  const unrelated = seed(path.join(unknown.sslDir, 'example.com', 'notes.txt'), 'operator notes');
  rawManifest(unknown.dataDir, unknown.sslDir, { files: ['example.com/notes.txt'] });
  const unknownResult = await purgeCore.purge({
    dataDir: unknown.dataDir,
    certificates: 'remove',
    backupDir: scratch('purge-unknown-artifact-dest'),
    deps: { service: serviceStub(), config: unknown.config },
  });
  check('an unknown file listed in the manifest makes cleanup fail safely',
    unknownResult.ok === false
      && unknownResult.certificateCleanup?.errors.some((entry) => /not a known managed certificate file/i.test(entry.reason)),
    JSON.stringify(unknownResult.certificateCleanup?.errors));
  check('the unknown file is never deleted', fs.existsSync(unrelated));

  let recordRefused = false;
  try {
    await managed.recordManagedArtifacts({
      dataDir: scratch('purge-system-record-data'),
      sslDir: filesystemRoot,
    });
  } catch (error) {
    recordRefused = /filesystem root|system directory/.test(error.message);
  }
  check('issuance cannot record a filesystem root as managed', recordRefused);
}

// ─── 7. Manifest identities, ownership and stale plans ─────────────────────

async function testManifestTransactionSafety() {
  const { initDb } = await import(srcUrl('core/db.js'));
  initDb();

  setGroup('7. manifest identities, ownership and reload-before-delete');

  const purgeCore = await import(srcUrl('core/purge.js'));
  const managed = await import(srcUrl('core/ssl/managed-artifacts.js'));

  const legacy = installation('purge-legacy-manifest');
  rawManifest(legacy.dataDir, legacy.sslDir, {
    version: 1,
    files: ['example.com/fullchain.pem', 'example.com/privkey.pem'],
    directories: ['example.com'],
  });
  const legacyResult = await purgeCore.purge({
    dataDir: legacy.dataDir,
    certificates: 'remove',
    backupDir: scratch('purge-legacy-manifest-dest'),
    deps: { service: serviceStub(), config: legacy.config },
  });
  check('a version 1 path-only manifest fails closed',
    legacyResult.ok === false
      && legacyResult.certificateCleanup?.errors.some((entry) => /version 1/i.test(entry.reason))
      && fs.existsSync(path.join(legacy.sslDir, 'example.com', 'fullchain.pem')),
    JSON.stringify(legacyResult.certificateCleanup?.errors));

  initDb();
  const replaced = installation('purge-replaced-identity');
  await managed.recordManagedArtifacts({
    dataDir: replaced.dataDir,
    sslDir: replaced.sslDir,
    files: ['example.com/fullchain.pem', 'example.com/privkey.pem'],
  });
  const replacement = seed(path.join(replaced.sslDir, 'example.com', 'fullchain.pem'), 'replacement cert');
  const replacedResult = await purgeCore.purge({
    dataDir: replaced.dataDir,
    certificates: 'remove',
    backupDir: scratch('purge-replaced-identity-dest'),
    deps: { service: serviceStub(), config: replaced.config },
  });
  check('a replaced file is never deleted under an old manifest identity',
    replacedResult.ok === false
      && replacedResult.certificateCleanup?.errors.some((entry) => /identity changed/i.test(entry.reason))
      && fs.existsSync(replacement),
    JSON.stringify(replacedResult.certificateCleanup?.errors));
  check('a failed certificate ledger preserves the data directory and manifest for retry',
    replacedResult.failed?.some((entry) =>
      entry.what === 'the data directory' && /manifest were kept/.test(entry.reason))
      && fs.existsSync(replaced.dataDir)
      && fs.existsSync(path.join(replaced.dataDir, 'ssl-managed-artifacts.json')),
    JSON.stringify(replacedResult.failed));

  initDb();
  const staleLock = installation('purge-stale-manifest-lock');
  await managed.recordManagedArtifacts({
    dataDir: staleLock.dataDir,
    sslDir: staleLock.sslDir,
    files: ['example.com/fullchain.pem'],
  });
  const lockPath = path.join(staleLock.dataDir, '.ssl-managed-artifacts.json.lock');
  fs.writeFileSync(lockPath, `${JSON.stringify({
    version: 1,
    key: 'ssl-managed-artifacts.json',
    token: 'dead-owner',
    pid: 0x7ffffffe,
    host: os.hostname(),
    startedAt: Date.now() - 600_000,
  })}\n`, { mode: 0o600 });
  const old = new Date(Date.now() - 600_000);
  fs.utimesSync(lockPath, old, old);
  let staleRecovered = false;
  try {
    await managed.recordManagedArtifacts({
      dataDir: staleLock.dataDir,
      sslDir: staleLock.sslDir,
      files: ['example.com/fullchain.pem'],
    });
    staleRecovered = !fs.existsSync(lockPath);
  } catch { /* reported below */ }
  check('a dead lock owner with a stale heartbeat is recovered safely', staleRecovered);

  initDb();
  const reusedPidLock = installation('purge-reused-pid-manifest-lock');
  await managed.recordManagedArtifacts({
    dataDir: reusedPidLock.dataDir,
    sslDir: reusedPidLock.sslDir,
    files: ['example.com/fullchain.pem'],
  });
  const reusedLockPath = path.join(
    reusedPidLock.dataDir,
    '.ssl-managed-artifacts.json.lock',
  );
  fs.writeFileSync(reusedLockPath, `${JSON.stringify({
    version: 1,
    key: 'ssl-managed-artifacts.json',
    token: 'crashed-owner-with-reused-live-pid',
    pid: process.pid,
    host: os.hostname(),
    startedAt: Date.now() - 600_000,
  })}\n`, { mode: 0o600 });
  const reusedTime = new Date(Date.now() - 600_000);
  fs.utimesSync(reusedLockPath, reusedTime, reusedTime);
  let reusedPidRecovered = false;
  try {
    await managed.recordManagedArtifacts({
      dataDir: reusedPidLock.dataDir,
      sslDir: reusedPidLock.sslDir,
      files: ['example.com/fullchain.pem'],
    });
    reusedPidRecovered = !fs.existsSync(reusedLockPath);
  } catch { /* reported below */ }
  check('a stale artifact lock is recovered even when its PID was reused',
    reusedPidRecovered);

  initDb();
  const snapshot = installation('purge-plan-mutation');
  await managed.recordManagedArtifacts({
    dataDir: snapshot.dataDir,
    sslDir: snapshot.sslDir,
    files: ['example.com/fullchain.pem'],
    directories: ['example.com'],
  });
  const stalePlan = managed.loadManagedArtifactManifest({ dataDir: snapshot.dataDir });
  rawManifest(snapshot.dataDir, snapshot.sslDir, { files: [], directories: [] });
  const reloaded = await managed.removeManagedCertificateArtifacts({
    dataDir: snapshot.dataDir,
    loadedManifest: stalePlan,
    unmanagedSslDir: snapshot.sslDir,
  });
  check('deletion reloads the manifest under lock instead of trusting a stale plan',
    reloaded.ok === true
      && reloaded.removedFiles.length === 0
      && fs.existsSync(path.join(snapshot.sslDir, 'example.com', 'fullchain.pem')),
    JSON.stringify(reloaded));

  if (process.platform !== 'win32') {
    initDb();
    const wrongMode = installation('purge-wrong-manifest-mode');
    const pathToManifest = rawManifest(wrongMode.dataDir, wrongMode.sslDir, { files: [] });
    fs.chmodSync(pathToManifest, 0o644);
    const wrong = managed.loadManagedArtifactManifest({ dataDir: wrongMode.dataDir });
    check('a manifest readable or writable by group/other is refused',
      wrong.ok === false && /only by its owner/.test(wrong.reason), wrong.reason);
  } else {
    check('manifest owner/mode refusal is delegated to the data-directory Windows ACL', true,
      'checked by the service ACL tests');
  }
}

// ─── 8. A service that cannot be removed is reported, not hidden ─────────────

async function testServiceFailure() {
  const { initDb } = await import(srcUrl('core/db.js'));
  initDb();

  setGroup('8. a service that cannot be removed is reported');

  const purgeCore = await import(srcUrl('core/purge.js'));
  const { dataDir, config } = installation('purge-svcfail');

  const result = await purgeCore.purge({
    dataDir,
    certificates: 'keep',
    backupDir: scratch('purge-svcfail-dest'),
    deps: {
      service: serviceStub({ uninstallOk: false, reason: 'needs an Administrator terminal' }),
      config,
    },
  });

  check('the purge reports failure', result.ok === false);
  check('naming the service', result.failed.some((f) => /service/.test(f.what)),
    JSON.stringify(result.failed));
  check('with the reason', /Administrator/.test(result.failed[0]?.reason ?? ''),
    result.failed[0]?.reason);

  // The rest still happened: a half-removed install is worse than one where
  // the data is gone and one entry needs attention, and the backup exists
  // either way.
  check('the backup was still written', fs.existsSync(result.backup.path));
  check('and the data directory was still removed', !fs.existsSync(dataDir));
}

// ─── 9. The backup itself ────────────────────────────────────────────────────

async function testExportBackup() {
  const { initDb } = await import(srcUrl('core/db.js'));
  initDb();

  setGroup('9. exportBackup on its own');

  const purgeCore = await import(srcUrl('core/purge.js'));
  const { dataDir } = installation('purge-export');
  const into = scratch('purge-export-dest');

  const first = purgeCore.exportBackup({ dataDir, into });
  check('it reports where it wrote', first.ok === true && fs.existsSync(first.path), first.reason ?? '');
  check('the whole data directory is copied, logs included',
    fs.existsSync(path.join(first.path, 'data', 'logs', 'dashboard.log')));
  check('and a size is reported', first.bytes > 0, String(first.bytes));

  // Two in the same second receive distinct exclusive destinations.
  const second = purgeCore.exportBackup({ dataDir, into, now: new Date(nowOf(first.path)) });
  check('same-second backups are never overwritten',
    second.ok === true && second.path !== first.path && fs.existsSync(second.path),
    second.reason ?? second.path);

  const raceNow = new Date(new Date(nowOf(first.path)).getTime() + 1_000);
  const goFile = path.join(into, 'backup-race-go');
  const race = await raceBackupChildren({
    moduleUrl: srcUrl('core/purge.js'),
    dataDir,
    into,
    now: raceNow.toISOString(),
    readyDir: into,
    goFile,
  });
  check('concurrent cross-process backups both complete',
    race.every((entry) => entry.ok && entry.path),
    JSON.stringify(race));
  check('concurrent backups use distinct destination directories',
    new Set(race.map((entry) => entry.path)).size === 2,
    race.map((entry) => entry.path).join(', '));

  // A missing data directory is a clear refusal, not a crash.
  const missing = purgeCore.exportBackup({ dataDir: path.join(dataDir, 'nope'), into });
  check('a missing data directory is refused clearly',
    missing.ok === false && /no data directory/.test(missing.reason), missing.reason);

  check('the backup name is sortable and filename-safe',
    /^easy-devops-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(path.basename(first.path)),
    path.basename(first.path));
}

async function raceBackupChildren({ moduleUrl, dataDir, into, now, readyDir, goFile }) {
  const source = `
    import fs from 'node:fs';
    const [moduleUrl, dataDir, into, now, readyFile, goFile] = process.argv.slice(1);
    fs.writeFileSync(readyFile, String(process.pid));
    while (!fs.existsSync(goFile)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    const mod = await import(moduleUrl);
    console.log(JSON.stringify(mod.exportBackup({ dataDir, into, now: new Date(now) })));
  `;
  const children = [1, 2].map((index) => {
    const readyFile = path.join(readyDir, `backup-race-ready-${index}`);
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        '--input-type=module',
        '-e',
        source,
        moduleUrl,
        dataDir,
        into,
        now,
        readyFile,
        goFile,
      ], {
        cwd: ROOT,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) return reject(new Error(stderr.trim() || `backup child exited ${code}`));
        try { resolve(JSON.parse(stdout.trim())); } catch {
          reject(new Error(`invalid backup child output: ${stdout} ${stderr}`));
        }
      });
      child.readyFile = readyFile;
    });
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ([1, 2].every((index) =>
      fs.existsSync(path.join(readyDir, `backup-race-ready-${index}`)))) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (![1, 2].every((index) => fs.existsSync(path.join(readyDir, `backup-race-ready-${index}`)))) {
    throw new Error('backup race children did not become ready');
  }
  fs.writeFileSync(goFile, 'go');
  return Promise.all(children);
}

/** Recovers the timestamp a backup directory was named for. */
function nowOf(backupPath) {
  const stamp = path.basename(backupPath).replace('easy-devops-backup-', '');
  const [date, time] = stamp.split('T');
  return `${date}T${time.replace(/-/g, ':')}Z`;
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write('\nPurge: remove Easy DevOps, keep nginx and the sites\n');
  process.stdout.write(`data dir: ${TEST_DATA_DIR}\n`);

  await testBackupFirst();
  await testBackupFailureAborts();
  await testCertificateChoice();
  await testManagedArtifactsOnly();
  await testCertificateLifecycleExclusion();
  await testAccountAndMetadataRecords();
  await testUnsafeRoots();
  await testManifestTransactionSafety();
  await testServiceFailure();
  await testExportBackup();

  const failed = results.filter((r) => !r.passed);
  process.stdout.write(`\n${'-'.repeat(62)}\n`);
  process.stdout.write(`TOTAL ${results.length}   PASS ${results.length - failed.length}   FAIL ${failed.length}\n`);
  if (failed.length) {
    process.stdout.write('\nFailures:\n');
    for (const f of failed) process.stdout.write(`  [${f.group}] ${f.label}${f.detail ? ` - ${f.detail}` : ''}\n`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(String(e.stack || e) + '\n');
  process.exit(1);
});
