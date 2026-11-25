/**
 * Small cross-process lock for certificate ownership and lifecycle operations.
 *
 * The lock is an exclusively-created 0600 file under the data directory. Its
 * body names the owner token, pid, host and start time. Freshness comes from
 * the file mtime, which the owner refreshes through an open descriptor, so a
 * stale owner can be replaced without treating a newly-created empty file as a
 * crash.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const ARTIFACT_LOCK_STALE_MS = 120_000;
export const SSL_ARTIFACT_LIFECYCLE_LOCK = 'ssl-artifact-lifecycle';
const EMPTY_LOCK_GRACE_MS = 2_000;
const RECOVERY_GUARD_STALE_MS = 30_000;
const RETRY_MS = 25;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function delay(ms) {
  // The timer is the caller's only progress while it waits for the lock. An
  // unref'ed timer lets a short-lived Node process exit with an unsettled
  // top-level await instead of timing out or acquiring the lock.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statIfPresent(target) {
  try { return fs.lstatSync(target); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readOwner(file) {
  let handle;
  try {
    handle = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(handle);
    if (!stat.isFile() || stat.nlink !== 1) return null;
    const raw = fs.readFileSync(handle, 'utf8');
    const owner = JSON.parse(raw);
    if (!owner || typeof owner !== 'object' || Array.isArray(owner)) return null;
    if (typeof owner.token !== 'string' || !owner.token) return null;
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) return null;
    return { owner, stat };
  } catch {
    return null;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function ownerIsRunning(record, now) {
  if (!record) return false;
  const age = Math.max(0, now - record.stat.mtimeMs);
  const fresh = age < ARTIFACT_LOCK_STALE_MS;
  // A PID is not a stable identity and can be reused by an unrelated process.
  // The owner's heartbeat is the authority on both platforms. Without a fresh
  // heartbeat, a live PID says nothing about the process that wrote this lock.
  if (!fresh) return false;
  if (record.owner.host === os.hostname()) {
    return pidAlive(record.owner.pid);
  }
  return true;
}

function newOwner(key, now) {
  return {
    version: 1,
    key,
    token: crypto.randomUUID(),
    pid: process.pid,
    host: os.hostname(),
    startedAt: now,
  };
}

function lockNames(dataDir, key) {
  const safe = key.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
  const lock = path.join(dataDir, `.${safe}.lock`);
  return {
    lock,
    recovery: `${lock}.recovery`,
  };
}

function createExclusive(file, owner) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${JSON.stringify(owner)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
    return { ok: true };
  } catch (error) {
    return { ok: false, code: error?.code ?? 'UNKNOWN', message: error?.message ?? String(error) };
  }
}

function abandonedRecovery(guard, now) {
  const stat = statIfPresent(guard);
  if (!stat) return null;
  const record = readOwner(guard);
  if (!record) {
    return now - stat.mtimeMs > EMPTY_LOCK_GRACE_MS
      ? { stat, owner: null }
      : null;
  }
  return !ownerIsRunning(record, now)
    && now - record.stat.mtimeMs > RECOVERY_GUARD_STALE_MS
    ? { stat, owner: record.owner }
    : null;
}

/**
 * Move one inspected stale recovery guard aside before retiring it.
 *
 * Rechecking the inode after the rename prevents an unconditional unlink from
 * deleting a fresh guard created by a competing recovery worker. The caller
 * still verifies its own new guard immediately before and after replacing the
 * protected lock, so a worker whose guard was displaced can never proceed.
 */
function retireStaleRecoveryGuard(guard, abandoned) {
  const claim = `${guard}.stale-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.renameSync(guard, claim);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }

  const moved = statIfPresent(claim);
  const movedOwner = readOwner(claim)?.owner ?? null;
  const sameFile = Boolean(
    moved
    && !moved.isSymbolicLink()
    && moved.isFile()
    && moved.nlink === 1
    && moved.dev === abandoned.stat.dev
    && moved.ino === abandoned.stat.ino
    && (movedOwner?.token ?? null) === (abandoned.owner?.token ?? null),
  );

  if (!sameFile) {
    // A competing worker replaced this pathname between inspection and rename.
    // Put its guard back when possible and never act on the lock as this worker.
    try {
      if (!fs.existsSync(guard)) fs.renameSync(claim, guard);
    } catch { /* the displaced worker will fail its own guard check */ }
    return false;
  }

  try { fs.unlinkSync(claim); } catch { /* stale claim is harmless */ }
  return true;
}

function ownsRecoveryGuard(names, token) {
  return readOwner(names.recovery)?.owner.token === token;
}

function acquireRecoveryGuard(names, key, now) {
  const owner = newOwner(`${key}:recovery`, now);
  const first = createExclusive(names.recovery, owner);
  if (first.ok) return { ok: true, owner };
  if (first.code !== 'EEXIST') return { ok: false, reason: first.message };

  const stale = abandonedRecovery(names.recovery, now);
  if (stale && retireStaleRecoveryGuard(names.recovery, stale)) {
    const second = createExclusive(names.recovery, owner);
    if (second.ok) return { ok: true, owner };
  }
  return { ok: false, reason: 'another process is recovering the lock' };
}

function releaseRecoveryGuard(names, token) {
  const record = readOwner(names.recovery);
  if (record?.owner.token !== token) return;
  try { fs.unlinkSync(names.recovery); } catch { /* already released */ }
}

function replaceStale(names, key, now) {
  const guard = acquireRecoveryGuard(names, key, now);
  if (!guard.ok) return guard;
  try {
    if (!ownsRecoveryGuard(names, guard.owner.token)) {
      return { ok: false, reason: 'the recovery guard changed before lock replacement' };
    }
    const current = readOwner(names.lock);
    if (ownerIsRunning(current, now)) {
      return { ok: false, reason: 'another process owns the lock' };
    }
    const owner = newOwner(key, now);
    const candidate = `${names.lock}.candidate-${process.pid}-${crypto.randomUUID()}`;
    try {
      fs.writeFileSync(candidate, `${JSON.stringify(owner)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      if (process.platform !== 'win32') fs.chmodSync(candidate, 0o600);
      if (!ownsRecoveryGuard(names, guard.owner.token)) {
        return { ok: false, reason: 'the recovery guard changed before lock replacement' };
      }
      fs.renameSync(candidate, names.lock);
      if (!ownsRecoveryGuard(names, guard.owner.token)) {
        try {
          const installed = readOwner(names.lock);
          if (installed?.owner.token === owner.token) fs.unlinkSync(names.lock);
        } catch { /* the next owner must inspect and recover it */ }
        return { ok: false, reason: 'the recovery guard changed during lock replacement' };
      }
      return { ok: true, owner };
    } finally {
      try { fs.unlinkSync(candidate); } catch { /* renamed or never created */ }
    }
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) };
  } finally {
    releaseRecoveryGuard(names, guard.owner.token);
  }
}

function inspectLock(names, now) {
  const stat = statIfPresent(names.lock);
  if (!stat) return { exists: false, stale: false, reason: 'no lock file' };
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    return {
      exists: true,
      stale: now - stat.mtimeMs > ARTIFACT_LOCK_STALE_MS,
      reason: 'the lock is linked or not a regular file',
    };
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    return {
      exists: true,
      stale: now - stat.mtimeMs > ARTIFACT_LOCK_STALE_MS,
      reason: 'the lock has unsafe permissions',
    };
  }
  const record = readOwner(names.lock);
  if (!record) {
    const age = now - stat.mtimeMs;
    return {
      exists: true,
      stale: age > ARTIFACT_LOCK_STALE_MS,
      reason: age < EMPTY_LOCK_GRACE_MS ? 'the lock is being created' : 'the lock is unreadable',
    };
  }
  if (ownerIsRunning(record, now)) {
    return { exists: true, stale: false, owner: record.owner, reason: 'owner is alive' };
  }
  return {
    exists: true,
    stale: true,
    owner: record.owner,
    reason: 'owner pid is gone and the heartbeat is stale',
  };
}

function tryTake(dataDir, key, now) {
  const names = lockNames(dataDir, key);
  const owner = newOwner(key, now);
  const created = createExclusive(names.lock, owner);
  if (created.ok) return { ok: true, owner, ...names };
  if (created.code !== 'EEXIST') return { ok: false, reason: created.message };

  const state = inspectLock(names, now);
  if (!state.stale) return { ok: false, reason: state.reason };
  const replaced = replaceStale(names, key, now);
  return replaced.ok
    ? { ok: true, owner: replaced.owner, ...names }
    : { ok: false, reason: replaced.reason };
}

function makeHandle(result, key, heartbeatMs) {
  let heartbeat = null;
  const ownsCurrent = () => {
    const record = readOwner(result.lock);
    return record?.owner.token === result.owner.token;
  };
  const releaseOwned = () => {
    let handle;
    try {
      handle = fs.openSync(
        result.lock,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
      );
      const before = fs.fstatSync(handle);
      if (!before.isFile() || before.nlink !== 1) return false;
      const owner = JSON.parse(fs.readFileSync(handle, 'utf8'));
      if (owner?.token !== result.owner.token) return false;

      const detached = `${result.lock}.released-${process.pid}-${crypto.randomUUID()}`;
      fs.renameSync(result.lock, detached);
      const moved = fs.lstatSync(detached);
      if (!moved.isFile()
          || moved.isSymbolicLink()
          || moved.dev !== before.dev
          || moved.ino !== before.ino) {
        try {
          if (!fs.existsSync(result.lock)) fs.renameSync(detached, result.lock);
        } catch { /* ownership mismatch remains the safe result */ }
        return false;
      }
      fs.unlinkSync(detached);
      return true;
    } catch {
      return false;
    } finally {
      if (handle !== undefined) {
        try { fs.closeSync(handle); } catch { /* already closed */ }
      }
    }
  };
  const release = () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    return releaseOwned();
  };

  if (heartbeatMs > 0) {
    heartbeat = setInterval(() => {
      let handle;
      try {
        handle = fs.openSync(result.lock, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const stat = fs.fstatSync(handle);
        if (!stat.isFile() || stat.nlink !== 1) return;
        const raw = fs.readFileSync(handle, 'utf8');
        const owner = JSON.parse(raw);
        if (owner?.token !== result.owner.token) return;
        const current = new Date();
        fs.futimesSync(handle, current, current);
      } catch {
        /* Losing the lock is reported by the operation's ownership checks. */
      } finally {
        if (handle !== undefined) {
          try { fs.closeSync(handle); } catch { /* already closed */ }
        }
      }
    }, heartbeatMs);
    if (heartbeat && typeof heartbeat.unref === 'function') heartbeat.unref();
  }

  return {
    key,
    lockPath: result.lock,
    owner: result.owner,
    isOwner: ownsCurrent,
    release,
  };
}

export function acquireArtifactLockSync({
  dataDir,
  key,
  timeoutMs = 10_000,
  staleMs = ARTIFACT_LOCK_STALE_MS,
  heartbeatMs = 0,
  now = Date.now,
} = {}) {
  if (!path.isAbsolute(String(dataDir ?? '')) || typeof key !== 'string' || !key) {
    throw new Error('Artifact locks require an absolute data directory and a non-empty key.');
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(dataDir, 0o700);
  const deadline = now() + timeoutMs;
  for (;;) {
    const result = tryTake(dataDir, key, now());
    if (result.ok) return makeHandle(result, key, heartbeatMs);
    if (now() >= deadline) throw new Error(`Timed out waiting for the ${key} lock: ${result.reason}`);
    sleepSync(Math.min(RETRY_MS, staleMs));
  }
}

export async function acquireArtifactLock({
  dataDir,
  key,
  timeoutMs = 5 * 60_000,
  staleMs = ARTIFACT_LOCK_STALE_MS,
  heartbeatMs = 15_000,
  now = Date.now,
} = {}) {
  if (!path.isAbsolute(String(dataDir ?? '')) || typeof key !== 'string' || !key) {
    throw new Error('Artifact locks require an absolute data directory and a non-empty key.');
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(dataDir, 0o700);
  const deadline = now() + timeoutMs;
  for (;;) {
    const result = tryTake(dataDir, key, now());
    if (result.ok) return makeHandle(result, key, heartbeatMs);
    if (now() >= deadline) throw new Error(`Timed out waiting for the ${key} lock: ${result.reason}`);
    await delay(Math.min(RETRY_MS, staleMs));
  }
}
