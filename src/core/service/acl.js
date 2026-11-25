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
 * Existing entries are visited depth-first. Each directory is locked before it
 * is enumerated, so a same-account process cannot swap in a reparse point or
 * hard link after validation and before the ACL mutation.
 *
 * Nothing in this module runs without an elevated terminal; `icacls` fails with
 * "Access is denied" otherwise, which is reported as such rather than retried.
 */

import fs from 'fs';
import path from 'path';

import { runFile as shellRunFile } from '../shell.js';
import {
  isWindows,
  programDataDir,
  WINDOWS_PROGRAM_DATA_ROOT,
  WINDOWS_PROGRAM_FILES_ROOT,
  WINDOWS_PROGRAM_FILES_X86_ROOT,
  WINDOWS_SYSTEM_ROOT,
} from '../platform.js';
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
export function requiredGrants({ dataDir, nginxDir = null, sslDir = null } = {}) {
  const grants = [
    { path: dataDir, access: ACCESS.MODIFY, why: 'the database, the daemon lock and logs' },
  ];

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

/** Pin native tools to the Windows installation, bypassing the current directory and PATH. */
export function systemTool(name) {
  return path.win32.join(WINDOWS_SYSTEM_ROOT, 'System32', name);
}

export const WINDOWS_POWERSHELL = systemTool('WindowsPowerShell\\v1.0\\powershell.exe');

function inside(dir, base) {
  const rel = path.relative(base, dir);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function sameDirectory(left, right) {
  if (!left || !right) return false;
  const normalize = (value) => (
    isWindows ? path.win32.normalize(path.resolve(value)).toLowerCase()
      : path.posix.normalize(path.resolve(value))
  );
  return normalize(left) === normalize(right);
}

/** Validate before examining a settings-controlled location or passing it to an OS utility. */
export function canonicalAclDirectory(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || /["*?<>|\x00-\x1f]/.test(dir)
      || dir.split(/[\\/]/).some(part => part === '.' || part === '..' || /[. ]$/.test(part))
      || (isWindows && (!/^[A-Za-z]:[\\/]/.test(dir) || dir.slice(2).includes(':')))) {
    throw new Error('refusing an unusual path: use an absolute local directory');
  }
  const target = path.resolve(dir);
  const root = path.parse(target).root;
  const windows = WINDOWS_SYSTEM_ROOT;
  const protectedTrees = [
    windows,
    WINDOWS_PROGRAM_FILES_ROOT,
    WINDOWS_PROGRAM_FILES_X86_ROOT,
    path.join(root, 'System Volume Information'),
    path.join(root, '$Recycle.Bin'),
  ];
  // Dedicated Easy DevOps directories live below these OS container roots.
  // Deny the containers themselves, not every legitimate child. Callers that
  // accept a configured path also require it to equal a machine-level approval.
  const protectedContainers = [
    WINDOWS_PROGRAM_DATA_ROOT,
    path.join(root, 'Users'),
  ];
  if (target === root || (isWindows && (protectedTrees.some(base => inside(target, base))
      || protectedTrees.some(base => inside(base, target))
      || protectedContainers.some(base => sameDirectory(base, target))))) {
    throw new Error('refusing a system directory');
  }
  // Check every component before descending. realpath additionally catches aliases such as 8.3 names.
  let current = root;
  for (const part of target.slice(root.length).split(path.sep)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) throw new Error('the directory does not exist yet');
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('refusing a reparse point or non-directory');
  }
  if (path.relative(target, fs.realpathSync.native(target)) !== '') throw new Error('refusing a directory alias');
  return target;
}

// Node reports junctions and symbolic links through lstat, but Windows has other reparse tags.
// Inspect native attributes without expanding the path, including descendants before recursive operations.
const CHECK_ATTRIBUTES = [
  "$ErrorActionPreference = 'Stop'",
  '$p = [IO.DirectoryInfo]$env:EZ_ACL_TARGET',
  'for ($a = $p; $null -ne $a; $a = $a.Parent) { if ($a.Attributes -band 1024) { throw "reparse point" } }',
  'if ($env:EZ_ACL_TREE -eq "1") {',
  '  $stack = New-Object System.Collections.Stack; $stack.Push($p)',
  '  while ($stack.Count) { foreach ($item in $stack.Pop().EnumerateFileSystemInfos()) {',
  '    if ($item.Attributes -band 1024) { throw "reparse point" }',
  '    if ($item.Attributes -band 16) { $stack.Push($item) }',
  '  } }',
  '}',
].join('\n');

export async function checkedAclDirectory(dir, runFile, recursive = false) {
  const target = canonicalAclDirectory(dir);
  // The native walk checks reparse attributes before this process traverses
  // anything below the root. Hard-linked files are checked in walkAclTree only
  // after their parent DACL has been locked, which avoids a JavaScript tree
  // walk following a reparse tag that lstat did not classify as a symlink.
  const result = await runFile(WINDOWS_POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', CHECK_ATTRIBUTES], {
    env: { EZ_ACL_TARGET: target, EZ_ACL_TREE: recursive ? '1' : '0' }, timeout: 120_000,
  });
  if (!result.success) throw new Error('could not verify directory attributes or found a reparse point');
  return target;
}

/**
 * Applies a caller-supplied ACL operation without recursive icacls.
 *
 * The root is preflighted first. The walk then rewrites each directory's ACL
 * before reading its children. Once that operation removes ordinary-user write
 * access, the entries it enumerates cannot be replaced by the account whose
 * race this protects against. Files are checked for hard links immediately
 * after their now-protected parent is locked and before their own ACL changes.
 *
 * @param {string} root
 * @param {(target: string, kind: 'directory'|'file', stat: fs.Stats) => Promise<void>} visit
 * @param {{ runFile?: Function, fsApi?: typeof fs }} [opts]
 */
export async function walkAclTree(root, visit, {
  runFile = shellRunFile,
  fsApi = fs,
} = {}) {
  const canonical = await checkedAclDirectory(root, runFile, true);
  const pending = [canonical];

  while (pending.length > 0) {
    const directory = pending.pop();
    // The parent is locked before this check, so it cannot have been swapped
    // for another native reparse tag by the account this operation removes.
    await checkedAclDirectory(directory, runFile, false);
    const directoryStat = fsApi.lstatSync(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new Error(`refusing a reparse point or non-directory at ${directory}`);
    }
    await visit(directory, 'directory', directoryStat);

    let entries;
    try {
      entries = fsApi.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      throw new Error(`could not inspect ${directory}: ${error.message}`);
    }

    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      let stat;
      try {
        stat = fsApi.lstatSync(target);
      } catch (error) {
        throw new Error(`could not inspect ${target}: ${error.message}`);
      }
      if (stat.isSymbolicLink()) {
        throw new Error(`refusing a reparse point at ${target}`);
      }
      if (stat.isDirectory()) {
        pending.push(target);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`refusing a non-file entry at ${target}`);
      }
      if (stat.nlink > 1) {
        throw new Error(`refusing a hard-linked file in the approved directory: ${target}`);
      }
      await visit(target, 'file', stat);
    }
  }

  return canonical;
}

/** Read independent approvals from the machine environment (HKLM), never the operator database. */
export async function approvedGrantDirs(runFile) {
  const keys = ['EASY_DEVOPS_APPROVED_NGINX_DIR', 'EASY_DEVOPS_APPROVED_SSL_DIR'];
  const dirs = [programDataDir()];
  for (const [i, key] of keys.entries()) {
    const result = await runFile(WINDOWS_POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command',
      `[Environment]::GetEnvironmentVariable('${key}', 'Machine')`], { timeout: 20_000 });
    if (result.success) dirs.push(result.stdout.trim() || ['C:\\nginx', 'C:\\easy-devops\\ssl'][i]);
  }
  return dirs;
}

async function changeGrants({ grants, approvedDirs, runFile, revoke, log }) {
  const applied = [], failed = [];
  let needsElevation = false;
  const approved = approvedDirs ?? await approvedGrantDirs(runFile);
  for (const grant of grants) {
    try {
      const dir = grant.path;
      if (!approved.some(base => typeof dir === 'string' && path.isAbsolute(dir)
          && path.relative(base, dir) === '')) {
        throw new Error('directory lacks administrator approval; set the matching machine-level '
          + 'EASY_DEVOPS_APPROVED_NGINX_DIR or EASY_DEVOPS_APPROVED_SSL_DIR and run ezz service repair');
      }
      const machine = programDataDir();
      const canonical = await checkedAclDirectory(dir, runFile, false);
      if (['runtime', 'runtime.prev', 'bin'].some(name => inside(canonical, path.join(machine, name)))) {
        throw new Error('Service code directories cannot receive a data grant');
      }
      await walkAclTree(canonical, async (target, kind) => {
        // Inherit Modify into ordinary children. Protected bin/runtime DACLs
        // remain read-only and are rejected before the walk begins.
        const args = revoke
          ? [target, '/remove:g', SERVICE_ACCOUNT]
          : [target, '/grant', `${SERVICE_ACCOUNT}:${kind === 'directory' ? '(OI)(CI)' : ''}M`];
        const result = await runFile(systemTool('icacls.exe'), [...args, '/L', '/Q'], { timeout: 120_000 });
        if (!result.success) {
          const output = `${result.stdout ?? ''} ${result.stderr ?? ''}`.trim();
          if (/access is denied/i.test(output)) needsElevation = true;
          throw new Error(output.slice(0, 300) || 'icacls failed');
        }
      }, { runFile });
      applied.push(grant);
      log(`  ${canonical}: ${revoke ? 'removed service grant' : 'granted Modify'}`);
    } catch (err) {
      failed.push({ ...grant, reason: err.message });
      log(`  ${grant.path}: ${err.message}`);
    }
  }
  return { ok: !failed.length, applied, failed, needsElevation };
}

export function applyGrants({ grants, approvedDirs, runFile = shellRunFile, log = () => {} }) {
  return changeGrants({ grants, approvedDirs, runFile, log, revoke: false });
}

export async function revokeGrants({ paths, approvedDirs, runFile = shellRunFile, log = () => {} }) {
  const result = await changeGrants({ grants: paths.map(dir => ({ path: dir })), approvedDirs, runFile, log, revoke: true });
  return { ok: result.ok, removed: result.applied.map(g => g.path), failed: result.failed };
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
