/**
 * core/service/operator.js
 *
 * Windows Server mode: what the INSTALLING USER may do without elevation.
 *
 * Server mode needs an Administrator terminal for anything that replaces the
 * service's files. It should not need one to start or stop the service, or to
 * run `ezz hub status` against the shared database. So install and repair give
 * exactly one account — the one that installed it, by SID — two things:
 *
 *   1. On the service's own DACL: start, stop and query (`CC LC LO RP WP`).
 *      Not change its configuration (DC), not delete it (SD), not rewrite its
 *      permissions (WD) or take ownership (WO). Those stay with Administrators.
 *   2. Modify on the data directory, so the CLI can write the database a
 *      service account also writes. Without it every write from a normal
 *      terminal failed with "SqliteError: attempt to write a readonly database".
 *
 * ── Why never Users or Everyone ────────────────────────────────────────────
 *
 * The grant is for a person, not for whoever logs on to the server. Only an
 * account SID is accepted (S-1-5-21-…, a local or domain user; S-1-12-1-…, an
 * Entra ID user); well-known groups are refused by shape, so no code path can
 * be talked into granting Users (S-1-5-32-545) or Everyone (S-1-1-0).
 *
 * ── Why the runtime and the wrapper are protected ──────────────────────────
 *
 * Both live INSIDE the data directory (`runtime\`, `bin\`), so the data grant
 * would otherwise be inherited by them — and replacing node.exe or
 * EasyDevOps.exe would run that user's code as NT SERVICE\EasyDevOps. Those two
 * folders stop inheriting and get an explicit list instead: SYSTEM and
 * Administrators full control, Users and the service account read & execute.
 * A deny entry would have been shorter and wrong: the same SID is in the
 * user's ELEVATED token too, so it would also lock out `ezz update`.
 *
 * Every command here goes through shell.js and is injectable, so tests drive a
 * stub and assert the exact commands rather than touching real ACLs.
 */

import fs from 'fs';
import path from 'path';

import { run as shellRun, runFile as shellRunFile } from '../shell.js';
import { WINDOWS_SC, programDataDir, windowsCurrentUserCmd } from '../platform.js';
import { checkedAclDirectory, systemTool, walkAclTree } from './acl.js';
import { SERVICE_ID, SERVICE_ACCOUNT } from './winsw.js';
import {
  UNINSTALL_STAGE_TIMEOUT_MS,
  remainingStageMs,
} from './stageTimeout.js';

/** Set by the relaunch, so the elevated copy grants the user who asked — see cli/elevation.js. */
export const OPERATOR_SID_ENV = 'EZ_OPERATOR_SID';

/** Start, stop, query status, query config, interrogate. Nothing that changes the service. */
export const OPERATOR_SERVICE_RIGHTS = 'CCLCLORPWP';

/** Rights an operator ACE must never carry: change config, delete, write DAC, write owner, all access. */
const FORBIDDEN_RIGHTS = ['DC', 'SD', 'WD', 'WO', 'GA', 'GW', 'FA'];

/**
 * Whether `sid` names one account (a user), not a group or a well-known SID.
 *
 * @param {unknown} sid
 * @returns {boolean}
 */
export function isAccountSid(sid) {
  return typeof sid === 'string'
    && (/^S-1-5-21-\d{1,10}-\d{1,10}-\d{1,10}-\d{1,10}$/.test(sid)
      || /^S-1-12-1-\d{1,10}-\d{1,10}-\d{1,10}-\d{1,10}$/.test(sid));
}

/**
 * The account this process runs as.
 *
 * @returns {Promise<{ sid: string, name: string|null }|null>}
 */
export async function currentUser({ run = shellRun } = {}) {
  const result = await run(windowsCurrentUserCmd(), { timeout: 20_000 });
  const line = `${result?.stdout ?? ''}`.trim().split(/\r?\n/).pop() ?? '';
  const [sid, name] = line.split('|');
  if (!isAccountSid(sid?.trim())) return null;
  return { sid: sid.trim(), name: name?.trim() || null };
}

/**
 * Who the operator grants are for.
 *
 * The relaunch passes the SID of the user who asked for it; that is who
 * installed the service even when the elevated window runs under a different
 * administrator account. Otherwise it is this process's own account — the
 * usual case, where the same person ran PowerShell "as administrator".
 *
 * @returns {Promise<{ sid: string, name: string|null, via: 'relaunch'|'current' }|null>}
 */
export async function resolveOperator({ run = shellRun, env = process.env } = {}) {
  const me = await currentUser({ run });
  const passed = env?.[OPERATOR_SID_ENV];
  if (isAccountSid(passed)) {
    return { sid: passed, name: me?.sid === passed ? me.name : null, via: 'relaunch' };
  }
  return me ? { ...me, via: 'current' } : null;
}

// ─── The service DACL ────────────────────────────────────────────────────────

/**
 * Splits an SDDL string into its DACL and the rest.
 *
 * @param {string} sddl
 * @returns {{ head: string, aces: string[], tail: string }|null}
 */
function splitDacl(sddl) {
  const match = /^(.*?D:[A-Z]*)((?:\([^()]*\))*)(.*)$/s.exec(sddl);
  if (!match) return null;
  const aces = match[2].match(/\([^()]*\)/g) ?? [];
  return { head: match[1], aces, tail: match[3] };
}

/** The trustee field of one ACE, `(type;flags;rights;object;inherit;trustee)`. */
function aceTrustee(ace) {
  return ace.slice(1, -1).split(';')[5] ?? '';
}

/**
 * The SDDL with exactly one operator ACE for `sid`, appended to the DACL.
 *
 * Any earlier ACE for the same SID is removed first, so a repair cannot stack
 * grants. Allow ACEs go after the existing ones, which keeps the DACL in
 * canonical order (explicit denies first).
 *
 * @param {string} sddl
 * @param {string} sid
 * @returns {string}
 */
export function withOperatorAce(sddl, sid) {
  if (!isAccountSid(sid)) throw new Error(`not an account SID: ${sid}`);
  const parts = splitDacl(sddl);
  if (!parts) throw new Error('the service security descriptor has no DACL');
  if (parts.aces.some((ace) => ace.startsWith('(D;')
      && aceTrustee(ace).toUpperCase() === sid.toUpperCase())) {
    throw new Error('the service DACL explicitly denies this account; remove that policy instead of weakening it');
  }
  const kept = parts.aces.filter((ace) => aceTrustee(ace).toUpperCase() !== sid.toUpperCase());
  return `${parts.head}${kept.join('')}(A;;${OPERATOR_SERVICE_RIGHTS};;;${sid})${parts.tail}`;
}

/** Remove the operator's allow ACEs while preserving an explicit deny. */
export function withoutOperatorAce(sddl, sid) {
  if (!isAccountSid(sid)) throw new Error(`not an account SID: ${sid}`);
  const parts = splitDacl(sddl);
  if (!parts) throw new Error('the service security descriptor has no DACL');
  const removed = parts.aces.some((ace) => ace.startsWith('(A;')
    && aceTrustee(ace).toUpperCase() === sid.toUpperCase());
  return {
    sddl: `${parts.head}${parts.aces
      .filter((ace) => !ace.startsWith('(A;')
        || aceTrustee(ace).toUpperCase() !== sid.toUpperCase())
      .join('')}${parts.tail}`,
    changed: removed,
  };
}

/**
 * Whether the SDDL lets `sid` start and stop the service, and nothing more.
 *
 * @returns {{ granted: boolean, excessive: boolean }}
 */
export function operatorAceState(sddl, sid) {
  const parts = splitDacl(sddl ?? '');
  if (!parts || !isAccountSid(sid)) return { granted: false, excessive: false };
  const mine = parts.aces.filter((ace) => aceTrustee(ace).toUpperCase() === sid.toUpperCase()
    && ace.startsWith('(A;'));
  const fields = mine.map((ace) => ace.slice(1, -1).split(';')[2] ?? '');
  // SDDL service rights are two-letter codes. A hex mask (0x…) cannot be read
  // that way, so it counts as granting too much rather than as fine.
  const hex = fields.some((field) => /^0x/i.test(field));
  const codes = fields.flatMap((field) => (/^0x/i.test(field) ? [] : field.match(/[A-Z]{2}/g) ?? []));
  return {
    granted: ['RP', 'WP', 'LC'].every((code) => codes.includes(code)),
    excessive: hex || FORBIDDEN_RIGHTS.some((code) => codes.includes(code)),
  };
}

/** `sc.exe sdshow`, the DACL line only. Production always uses direct argv. */
export async function readServiceSddl({
  run = shellRun,
  runFile = shellRunFile,
} = {}) {
  const result = run !== shellRun
    ? await run(`${WINDOWS_SC} sdshow ${SERVICE_ID}`, { timeout: 20_000 })
    : await runFile(systemTool(WINDOWS_SC), ['sdshow', SERVICE_ID], { timeout: 20_000 });
  const line = `${result?.stdout ?? ''}`.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith('D:'));
  return line ?? null;
}

/**
 * Lets `sid` start, stop and query the service. Needs elevation.
 *
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function grantServiceControl({ sid, run = shellRun, runFile = shellRunFile } = {}) {
  if (!isAccountSid(sid)) return { ok: false, reason: 'no user account to grant it to' };

  const current = await readServiceSddl({ run, runFile });
  if (!current) return { ok: false, reason: `could not read the ${SERVICE_ID} service permissions` };

  let next;
  try {
    next = withOperatorAce(current, sid);
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  // Only the supported SDDL grammar is accepted;
  // anything else means it was not read correctly, and it is not sent.
  if (!/^[A-Za-z0-9:;()-]+$/.test(next)) {
    return { ok: false, reason: 'the service permissions contained unexpected characters; nothing was changed' };
  }

  const result = await runFile(systemTool(WINDOWS_SC), ['sdset', SERVICE_ID, next], { timeout: 20_000 });
  if (!result.success) {
    return { ok: false, reason: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(0, 300) || 'sc.exe sdset failed' };
  }

  const after = operatorAceState(await readServiceSddl({ run, runFile }), sid);
  return after.granted && !after.excessive
    ? { ok: true }
    : { ok: false, reason: 'the permission was written but does not read back as expected' };
}

/**
 * Temporarily removes the installing account's start/stop ACE before an
 * uninstall recursively changes data permissions. An account with service
 * control could otherwise start the stopped service while the elevated
 * operation is walking the tree.
 */
export async function revokeServiceControl({
  sid,
  run = shellRun,
  runFile = shellRunFile,
} = {}) {
  if (!isAccountSid(sid)) return { ok: true, changed: false };

  const current = await readServiceSddl({ run, runFile });
  if (!current) return { ok: false, reason: `could not read the ${SERVICE_ID} service permissions` };

  let next;
  try {
    next = withoutOperatorAce(current, sid);
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  if (!next.changed) return { ok: true, changed: false };
  if (!/^[A-Za-z0-9:;()-]+$/.test(next.sddl)) {
    return { ok: false, reason: 'the service permissions contained unexpected characters; nothing was changed' };
  }

  const written = await runFile(systemTool(WINDOWS_SC), [
    'sdset', SERVICE_ID, next.sddl,
  ], { timeout: 20_000 });
  if (!written.success) {
    return {
      ok: false,
      reason: `${written.stdout ?? ''}${written.stderr ?? ''}`.trim().slice(0, 300)
        || 'sc.exe sdset failed',
    };
  }
  const after = operatorAceState(await readServiceSddl({ run, runFile }), sid);
  return after.granted
    ? { ok: false, reason: 'the permission was removed but the service DACL still grants it' }
    : { ok: true, changed: true, previousSddl: current };
}

/** Restore the exact DACL read before a temporary operator hold. */
export async function restoreServiceControl({
  sid,
  sddl,
  run = shellRun,
  runFile = shellRunFile,
} = {}) {
  if (!isAccountSid(sid)) return { ok: false, reason: 'no user account to restore' };
  if (typeof sddl !== 'string' || !/^[A-Za-z0-9:;()-]+$/.test(sddl)) {
    return { ok: false, reason: 'the saved service permissions are not valid SDDL; nothing was changed' };
  }
  if (!operatorAceState(sddl, sid).granted) {
    return { ok: false, reason: 'the saved service permissions do not contain the expected operator grant' };
  }

  const written = await runFile(systemTool(WINDOWS_SC), [
    'sdset', SERVICE_ID, sddl,
  ], { timeout: 20_000 });
  if (!written.success) {
    return {
      ok: false,
      reason: `${written.stdout ?? ''}${written.stderr ?? ''}`.trim().slice(0, 300)
        || 'sc.exe sdset failed',
    };
  }
  const after = await readServiceSddl({ run, runFile });
  return after === sddl
    ? { ok: true }
    : { ok: false, reason: 'the service DACL was written but did not read back exactly as saved' };
}

// ─── The data directory ──────────────────────────────────────────────────────

/** Well-known SIDs, so the commands do not depend on the display language. */
const SID_SYSTEM = '*S-1-5-18';
const SID_ADMINISTRATORS = '*S-1-5-32-544';
const SID_USERS = '*S-1-5-32-545';

/**
 * Modify on the data directory, inherited by what it contains.
 *
 * No `/T`: the grant reaches existing files and folders by inheritance, which
 * is exactly what lets the protected folders below opt out of it. `/T` would
 * write it onto every child explicitly, protected or not.
 */
export function buildDataDirGrantCommand(dataDir, sid) {
  return [safePath(dataDir), '/grant', `*${accountSid(sid)}:(OI)(CI)M`, '/L', '/Q'];
}

/**
 * A value that can be passed as one direct argv entry. Native ACL calls never
 * involve a shell, so shell metacharacters such as `$` and backticks are
 * ordinary path characters. Windows cannot represent control characters in a
 * path, so those are refused before the filesystem check.
 */
function safePath(dir) {
  const value = String(dir ?? '');
  if (!value || /["\x00-\x1f]/.test(value)) {
    throw new Error(`refusing an unusual path: ${JSON.stringify(value)}`);
  }
  return value;
}

/** The SID, or a throw: nothing but an account SID is ever written into a grant. */
function accountSid(sid) {
  if (!isAccountSid(sid)) throw new Error(`not an account SID: ${sid}`);
  return sid;
}

/**
 * The commands that make one folder administrator-only to change.
 *
 * A recursive reset first discards explicit ACEs as well as inherited ones.
 * Inheritance is then removed and the approved list replaces the old DACL.
 * Finally, any leftover entry for the operator is removed (a grant from before
 * this protection existed was applied with `/T`).
 *
 * The caller runs this on one exact directory or file, never with `/T`.
 * `replaceInheritance` is true for the root of a tree. Descendants are reset
 * against their already-safe parent and keep inheritance so the later,
 * narrowly scoped data-root grant can still reach ordinary data files while
 * the protected runtime and wrapper roots opt out.
 */
export function buildProtectCommands(
  dir,
  sid = null,
  {
    serviceAccount = true,
    serviceAccess = 'RX',
    usersRead = true,
    objectType = 'directory',
    replaceInheritance = objectType === 'directory',
  } = {},
) {
  const target = safePath(dir);
  if (!['RX', 'M', 'F'].includes(serviceAccess)) {
    throw new Error(`refusing an unusual service access mask: ${String(serviceAccess)}`);
  }
  if (typeof usersRead !== 'boolean') {
    throw new Error('refusing an unusual usersRead value');
  }
  if (!['directory', 'file'].includes(objectType)) {
    throw new Error('refusing an unusual ACL object type');
  }
  if (typeof replaceInheritance !== 'boolean' || (objectType === 'file' && replaceInheritance)) {
    throw new Error('refusing an unusual inheritance setting');
  }
  // Before the service is registered its account does not exist yet, and
  // icacls refuses an unknown name; install protects again once it does.
  const scope = ['/L', '/Q'];
  const propagate = objectType === 'directory' ? '(OI)(CI)' : '';
  const trustees = [`${SID_SYSTEM}:${propagate}F`, `${SID_ADMINISTRATORS}:${propagate}F`];
  if (usersRead) trustees.push(`${SID_USERS}:${propagate}RX`);
  if (serviceAccount) trustees.push(`${SERVICE_ACCOUNT}:${propagate}${serviceAccess}`);
  const commands = [
    [target, '/setowner', SID_ADMINISTRATORS, ...scope],
    // `/grant:r` replaces ACEs only for the trustees it names. Without this
    // reset, an explicit ACE created before installation for Everyone or an
    // arbitrary SID would survive both the inheritance change and the grant.
    [target, '/reset', ...scope],
    replaceInheritance
      ? [target, '/inheritance:r', '/grant:r', ...trustees, ...scope]
      : [target, '/grant:r', ...trustees, ...scope],
  ];
  if (isAccountSid(sid)) commands.push([target, '/remove:g', `*${sid}`, ...scope]);
  return commands;
}

/**
 * Makes the runtime and wrapper folders administrator-only to change.
 *
 * Runs on install and on every repair: a repair replaces the runtime folder
 * with a fresh copy, and a fresh folder inherits again.
 *
 * @param {Object} opts
 * @param {string[]} opts.dirs
 * @param {string|null} [opts.sid]
 * @returns {Promise<{ ok: boolean, protected: string[], failed: Array<{ path: string, reason: string }> }>}
 */
export async function protectServiceFiles({
  dirs,
  sid = null,
  serviceAccount = true,
  serviceAccess = 'RX',
  usersRead = true,
  runFile = shellRunFile,
  log = () => {},
} = {}) {
  const done = [];
  const failed = [];
  for (const dir of dirs) {
    if (!dir) continue;
    let error = null;
    let commands = [];
    try {
      await walkAclTree(dir, async (target, objectType) => {
        const isRoot = path.resolve(target) === path.resolve(dir);
        commands = buildProtectCommands(target, sid, {
          serviceAccount,
          serviceAccess,
          usersRead,
          objectType,
          replaceInheritance: isRoot && objectType === 'directory',
        });
        for (const command of commands) {
          const result = await runFile(systemTool('icacls.exe'), command, { timeout: 120_000 });
          if (!result.success) {
            const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(0, 300);
            throw new Error(output || 'icacls failed');
          }
        }
      }, { runFile });
    } catch (err) {
      error = err.message;
    }
    if (error) {
      failed.push({ path: dir, reason: error });
      log(`  ${dir}: could not be protected`);
    } else {
      done.push(dir);
      log(`  ${dir}: administrators only (${usersRead ? 'read & execute for the service and users' : `${
        serviceAccess === 'M' ? 'modify' : 'read & execute'
      } for the service`})`);
    }
  }
  return { ok: failed.length === 0, protected: done, failed };
}

/**
 * Everything the operator gets, applied in the order that keeps it safe:
 * protect the service's files first, then grant the data directory.
 *
 * @param {Object} opts
 * @param {{ sid: string, name: string|null }|null} opts.operator
 * @param {string} opts.dataDir
 * @param {string[]} opts.protectedDirs  The runtime and wrapper folders
 * @returns {Promise<Object>} the record to keep under `service-state.operator`
 */
export async function grantOperator({ operator, dataDir, approvedDataDir = programDataDir(), protectedDirs, run = shellRun, runFile = shellRunFile, log = () => {} } = {}) {
  // Normalize the ProgramData root first. A standard user can create this
  // directory before installing the service, so inheriting its owner or DACL
  // would leave the database writable by that user. This recursive pass is
  // then followed by the narrower runtime/bin protections below, which restore
  // execute-only access for the service account on executable files.
  const dataProtection = await protectServiceFiles({
    dirs: [dataDir],
    sid: operator?.sid ?? null,
    serviceAccess: 'M',
    usersRead: false,
    runFile,
    log,
  });
  const fileProtection = await protectServiceFiles({
    dirs: protectedDirs,
    sid: operator?.sid ?? null,
    serviceAccess: 'RX',
    usersRead: true,
    runFile,
    log,
  });
  const protection = {
    ok: dataProtection.ok && fileProtection.ok,
    protected: [...dataProtection.protected, ...fileProtection.protected],
    failed: [...dataProtection.failed, ...fileProtection.failed],
  };

  if (!operator || !isAccountSid(operator.sid)) {
    return {
      record: null,
      protection,
      notes: ['could not tell which account ran the install, so nobody was allowed to start or stop the service '
        + 'without elevation'],
    };
  }

  const notes = [];
  const control = await grantServiceControl({ sid: operator.sid, run, runFile });
  if (control.ok) log(`  ${operator.name ?? operator.sid}: may start, stop and restart the service`);
  else notes.push(`start/stop without elevation was not granted: ${control.reason}`);

  // Only once the service's own files are protected: the data grant is
  // inherited, and until then it would have reached them.
  let dataAccess = false;
  if (protection.ok) {
    const result = await runSafely(() => buildDataDirGrantCommand(dataDir, operator.sid), approvedDataDir, runFile, 60_000);
    dataAccess = result.success;
    if (dataAccess) log(`  ${operator.name ?? operator.sid}: may use the data directory without elevation`);
    else notes.push(`data directory access was not granted: ${`${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(0, 200)}`);
  } else {
    // Fail closed. A grant from an earlier install or repair would otherwise
    // still be inherited by a runtime folder that could not be protected.
    await removeOperatorDataAce({
      operator,
      dataDir,
      approvedDataDir,
      runFile,
      log,
    });
    notes.push('the runtime folder could not be protected, so the data directory is not shared with your account; '
      + 'run `ezz service repair` as administrator again');
  }

  return {
    record: {
      sid: operator.sid,
      name: operator.name ?? null,
      serviceControl: control.ok,
      dataDir: dataAccess,
      grantedAt: new Date().toISOString(),
    },
    protection,
    notes,
  };
}

/**
 * Removes the operator's data directory grant. The service DACL entry needs no
 * removal: it belongs to the service and is deleted with it.
 */
export async function revokeOperator({
  operator,
  dataDir,
  approvedDataDir = programDataDir(),
  runFile = shellRunFile,
  log = () => {},
  deadline = Infinity,
  timeoutMs = UNINSTALL_STAGE_TIMEOUT_MS,
  signal,
} = {}) {
  if (!operator || !isAccountSid(operator.sid) || !dataDir) return { ok: true };
  return removeOperatorDataAce({
    operator,
    dataDir,
    approvedDataDir,
    runFile,
    log,
    deadline,
    timeoutMs,
    signal,
  });
}

/**
 * Restore only the root data-directory ACE after a cancelled or keep-data
 * uninstall. It does not recurse: ordinary children inherit this one ACE.
 */
export async function restoreOperatorDataAccess({
  operator,
  dataDir,
  approvedDataDir = programDataDir(),
  runFile = shellRunFile,
  log = () => {},
  deadline = Infinity,
  timeoutMs = UNINSTALL_STAGE_TIMEOUT_MS,
  signal,
} = {}) {
  if (!operator || !isAccountSid(operator.sid) || !dataDir) return { ok: true };
  const relative = path.relative(path.resolve(approvedDataDir), path.resolve(dataDir));
  if (relative !== '') {
    return { ok: false, reason: 'Only the approved service data directory may be changed' };
  }

  const timeout = deadline === Infinity
    ? 60_000
    : remainingStageMs(deadline, 'Restoring installing-account access', timeoutMs);
  const result = await runSafely(
    () => buildDataDirGrantCommand(dataDir, operator.sid),
    approvedDataDir,
    runFile,
    timeout,
    { deadline, timeoutMs, signal },
  );
  if (!result.success) {
    return {
      ok: false,
      reason: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(0, 300)
        || 'the data directory grant failed',
    };
  }
  log(`  ${operator.name ?? operator.sid}: data directory access restored`);
  return { ok: true };
}

/**
 * Removes the one inheritable operator ACE from the approved data root.
 *
 * `grantOperator` writes this ACE only on the root. Removing it there removes
 * the effective inherited access from the tree without launching one process
 * per file. This is a single bounded ACL call during uninstall.
 */
async function removeOperatorDataAce({
  operator,
  dataDir,
  approvedDataDir,
  runFile,
  log,
  deadline,
  timeoutMs,
  signal,
}) {
  if (!operator || !isAccountSid(operator.sid) || !dataDir) return { ok: true };
  const relative = path.relative(path.resolve(approvedDataDir), path.resolve(dataDir));
  if (relative !== '') {
    return { ok: false, reason: 'Only the approved service data directory may be changed' };
  }
  let directory;
  try {
    remainingStageMs(deadline, 'Removing installing-account access', timeoutMs);
    signal?.throwIfAborted();
    directory = await fs.promises.lstat(dataDir);
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true };
    if (error?.code === 'EZ_STAGE_TIMEOUT' || signal?.aborted) throw error;
    return { ok: false, reason: `${dataDir} could not be inspected: ${error.code ?? error.message}` };
  }
  if (!directory) return { ok: true };
  if (directory.isSymbolicLink() || !directory.isDirectory()) {
    return { ok: false, reason: `${dataDir} is a link, reparse point, or non-directory; no permissions were changed` };
  }

  try {
    const canonical = await checkedAclDirectory(dataDir, runFile, false, {
      deadline,
      stage: 'Removing installing-account access',
      timeoutMs,
      signal,
    });
    const timeout = deadline === Infinity
      ? 120_000
      : remainingStageMs(deadline, 'Removing installing-account access', timeoutMs);
    signal?.throwIfAborted();
    const result = await runFile(systemTool('icacls.exe'), [
      canonical, '/remove:g', `*${operator.sid}`, '/L', '/Q',
    ], { timeout });
    remainingStageMs(deadline, 'Removing installing-account access', timeoutMs);
    signal?.throwIfAborted();
    if (!result.success) {
      throw new Error(`${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(0, 300)
        || 'icacls failed');
    }
  } catch (error) {
    if (error?.code === 'EZ_STAGE_TIMEOUT' || signal?.aborted) throw error;
    return { ok: false, reason: error.message };
  }
  log(`  ${operator.name ?? operator.sid}: data directory access removed`);
  return { ok: true };
}

/** Builds a command and runs it; a refused build is a failed result, never a throw. */
async function runSafely(
  build,
  approvedDataDir,
  runFile,
  timeout,
  { deadline = Infinity, timeoutMs = UNINSTALL_STAGE_TIMEOUT_MS, signal } = {},
) {
  let command;
  try {
    command = build();
    if (path.relative(approvedDataDir, command[0]) !== '') throw new Error('Only the approved service data directory may be shared');
    await checkedAclDirectory(command[0], runFile, false, {
      deadline, timeoutMs, signal,
    });
    signal?.throwIfAborted();
  } catch (err) {
    if (err?.code === 'EZ_STAGE_TIMEOUT' || signal?.aborted) throw err;
    return { success: false, stdout: '', stderr: err.message };
  }
  return runFile(systemTool('icacls.exe'), command, { timeout });
}

/**
 * Creates a folder the service will run code from and protects it while it is
 * still empty. With `fresh`, an existing tree is verified and replaced before
 * it is protected. Install uses that for runtime and bin so executable content
 * left by another account can never be merged into the service's runtime.
 *
 * A fresh folder inside the data directory inherits the installing user's
 * Modify grant, so copying first and protecting afterwards would leave a window
 * in which a file could be placed or replaced before the service starts on it.
 *
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function prepareProtectedDir({
  dir,
  sid = null,
  serviceAccount = true,
  fresh = false,
  runFile = shellRunFile,
  fsApi = fs,
  log = () => {},
} = {}) {
  try {
    let before;
    try {
      before = fsApi.lstatSync(dir, { throwIfNoEntry: false }) ?? null;
    } catch (error) {
      if (error?.code === 'ENOENT') before = null;
      else return {
        ok: false,
        reason: `could not ${fresh ? 'replace' : 'create'} ${dir}: ${error.code ?? error.message}`,
      };
    }

    if (before) {
      if (before.isSymbolicLink() || !before.isDirectory()) {
        return {
          ok: false,
          reason: `could not ${fresh ? 'replace' : 'create'} ${dir}: it is a link, reparse point, or non-directory`,
        };
      }
      if (fresh) {
        // Verify the whole tree first, including native reparse attributes.
        // Recursive deletion then cannot be redirected through a link.
        await checkedAclDirectory(dir, runFile, true);
        fsApi.rmSync(dir, { recursive: true, force: true });
      }
    } else {
      await checkedAclDirectory(path.dirname(dir), runFile);
    }

    let afterRemove;
    try {
      afterRemove = fsApi.lstatSync(dir, { throwIfNoEntry: false }) ?? null;
    } catch (error) {
      if (error?.code === 'ENOENT') afterRemove = null;
      else throw error;
    }
    if (!afterRemove) {
      fsApi.mkdirSync(dir, { mode: 0o700 });
    }
    const created = fsApi.lstatSync(dir, { throwIfNoEntry: false });
    if (!created || created.isSymbolicLink() || !created.isDirectory()) {
      throw new Error('the path became a link, reparse point, or non-directory after creation');
    }
  } catch (err) {
    return { ok: false, reason: `could not ${fresh ? 'replace' : 'create'} ${dir}: ${err.message}` };
  }
  const result = await protectServiceFiles({ dirs: [dir], sid, serviceAccount, runFile, log });
  return result.ok ? { ok: true } : { ok: false, reason: result.failed[0]?.reason ?? `could not protect ${dir}` };
}
