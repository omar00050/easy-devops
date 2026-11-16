/**
 * core/service/acl.js
 *
 * Granting the Windows service account the access it needs — and nothing else.
 *
 * The service runs as `NT SERVICE\EasyDevOps`, a virtual account with no
 * password and, by default, no rights to anything outside its own service key.
 * That is the right starting point, and it means every directory it genuinely
 * needs has to be granted explicitly:
 *
 *   - the data directory      — Modify: it writes the database, the lock, logs
 *   - the pinned runtime      — Read & execute: it runs node.exe from there
 *   - `nginxDir` from Settings — Modify: it writes and reloads domain configs
 *   - `sslDir` from Settings   — Modify: it writes renewed certificates
 *
 * ── Why the paths come from Settings and are never hardcoded ───────────────
 *
 * `C:\nginx` and `C:\ssl` are only the defaults. A user who installed nginx
 * somewhere else, or moved their certificates, would get a service that
 * silently cannot read its own configuration — while the grant sat on two
 * directories that may not even exist. Worse, granting a hardcoded path would
 * hand a service account write access to a directory the user never pointed us
 * at. So the grants are computed from the live config, recorded, and compared
 * on every `status`: if the user changes a path in Settings afterwards, the
 * service is told to run `ezz service repair` rather than quietly losing
 * access.
 *
 * ── Why inheritance flags matter ───────────────────────────────────────────
 *
 * `(OI)(CI)` makes the grant apply to files and subdirectories created later.
 * Without them, a certificate renewed next month lands in a directory the
 * service can enter but whose new file it cannot read. `/T` applies the change
 * to what is already there.
 *
 * Nothing in this module runs without an elevated terminal; `icacls` fails with
 * "Access is denied" otherwise, which is reported as such rather than retried.
 */

import fs from 'fs';
import path from 'path';

import { run as shellRun } from '../shell.js';
import { SERVICE_ACCOUNT } from './winsw.js';

/** Access levels, in icacls's own notation. */
export const ACCESS = Object.freeze({
  /** Read, write, delete within the tree. Not "take ownership" or "change permissions". */
  MODIFY: 'M',
  /** Read and execute only. */
  READ_EXECUTE: 'RX',
});

/**
 * Which directories the service needs, and at what level.
 *
 * @param {Object} opts
 * @param {string} opts.dataDir
 * @param {string} [opts.runtimeDir]
 * @param {string} [opts.nginxDir] From Settings — never a default
 * @param {string} [opts.sslDir]   From Settings — never a default
 * @returns {Array<{ path: string, access: string, why: string }>}
 */
export function requiredGrants({ dataDir, runtimeDir = null, nginxDir = null, sslDir = null } = {}) {
  const grants = [
    { path: dataDir, access: ACCESS.MODIFY, why: 'the database, the daemon lock and logs' },
  ];

  if (runtimeDir) {
    grants.push({ path: runtimeDir, access: ACCESS.READ_EXECUTE, why: 'running the pinned node.exe' });
  }
  if (nginxDir) {
    grants.push({ path: nginxDir, access: ACCESS.MODIFY, why: 'writing and reloading domain configs' });
  }
  if (sslDir) {
    grants.push({ path: sslDir, access: ACCESS.MODIFY, why: 'writing renewed certificates' });
  }

  // A user can point nginxDir and sslDir at the same tree, or nest one inside
  // the other. Granting twice is harmless but produces confusing output, so
  // duplicates are collapsed — keeping the broader access where they differ.
  const seen = new Map();
  for (const grant of grants) {
    if (!grant.path) continue;
    const key = path.resolve(grant.path).toLowerCase();
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, grant);
    } else if (existing.access === ACCESS.READ_EXECUTE && grant.access === ACCESS.MODIFY) {
      seen.set(key, grant);
    }
  }

  return [...seen.values()];
}

/**
 * The icacls command for one grant.
 *
 * The account name is quoted because it contains a backslash and a space;
 * `icacls` is given the path quoted for the same reason.
 *
 * @param {string} dir
 * @param {string} access
 * @param {string} [account]
 * @returns {string}
 */
export function buildGrantCommand(dir, access, account = SERVICE_ACCOUNT) {
  return `icacls "${dir}" /grant "${account}:(OI)(CI)${access}" /T /C /Q`;
}

/** The icacls command that removes every grant for the account. */
export function buildRevokeCommand(dir, account = SERVICE_ACCOUNT) {
  return `icacls "${dir}" /remove:g "${account}" /T /C /Q`;
}

/**
 * Applies every required grant.
 *
 * `run` is injectable so tests drive a stub and assert on the exact commands
 * rather than touching real ACLs. This is not optional politeness: applying a
 * real grant during a test run would change permissions on the developer's own
 * nginx directory.
 *
 * @param {Object} opts
 * @param {Array} opts.grants From requiredGrants()
 * @param {Function} [opts.run]
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<{ ok: boolean, applied: Array, failed: Array, needsElevation: boolean }>}
 */
export async function applyGrants({ grants, run = shellRun, log = () => {} } = {}) {
  const applied = [];
  const failed = [];
  let needsElevation = false;

  for (const grant of grants) {
    if (!grant.path) continue;

    if (!fs.existsSync(grant.path)) {
      // A missing directory is not a failure to grant: nginxDir can legitimately
      // point somewhere not yet created, and `repair` will pick it up later.
      // Granting on a path we then create would also be wrong, because we would
      // be choosing its location rather than the user.
      failed.push({ ...grant, reason: 'the directory does not exist yet' });
      log(`  ${grant.path}: skipped, does not exist`);
      continue;
    }

    const result = await run(buildGrantCommand(grant.path, grant.access), { timeout: 60_000 });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

    if (result.success) {
      applied.push(grant);
      log(`  ${grant.path}: ${grant.access} granted (${grant.why})`);
      continue;
    }

    if (/access is denied/i.test(output)) needsElevation = true;
    failed.push({ ...grant, reason: output.trim().slice(0, 300) || 'icacls failed with no output' });
    log(`  ${grant.path}: FAILED`);
  }

  return { ok: failed.length === 0, applied, failed, needsElevation };
}

/** Removes the account's grants. Used by uninstall. */
export async function revokeGrants({ paths, run = shellRun, log = () => {} } = {}) {
  const removed = [];
  const failed = [];

  for (const dir of paths) {
    if (!dir || !fs.existsSync(dir)) continue;

    const result = await run(buildRevokeCommand(dir), { timeout: 60_000 });
    if (result.success) {
      removed.push(dir);
      log(`  ${dir}: grants removed`);
    } else {
      failed.push({ path: dir, reason: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(0, 300) });
    }
  }

  return { ok: failed.length === 0, removed, failed };
}

/**
 * Whether the paths granted at install still match the live Settings.
 *
 * This is the check that catches the realistic failure: the user installs the
 * service, then later changes `nginxDir` in Settings, and the service can no
 * longer read the directory it is being asked to manage. Nothing detects that
 * on its own, so it is compared explicitly and surfaced by `status`.
 *
 * @param {Object} opts
 * @param {string[]} opts.granted  Paths recorded at install time
 * @param {Array} opts.required    From requiredGrants() with the current config
 * @returns {{ ok: boolean, missing: string[], stale: string[], reason: string|null }}
 */
export function compareGrants({ granted = [], required = [] } = {}) {
  const norm = (p) => path.resolve(p).toLowerCase();
  const grantedSet = new Set(granted.filter(Boolean).map(norm));
  const requiredSet = new Set(required.map((g) => g.path).filter(Boolean).map(norm));

  const missing = [...requiredSet].filter((p) => !grantedSet.has(p));
  const stale = [...grantedSet].filter((p) => !requiredSet.has(p));

  if (missing.length === 0 && stale.length === 0) {
    return { ok: true, missing: [], stale: [], reason: null };
  }

  const parts = [];
  if (missing.length) {
    parts.push(
      `the service has no access to ${missing.join(', ')} — a path in Settings changed since it was installed`,
    );
  }
  if (stale.length) {
    parts.push(`it still has access to ${stale.join(', ')}, which it no longer needs`);
  }

  return {
    ok: false,
    missing,
    stale,
    reason: `${parts.join('; ')}. Run \`ezz service repair\` in an Administrator PowerShell to fix the permissions.`,
  };
}
