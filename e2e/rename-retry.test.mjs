/**
 * e2e/rename-retry.test.mjs
 *
 * Every rename and atomic replace in the package rides out a Windows sharing
 * denial — and an audit that says so, site by site.
 *
 * Run with:  npm run test:e2e -- rename-retry
 *
 * What this exists to prevent coming back:
 *
 *   On a Windows Server the dashboard crashed-logged
 *
 *     EPERM: operation not permitted, rename
 *     'C:\ProgramData\easy-devops\sessions\otb-....json.1705416166'
 *     -> '...\otb-....json' (errno -4048)
 *
 *   On Windows a rename over a file another process has open for a moment
 *   fails with EPERM, EBUSY or EACCES even though every reader closes its
 *   handle within microseconds. 1.4.8 fixed the session store; this suite
 *   covers the rest of the package: the deploy state files, the SSL manifest,
 *   the published certificate files, the certificate journal, the artifact
 *   lock replacement, the setup-code lock, the legacy database migration, the
 *   nginx site enable/disable renames and the deploy key.
 *
 * Two kinds of check, and both are needed:
 *
 *   1. Behavioural, per caller: the failure is injected into the *real* fs
 *      object the production code calls, so the production retry runs — not a
 *      copy of it. Two denials: the operation succeeds and the file holds the
 *      new content. Seven denials (more than the helper's five waits): the
 *      caller returns the same error it returned before, and the original
 *      file is untouched.
 *   2. A static audit of src/: every `renameSync(`, `fs.rename(`,
 *      `promises.rename(` and `copyFileSync(` call site is either the shared
 *      helper itself, a call already wrapped in `retrySharing`, or an explicit
 *      entry in ALLOWED below with a reason. An unlisted site FAILS; the table
 *      is printed so the owner can read it.
 *
 * Safety: everything happens under the throwaway EASY_DEVOPS_DATA_DIR the
 * runner set, or in a sibling folder of it. Nothing is made unwritable, no
 * real path is touched, no service or ACL command runs, and every patched fs
 * function is restored in `finally`.
 */

// MUST be the first import: ESM evaluates the static import graph before any
// line of this file runs, so only an import can act before the rest load. It
// refuses to run unless EZ_TEST and a throwaway EASY_DEVOPS_DATA_DIR are set.
import { TEST_DATA_DIR } from './lib/guard.mjs';

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const srcUrl = (rel) => pathToFileURL(path.join(ROOT, 'src', rel)).href;
const require = createRequire(import.meta.url);

// ─── Reporting ───────────────────────────────────────────────────────────────

const results = [];
let group = '';
function setGroup(g) { group = g; process.stdout.write(`\n── ${g}\n`); }
function check(label, passed, detail = '') {
  results.push({ group, label, passed: Boolean(passed), detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}

// ─── Throwaway folders ───────────────────────────────────────────────────────

let folderCounter = 0;
/** A fresh folder under this run's own temporary area. */
function tempFolder(label) {
  const dir = path.join(TEST_DATA_DIR, `${label}-${++folderCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const normalise = (p) => String(p ?? '').replaceAll('\\', '/');
/** Injection predicate: the rename's destination ends with this suffix. */
const into = (suffix) => (to) => normalise(to).toLowerCase().endsWith(normalise(suffix).toLowerCase());
/** Injection predicate: the rename's destination contains this marker. */
const has = (marker) => (to) => normalise(to).toLowerCase().includes(normalise(marker).toLowerCase());

// ─── Failure injection ───────────────────────────────────────────────────────

/**
 * A Windows sharing denial, shaped like the one the evidence shows: same code,
 * errno, syscall and message form, so a caller that inspects any of them sees
 * what it would see in production.
 */
function sharingDenial(code, syscall, from, to) {
  const error = new Error(`${code}: operation not permitted, ${syscall} '${from}' -> '${to}'`);
  error.code = code;
  error.errno = -4048;
  error.syscall = syscall;
  error.path = String(from);
  error.dest = String(to);
  return error;
}

/**
 * Makes `fs.renameSync` fail for destinations matching `match`, `times` times.
 *
 * `fs` here is the very object the production modules import (`node:fs` is
 * cached), so this exercises their real retry rather than a copy.
 *
 * @param {{ match: (to: string, from: string) => boolean, times?: number, code?: string }} options
 * @returns {{ calls: () => number, restore: () => void }}
 */
function injectSyncRename({ match, times = Infinity, code = 'EPERM' }) {
  const real = fs.renameSync;
  let calls = 0;
  fs.renameSync = function patchedRenameSync(from, to, ...rest) {
    if (match(String(to ?? ''), String(from ?? ''))) {
      calls += 1;
      if (calls <= times) throw sharingDenial(code, 'rename', from, to);
    }
    return real.call(fs, from, to, ...rest);
  };
  return {
    calls: () => calls,
    restore() { fs.renameSync = real; },
  };
}

/**
 * The async form. `fs.promises` is the same object as `node:fs/promises` in
 * this Node, so a module importing either is covered by one patch.
 */
function injectAsyncRename({ match, times = Infinity, code = 'EBUSY' }) {
  const real = fs.promises.rename;
  let calls = 0;
  fs.promises.rename = async function patchedRename(from, to) {
    if (match(String(to ?? ''), String(from ?? ''))) {
      calls += 1;
      if (calls <= times) throw sharingDenial(code, 'rename', from, to);
    }
    return real.call(fs.promises, from, to);
  };
  return {
    calls: () => calls,
    restore() { fs.promises.rename = real; },
  };
}

/** Runs `fn` with an injection in place, restoring it whatever happens. */
async function withInjection(injection, fn) {
  try {
    return await fn();
  } finally {
    injection.restore();
  }
}

async function capture(promise) {
  try {
    return { value: await promise, error: null };
  } catch (error) {
    return { value: null, error };
  }
}

/** The files directly under `dir`, so a leftover temp file is visible. */
const listing = (dir) => fs.readdirSync(dir).sort();

// ─── Modules under test (dynamic, after the guard) ───────────────────────────

const atomic = await import(srcUrl('core/atomicState.js'));
const safeFile = await import(srcUrl('core/safe-file.js'));
const managed = await import(srcUrl('core/ssl/managed-artifacts.js'));
const privateKeys = await import(srcUrl('core/ssl/private-keys.js'));
const transaction = await import(srcUrl('core/ssl/certificate-transaction.js'));
const artifactLock = await import(srcUrl('core/ssl/artifact-lock.js'));
const setupCode = await import(srcUrl('core/setupCode.js'));
const domainsDb = await import(srcUrl('core/domains-db.js'));
const { dbGet, dbSet } = await import(srcUrl('core/db.js'));
const apps = await import(srcUrl('core/deploy/apps.js'));
const store = await import(srcUrl('core/deploy/store.js'));
const deployKey = await import(srcUrl('core/deploy/deployKey.js'));

// ─── (1) The shared helper is still the one being used ──────────────────────

setGroup('(1) the shared helper the callers go through');
{
  for (const name of ['retrySharing', 'retrySharingAsync', 'renameWithRetry', 'renameWithRetryAsync', 'copyFileWithRetry']) {
    check(`atomicState exports ${name}()`, typeof atomic[name] === 'function');
  }

  let attempts = 0;
  const value = atomic.retrySharing(() => {
    attempts += 1;
    if (attempts <= 2) throw sharingDenial('EPERM', 'rename', 'a', 'b');
    return 'ok';
  });
  check('retrySharing rides out two EPERM denials', value === 'ok' && attempts === 3, `attempts ${attempts}`);

  attempts = 0;
  const asyncValue = await atomic.retrySharingAsync(async () => {
    attempts += 1;
    if (attempts <= 2) throw sharingDenial('EACCES', 'rename', 'a', 'b');
    return 'async-ok';
  });
  check('retrySharingAsync rides out two EACCES denials',
    asyncValue === 'async-ok' && attempts === 3, `attempts ${attempts}`);

  attempts = 0;
  const tail = await capture(atomic.retrySharingAsync(async () => {
    attempts += 1;
    throw sharingDenial('EBUSY', 'rename', 'a', 'b');
  }));
  check('retrySharingAsync gives up after five waits (six attempts)',
    tail.error?.code === 'EBUSY' && attempts === 6, `attempts ${attempts}`);
}

// ─── (2) safe-file.js: the deploy state documents ───────────────────────────

setGroup('(2) safe-file.js writeFileEventual (deploy state, run records)');
{
  const dir = tempFolder('safe-file');
  const file = path.join(dir, 'state.json');
  safeFile.writeFileEventual(file, '{"generation":1}');
  const original = fs.readFileSync(file, 'utf8');

  let injection = injectSyncRename({ match: into('/state.json'), times: 2 });
  const ok = await capture(withInjection(injection, () => safeFile.writeFileEventual(file, '{"generation":2}')));
  check('two denials: the new document is published',
    !ok.error && fs.readFileSync(file, 'utf8') === '{"generation":2}' && injection.calls() >= 3,
    `rename attempts ${injection.calls()}, error ${ok.error?.code ?? 'none'}`);

  injection = injectSyncRename({ match: into('/state.json'), times: 7 });
  const failed = await capture(withInjection(injection, () => safeFile.writeFileEventual(file, '{"generation":3}')));
  check('seven denials: the caller gets EPERM, as before',
    failed.error?.code === 'EPERM' && /rename/.test(failed.error?.message ?? ''),
    failed.error?.message ?? 'no error');
  check('seven denials: the previous document is untouched',
    fs.readFileSync(file, 'utf8') === '{"generation":2}');
  check('seven denials: no temporary file is left behind',
    listing(dir).join(',') === 'state.json', listing(dir).join(','));
}

// ─── (3) ssl/managed-artifacts.js: the managed-certificate manifest ─────────

setGroup('(3) ssl/managed-artifacts.js recordManagedArtifacts (the manifest)');
{
  const dataDir = fs.realpathSync.native(tempFolder('manifest-data'));
  const sslDir = fs.realpathSync.native(tempFolder('manifest-ssl'));
  const certDir = path.join(sslDir, 'example.test');
  fs.mkdirSync(certDir, { recursive: true });
  fs.mkdirSync(path.join(sslDir, '.account'), { recursive: true });
  fs.writeFileSync(path.join(certDir, 'fullchain.pem'), 'first chain\n');
  fs.writeFileSync(path.join(certDir, 'privkey.pem'), 'first key\n');

  const recorded = await capture(managed.recordManagedArtifacts({
    dataDir, sslDir, files: ['example.test/fullchain.pem'], directories: ['example.test'],
  }));
  const manifestPath = managed.managedManifestPath(dataDir);
  const before = fs.readFileSync(manifestPath);
  check('the manifest is recorded through the helper', !recorded.error && before.length > 0,
    recorded.error?.message ?? `${before.length} bytes`);

  let injection = injectSyncRename({ match: into('ssl-managed-artifacts.json'), times: 2 });
  const second = await capture(withInjection(injection, () => managed.recordManagedArtifacts({
    dataDir, sslDir, files: ['example.test/privkey.pem'], directories: ['example.test'],
  })));
  const afterTwo = fs.readFileSync(manifestPath, 'utf8');
  check('two denials: the second file is recorded',
    !second.error && afterTwo.includes('example.test/privkey.pem') && injection.calls() >= 3,
    `rename attempts ${injection.calls()}, error ${second.error?.code ?? 'none'}`);

  const stable = fs.readFileSync(manifestPath);
  injection = injectSyncRename({ match: into('ssl-managed-artifacts.json'), times: 7 });
  const failed = await capture(withInjection(injection, () => managed.recordManagedArtifacts({
    dataDir, sslDir, files: ['example.test/fullchain.pem'], directories: ['.account'],
  })));
  check('seven denials: the caller gets EPERM, as before',
    failed.error?.code === 'EPERM', failed.error?.message ?? 'no error');
  check('seven denials: the recorded manifest is untouched',
    Buffer.compare(stable, fs.readFileSync(manifestPath)) === 0);
  const leftovers = listing(dataDir).filter((name) => name.endsWith('.tmp'));
  check('seven denials: the manifest temp file is removed', leftovers.length === 0, leftovers.join(','));
}

// ─── (4) ssl/private-keys.js: the published key and certificate files ───────

setGroup('(4) ssl/private-keys.js replaceCertificateFile (async path)');
{
  const dir = tempFolder('private-keys');
  const file = path.join(dir, 'fullchain.pem');
  await privateKeys.replaceCertificateFile(file, 'FIRST\n');
  check('the file is published', fs.readFileSync(file, 'utf8') === 'FIRST\n');

  let injection = injectAsyncRename({ match: into('/fullchain.pem'), times: 2, code: 'EACCES' });
  const ok = await capture(withInjection(injection, () => privateKeys.replaceCertificateFile(file, 'SECOND\n')));
  check('two denials: the replacement succeeds',
    !ok.error && fs.readFileSync(file, 'utf8') === 'SECOND\n' && injection.calls() >= 3,
    `rename attempts ${injection.calls()}, error ${ok.error?.code ?? 'none'}`);

  injection = injectAsyncRename({ match: into('/fullchain.pem'), times: 7, code: 'EPERM' });
  const failed = await capture(withInjection(injection, () => privateKeys.replaceCertificateFile(file, 'THIRD\n')));
  check('seven denials: the caller gets EPERM, as before',
    failed.error?.code === 'EPERM', failed.error?.message ?? 'no error');
  check('seven denials: the published file is untouched',
    fs.readFileSync(file, 'utf8') === 'SECOND\n');
  check('seven denials: no temporary file is left behind',
    listing(dir).join(',') === 'fullchain.pem', listing(dir).join(','));
}

// ─── (5) ssl/certificate-transaction.js: the journal and the pair ───────────

/**
 * A self-signed certificate and its key, in memory. node-forge is already a
 * test dependency (ssl-preflight uses it), so no new package is added.
 */
function makeCertificate(domain) {
  const forge = require('node-forge');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey);
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  const subject = [{ name: 'commonName', value: domain }];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.sign(forge.pki.privateKeyFromPem(privateKey), forge.md.sha256.create());
  return {
    'fullchain.pem': forge.pki.certificateToPem(cert),
    'privkey.pem': privateKey,
    'ez-cert.json': JSON.stringify({ domain }),
  };
}

setGroup('(5) ssl/certificate-transaction.js publishCertificateFiles');
{
  const domain = 'retry.example.test';
  const pair = makeCertificate(domain);

  /** A fresh data dir + ssl dir with the previous pair already on disk. */
  const scenario = (label) => {
    const dataDir = tempFolder(`journal-data-${label}`);
    const sslDir = tempFolder(`journal-ssl-${label}`);
    const certDir = path.join(sslDir, domain);
    fs.mkdirSync(certDir, { recursive: true });
    fs.writeFileSync(path.join(certDir, 'fullchain.pem'), 'OLD CHAIN\n');
    fs.writeFileSync(path.join(certDir, 'privkey.pem'), 'OLD KEY\n');
    return { dataDir, sslDir, certDir };
  };

  const publish = (dirs) => transaction.publishCertificateFiles({
    ...dirs, domain, files: pair,
  });

  // The journal write (the renamed `fs.renameSync` this brief converted).
  {
    const dirs = scenario('journal');
    const journalSuffix = '.journal.json';
    let injection = injectSyncRename({ match: into(journalSuffix), times: 2 });
    const ok = await capture(withInjection(injection, () => publish(dirs)));
    check('two denials on the journal: the pair is published',
      !ok.error && fs.readFileSync(path.join(dirs.certDir, 'fullchain.pem'), 'utf8') === pair['fullchain.pem'],
      `rename attempts ${injection.calls()}, error ${ok.error?.code ?? 'none'}`);
    check('two denials on the journal: the journal is cleaned up',
      !fs.existsSync(transaction.certificateJournalPath(dirs.dataDir, domain)));

    const dirs2 = scenario('journal-fail');
    const stable = fs.readFileSync(path.join(dirs2.certDir, 'fullchain.pem'));
    injection = injectSyncRename({ match: into(journalSuffix), times: 7 });
    const failed = await capture(withInjection(injection, () => publish(dirs2)));
    check('seven denials on the journal: the caller gets EPERM, as before',
      failed.error?.code === 'EPERM', failed.error?.message ?? 'no error');
    check('seven denials on the journal: the previous certificate is untouched',
      Buffer.compare(stable, fs.readFileSync(path.join(dirs2.certDir, 'fullchain.pem'))) === 0
      && fs.readFileSync(path.join(dirs2.certDir, 'privkey.pem'), 'utf8') === 'OLD KEY\n');
    check('seven denials on the journal: no journal or staging file is left',
      !fs.existsSync(transaction.certificateJournalPath(dirs2.dataDir, domain))
      && listing(dirs2.certDir).sort().join(',') === 'fullchain.pem,privkey.pem',
      listing(dirs2.certDir).sort().join(','));
  }

  // The certificate pair rename, which keeps its own longer schedule through
  // the shared retry (50 × 10 ms) — two denials are far inside it.
  {
    const dirs = scenario('pair');
    const injection = injectSyncRename({
      match: (to) => normalise(to).toLowerCase().endsWith('/privkey.pem'),
      times: 2,
      code: 'EBUSY',
    });
    const ok = await capture(withInjection(injection, () => publish(dirs)));
    check('two denials on the key rename: the new pair is published',
      !ok.error && fs.readFileSync(path.join(dirs.certDir, 'privkey.pem'), 'utf8') === pair['privkey.pem']
      && fs.readFileSync(path.join(dirs.certDir, 'fullchain.pem'), 'utf8') === pair['fullchain.pem'],
      `rename attempts ${injection.calls()}, error ${ok.error?.code ?? 'none'}`);
  }
}

// ─── (6) ssl/artifact-lock.js: the guard-held lock replacement ──────────────

setGroup('(6) ssl/artifact-lock.js replaceStale (the lock replace at ~:287)');
{
  const key = 'rename-retry-lock';
  const staleLock = (dataDir) => path.join(dataDir, `.${key}.lock`);

  const scenario = (label) => {
    const dataDir = tempFolder(`lock-${label}`);
    fs.mkdirSync(dataDir, { recursive: true });
    const lockPath = staleLock(dataDir);
    const stale = {
      version: 1, key, token: 'stale-owner', pid: process.pid, host: os.hostname(), startedAt: 1,
    };
    fs.writeFileSync(lockPath, `${JSON.stringify(stale)}\n`);
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(lockPath, old, old);
    return { dataDir, lockPath };
  };

  {
    const { dataDir, lockPath } = scenario('replace');
    const injection = injectSyncRename({ match: (to) => to === lockPath, times: 2 });
    const took = await capture(Promise.resolve().then(() => artifactLock.acquireArtifactLockSync({
      dataDir, key, timeoutMs: 2_000,
    })));
    const handle = took.value;
    check('two denials: the stale lock is replaced and held',
      !took.error && handle?.isOwner() === true && injection.calls() >= 3,
      `rename attempts ${injection.calls()}, error ${took.error?.code ?? 'none'}`);
    injection.restore();
    const released = handle?.release();
    check('the replaced lock is released cleanly', released === true, String(released));
  }

  {
    const { dataDir, lockPath } = scenario('persistent');
    const original = fs.readFileSync(lockPath, 'utf8');
    const injection = injectSyncRename({ match: (to) => to === lockPath, times: Infinity });
    const took = await capture(Promise.resolve().then(() => artifactLock.acquireArtifactLockSync({
      dataDir, key, timeoutMs: 400,
    })));
    check('seven denials: acquisition fails with the same EPERM reason',
      Boolean(took.error) && /EPERM/.test(took.error?.message ?? ''),
      took.error?.message ?? 'no error');
    check('seven denials: the stale lock on disk is untouched',
      fs.readFileSync(lockPath, 'utf8') === original);
    injection.restore();
  }
}

// ─── (7) setupCode.js: the setup-code lock detach ───────────────────────────

setGroup('(7) setupCode.js withSetupCodeLock (the lock detach)');
{
  const lockPath = path.join(TEST_DATA_DIR, 'setup-code.lock');
  const clearLock = () => {
    try { fs.rmSync(lockPath, { force: true }); } catch { /* already gone */ }
    for (const name of listing(TEST_DATA_DIR)) {
      if (name.startsWith('setup-code.lock.released-')) fs.rmSync(path.join(TEST_DATA_DIR, name), { force: true });
    }
  };

  // Release path: withSetupCodeLock renames the lock aside when it is done.
  clearLock();
  let injection = injectSyncRename({ match: has('.released-'), times: 2 });
  const ok = await capture(withInjection(injection, () => setupCode.withSetupCodeLock(async () => 'finished')));
  check('two denials: the section runs and the lock is detached',
    ok.value === 'finished' && !fs.existsSync(lockPath) && injection.calls() >= 3,
    `rename attempts ${injection.calls()}, error ${ok.error?.code ?? 'none'}`);

  // Stale recovery path: an abandoned lock is moved aside and re-taken.
  clearLock();
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'stale', createdAt: 1 }));
  const old = new Date(Date.now() - 5 * 60_000);
  fs.utimesSync(lockPath, old, old);
  injection = injectSyncRename({
    match: (to, from) => from === lockPath || has('.released-')(to),
    times: 2,
  });
  const recovered = await capture(withInjection(injection, () => setupCode.withSetupCodeLock(async () => 'recovered')));
  check('two denials: a stale lock is recovered and released',
    recovered.value === 'recovered' && !fs.existsSync(lockPath) && injection.calls() >= 3,
    `rename attempts ${injection.calls()}, error ${recovered.error?.code ?? 'none'}`);

  // Persistent failure: same error as before, abandoned lock left in place.
  clearLock();
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'stale', createdAt: 1 }));
  fs.utimesSync(lockPath, old, old);
  const before = fs.readFileSync(lockPath, 'utf8');
  injection = injectSyncRename({ match: (to, from) => from === lockPath, times: 7 });
  const failed = await capture(withInjection(injection, () => setupCode.withSetupCodeLock(async () => 'never')));
  check('seven denials: the caller gets the same EPERM',
    failed.error?.code === 'EPERM', failed.error?.message ?? 'no error');
  check('seven denials: the abandoned lock is left for the stale timer',
    fs.readFileSync(lockPath, 'utf8') === before);
  injection.restore();
  clearLock();
}

// ─── (8) deployKey.js: the app's private key ───────────────────────────────

setGroup('(8) core/deploy/deployKey.js generateDeployKey');
{
  const created = apps.createApp({
    id: 'retry-key-app', repoUrl: 'git@github.com:acme/retry-key.git', authType: 'deployKey',
  });
  check('the app is registered in this run\'s data directory', created.ok === true,
    (created.errors ?? []).join('; '));

  const keyPath = store.appPaths('retry-key-app').deployKey;
  const first = deployKey.generateDeployKey('retry-key-app');
  check('the first key is generated', Boolean(first?.publicKey) && fs.existsSync(keyPath));

  let injection = injectSyncRename({ match: into('/id_deploy'), times: 2 });
  const second = await capture(Promise.resolve().then(() => deployKey.generateDeployKey('retry-key-app')));
  const onDisk = fs.readFileSync(keyPath, 'utf8');
  check('two denials: the key is replaced',
    !second.error && second.value?.publicKey
      && second.value.publicKey !== first.publicKey
      && onDisk.includes('BEGIN OPENSSH PRIVATE KEY') && injection.calls() >= 3,
    `rename attempts ${injection.calls()}, error ${second.error?.code ?? 'none'}`);

  injection = injectSyncRename({ match: into('/id_deploy'), times: 7 });
  const failed = await capture(Promise.resolve().then(() => deployKey.generateDeployKey('retry-key-app')));
  check('seven denials: the caller gets the same write error',
    /Could not write the deploy key/.test(failed.error?.message ?? '') && /EPERM/.test(failed.error?.message ?? ''),
    failed.error?.message ?? 'no error');
  check('seven denials: the previous key on disk is untouched',
    fs.readFileSync(keyPath, 'utf8') === onDisk);
}

// ─── (9) domains-db.js: the nginx site enable/disable rename ───────────────

setGroup('(9) core/domains-db.js handleHubDomainCommand toggle (site rename)');
{
  const nginxDir = tempFolder('nginx-sites');
  dbSet('config', { ...(dbGet('config') ?? {}), nginxDir });

  const confPath = path.join(nginxDir, 'retry.example.test.conf');
  fs.writeFileSync(confPath, '# site\n');
  const domain = domainsDb.createDomain({ name: 'retry.example.test', port: 3000 });
  domainsDb.saveDomains([{ ...domain, enabled: true, configFile: confPath }]);

  const stubRun = async () => ({ success: true, stdout: '', stderr: '', exitCode: 0 });

  let injection = injectAsyncRename({ match: into('.conf.disabled'), times: 2, code: 'EPERM' });
  const disabled = await capture(withInjection(injection, () => domainsDb.handleHubDomainCommand(
    { action: 'toggle', name: 'retry.example.test' }, { runFn: stubRun },
  )));
  check('two denials: the site is disabled',
    disabled.value?.ok === true && disabled.value?.enabled === false
      && fs.existsSync(`${confPath}.disabled`) && injection.calls() >= 3,
    `rename attempts ${injection.calls()}, ${JSON.stringify(disabled.value ?? disabled.error?.code)}`);

  injection = injectAsyncRename({ match: into('.conf'), times: 7, code: 'EBUSY' });
  const failed = await capture(withInjection(injection, () => domainsDb.handleHubDomainCommand(
    { action: 'toggle', name: 'retry.example.test' }, { runFn: stubRun },
  )));
  check('seven denials: the same {ok:false, error} is returned',
    failed.value?.ok === false && /^Could not enable: EBUSY/.test(failed.value?.error ?? ''),
    JSON.stringify(failed.value ?? failed.error?.code));
  check('seven denials: the site file is still disabled on disk',
    fs.existsSync(`${confPath}.disabled`) && !fs.existsSync(confPath));
}

// ─── (10) Static audit: every rename/copy call site ───────────────────────

/**
 * Every site that is allowed to call a rename or copy directly.
 *
 * `file` is relative to src/ with forward slashes; `site` must appear on the
 * call's line. An entry that no longer matches anything is reported as STALE —
 * it is not a failure, because another lane may have converted the site after
 * this list was written, but it is printed so the list cannot rot silently.
 */
const ALLOWED = [
  {
    file: 'core/daemon/lock.js',
    site: 'retryContention(() => fs.renameSync(candidate, target))',
    reason: 'the daemon lock\'s own contention loop (EPERM/EBUSY, verified under load in 1.4.8) — not a state-file write',
  },
  {
    file: 'core/ssl/artifact-lock.js',
    site: 'fs.renameSync(guard, claim)',
    reason: 'retireStaleRecoveryGuard\'s own contention loop (200 x 5 ms, EPERM/EBUSY, measured under load) — left as it is',
  },
  {
    file: 'core/ssl/artifact-lock.js',
    site: 'fs.renameSync(result.lock, detached)',
    reason: 'release\'s own contention loop, retried below it in the same block — left as it is',
  },
  {
    file: 'core/ssl/artifact-lock.js',
    site: 'if (!fs.existsSync(result.lock)) fs.renameSync(detached, result.lock)',
    reason: 'the ownership-mismatch restore inside release\'s loop; best effort by design',
  },
  {
    file: 'core/ssl/certificate-transaction.js',
    site: 'deps.renameSync ? deps.renameSync(source, target, entry.name, index)',
    reason: 'a caller-supplied test seam (`deps`), not an fs call',
  },
  {
    file: 'core/service/updateTransaction.js',
    site: 'fs.copyFileSync(file, target)',
    reason: 'snapshotFile copies the current file into a fresh mkdtemp folder (a new name, nothing replaced) — no retry needed',
  },
  {
    file: 'core/service/updateTransaction.js',
    site: 'fs.copyFileSync(source, temporary)',
    reason: 'replaceFile copies to a unique .rollback-<uuid> temp; the replace itself goes through renameWithRetry',
  },
];

/** A line that is not a comment, so prose about a rename is not a call site. */
function isCodeLine(line) {
  const trimmed = line.trim();
  return !(trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*'));
}

/** Every `.js` file under src/, minus node_modules and the React UI sources. */
function sourceFiles(dir = path.join(ROOT, 'src'), found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    const rel = normalise(path.relative(path.join(ROOT, 'src'), full));
    if (rel === 'dashboard/ui' || rel.startsWith('dashboard/ui/')) continue;
    if (entry.isDirectory()) sourceFiles(full, found);
    else if (entry.isFile() && entry.name.endsWith('.js')) found.push(full);
  }
  return found;
}

function auditCallSites() {
  const callSite = /renameSync\(|fs\.rename\(|promises\.rename\(|copyFileSync\(/;
  const sharedCall = /retrySharing(?:Async)?\(/;
  const rows = [];

  for (const full of sourceFiles()) {
    const rel = normalise(path.relative(path.join(ROOT, 'src'), full));
    const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!isCodeLine(line) || !callSite.test(line)) continue;

      let status = 'UNLISTED';
      let reason = 'not the shared helper and no allowlist entry';
      if (rel === 'core/atomicState.js') {
        status = 'shared';
        reason = 'the shared helper itself';
      } else if (sharedCall.test(line)) {
        status = 'shared';
        reason = 'the retried operation inside retrySharing';
      } else {
        const entry = ALLOWED.find((item) => item.file === rel && line.includes(item.site));
        if (entry) {
          status = 'allowed';
          reason = entry.reason;
        }
      }
      rows.push({ file: rel, line: index + 1, code: line.trim(), status, reason });
    }
  }

  const used = new Set(rows.filter((row) => row.status === 'allowed')
    .map((row) => `${row.file}\u0000${row.code}`));
  const stale = ALLOWED.filter((entry) => ![...used].some((key) => {
    const [file, code] = key.split('\u0000');
    return file === entry.file && code.includes(entry.site);
  }));
  return { rows, stale };
}

setGroup('(10) static audit: every rename / copy call site in src/');
{
  const { rows, stale } = auditCallSites();
  const width = Math.max(...rows.map((row) => `${row.file}:${row.line}`.length), 24);

  process.stdout.write(`   ${'file:line'.padEnd(width)}  status   site\n`);
  for (const row of rows) {
    process.stdout.write(
      `   ${`${row.file}:${row.line}`.padEnd(width)}  ${row.status.padEnd(8)} ${row.code}\n`,
    );
  }

  const unlisted = rows.filter((row) => row.status === 'UNLISTED');
  const shared = rows.filter((row) => row.status === 'shared');
  const allowed = rows.filter((row) => row.status === 'allowed');

  check('every rename/copy call site is shared or allowlisted',
    unlisted.length === 0,
    `${shared.length} shared, ${allowed.length} allowlisted, ${unlisted.length} unlisted`);
  for (const row of unlisted) {
    check(`${row.file}:${row.line} goes through the shared helper`, false, row.code);
  }
  check('the audit prints every allowlist entry with its reason',
    ALLOWED.every((entry) => typeof entry.reason === 'string' && entry.reason.length > 10));
  check('no allowlist entry is still marked pending another lane',
    ALLOWED.every((entry) => !entry.reason.startsWith('pending:')));
  check('every allowlist entry names the site it allows, and still matches one',
    ALLOWED.every((entry) => rows.some((row) => row.file === entry.file && row.code.includes(entry.site))),
    `${ALLOWED.length} entries`);
  if (stale.length > 0) {
    process.stdout.write(`   note: ${stale.length} allowlist entr(y/ies) no longer match a site (already converted):\n`);
    for (const entry of stale) process.stdout.write(`     - ${entry.file}: ${entry.site}\n`);
  } else {
    process.stdout.write('   note: every allowlist entry still matches a call site\n');
  }
}

// ─── Summary ────────────────────────────────────────────────────────────────

const failed = results.filter((r) => !r.passed);
process.stdout.write(`\n${'─'.repeat(64)}\n`);
process.stdout.write(`TOTAL ${results.length}   PASS ${results.length - failed.length}   FAIL ${failed.length}\n`);
for (const item of failed) {
  process.stdout.write(`   FAILED  [${item.group}] ${item.label}${item.detail ? `  (${item.detail})` : ''}\n`);
}
process.exit(failed.length ? 1 : 0);
