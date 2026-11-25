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
import os from 'os';
import path from 'path';
import { randomUUID } from 'node:crypto';

import { run as shellRun, runFile as shellRunFile } from '../shell.js';
import { WINDOWS_SC, programDataDir, windowsCurrentUserCmd } from '../platform.js';
import {
  aclAceIsInherited,
  aclEntryAllowsFullControl,
  aclEntryAllowsReadExecute,
  aclEntryExcessPermission,
  checkedAclDirectory,
  parseIcaclsListing,
  systemTool,
  walkAclTree,
} from './acl.js';
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
 * The Windows defaults for the service's DACL. A descriptor we write always
 * carries both: losing them is what made an elevated administrator unable to
 * read the wrapper or start the service.
 */
export const SERVICE_SYSTEM_DEFAULT = '(A;;CCLCSWRPWPDTLOCRRC;;;SY)';
export const SERVICE_ADMINS_DEFAULT = '(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)';

const SERVICE_SYSTEM_RIGHTS = ['CC', 'LC', 'SW', 'RP', 'WP', 'DT', 'LO', 'CR', 'RC'];
const SERVICE_ADMINS_RIGHTS = ['CC', 'DC', 'LC', 'SW', 'RP', 'WP', 'DT', 'LO', 'CR', 'SD', 'RC', 'WD', 'WO'];

/** The two-letter rights an ACE grants, or null when it cannot be read. */
function aceRights(mask) {
  const value = String(mask ?? '').toUpperCase();
  if (value === 'GA' || value === 'FA') return { all: true, rights: [] };
  // A hex mask carries the same rights in a form we do not decode. Treating it
  // as unknown adds the explicit default, which can never lose access.
  if (/^0X/i.test(value)) return null;
  return { all: false, rights: value.match(/[A-Z]{2}/g) ?? [] };
}

function aceAllows(ace, trustee, required) {
  if (!ace.startsWith('(A;')) return false;
  if (aceTrustee(ace).toUpperCase() !== trustee) return false;
  const rights = aceRights(ace.slice(1, -1).split(';')[2]);
  if (!rights) return false;
  return rights.all || required.every((code) => rights.rights.includes(code));
}

/**
 * Which Windows defaults an SDDL descriptor is missing: `SY`, `BA`, or both.
 * An empty array means the descriptor is safe to write.
 *
 * @param {string} sddl
 * @returns {string[]}
 */
export function missingServiceDefaults(sddl) {
  const parts = splitDacl(sddl ?? '');
  if (!parts) return ['SY', 'BA'];
  const missing = [];
  if (!parts.aces.some((ace) => aceAllows(ace, 'SY', SERVICE_SYSTEM_RIGHTS))) missing.push('SY');
  if (!parts.aces.some((ace) => aceAllows(ace, 'BA', SERVICE_ADMINS_RIGHTS))) missing.push('BA');
  return missing;
}

/**
 * The descriptor with any missing Windows default ACE added. Every other ACE
 * and the SACL tail are kept byte-for-byte.
 *
 * @param {string} sddl
 * @returns {string}
 */
export function withServiceDefaults(sddl) {
  const parts = splitDacl(sddl ?? '');
  if (!parts) throw new Error('the service security descriptor has no DACL');
  const missing = missingServiceDefaults(sddl);
  if (missing.length === 0) return sddl;
  const added = [];
  if (missing.includes('SY')) added.push(SERVICE_SYSTEM_DEFAULT);
  if (missing.includes('BA')) added.push(SERVICE_ADMINS_DEFAULT);
  return `${parts.head}${parts.aces.join('')}${added.join('')}${parts.tail}`;
}

const SDDL_SAFE = /^[A-Za-z0-9:;()-]+$/;

/**
 * Writes one descriptor with direct `sc.exe sdset` argv and reads it back.
 * Refuses to send anything that is not plain SDDL, and never returns success
 * unless the read-back still carries both Windows defaults.
 *
 * @returns {Promise<{ ok: boolean, sddl?: string, reason?: string }>}
 */
async function writeServiceDescriptor(sddl, { run, runFile }) {
  if (typeof sddl !== 'string' || !SDDL_SAFE.test(sddl)) {
    return { ok: false, reason: 'the service permissions contained unexpected characters; nothing was changed' };
  }
  const result = await runFile(systemTool(WINDOWS_SC), ['sdset', SERVICE_ID, sddl], { timeout: 20_000 });
  if (!result.success) {
    return {
      ok: false,
      reason: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(0, 300) || 'sc.exe sdset failed',
    };
  }
  const readback = await readServiceSddl({ run, runFile });
  if (!readback) {
    return { ok: false, written: true, reason: 'the service descriptor could not be read back after it was written' };
  }
  const missing = missingServiceDefaults(readback);
  if (missing.length) {
    return {
      ok: false,
      written: true,
      reason: `the written service descriptor lost ${missing.join(' and ')} access; `
        + 'it was not accepted',
    };
  }
  return { ok: true, sddl: readback };
}

/** Writes the previous descriptor back with the defaults it must never lose. */
async function rollbackServiceDescriptor(current, { run, runFile }) {
  let target;
  try {
    target = withServiceDefaults(current);
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  return writeServiceDescriptor(target, { run, runFile });
}

/**
 * Lets `sid` start, stop and query the service. Needs elevation.
 *
 * The computed DACL always keeps (or gains) the Windows defaults for SYSTEM
 * and Administrators, and the user's start/stop ACE is added on top.
 *
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function grantServiceControl({ sid, run = shellRun, runFile = shellRunFile } = {}) {
  if (!isAccountSid(sid)) return { ok: false, reason: 'no user account to grant it to' };

  const current = await readServiceSddl({ run, runFile });
  if (!current) return { ok: false, reason: `could not read the ${SERVICE_ID} service permissions` };

  let next;
  try {
    next = withServiceDefaults(withOperatorAce(current, sid));
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  if (!SDDL_SAFE.test(next)) {
    return { ok: false, reason: 'the service permissions contained unexpected characters; nothing was changed' };
  }

  const written = await writeServiceDescriptor(next, { run, runFile });
  if (!written.ok) {
    if (!written.written) return { ok: false, reason: written.reason };
    const restored = await rollbackServiceDescriptor(current, { run, runFile });
    return {
      ok: false,
      reason: 'The service descriptor lost SYSTEM or Administrators access when it was written. '
        + (restored.ok ? 'Previous descriptor restored.'
          : `Previous descriptor could not be restored: ${restored.reason}`),
    };
  }

  const after = operatorAceState(written.sddl, sid);
  if (after.granted && !after.excessive) return { ok: true };

  // The ACE did not read back as intended. Put the previous descriptor back,
  // with the defaults it must never lose, and verify that too.
  const restored = await rollbackServiceDescriptor(current, { run, runFile });
  return {
    ok: false,
    reason: 'The service descriptor does not read back as expected. '
      + (restored.ok ? 'Previous descriptor restored.'
        : `Previous descriptor could not be restored: ${restored.reason}`),
  };
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

  let target;
  try {
    // Even a removal never writes a descriptor without the Windows defaults.
    target = withServiceDefaults(next.sddl);
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  if (!SDDL_SAFE.test(target)) {
    return { ok: false, reason: 'the service permissions contained unexpected characters; nothing was changed' };
  }

  const written = await writeServiceDescriptor(target, { run, runFile });
  if (!written.ok) {
    if (!written.written) return { ok: false, reason: written.reason };
    const restored = await restoreServiceControl({ sid, sddl: current, run, runFile });
    return {
      ok: false,
      reason: 'The service descriptor lost SYSTEM or Administrators access when it was written. '
        + (restored.ok ? 'Previous descriptor restored.' : restored.reason),
    };
  }
  if (operatorAceState(written.sddl, sid).granted === false) {
    return { ok: true, changed: true, previousSddl: current };
  }

  const restored = await restoreServiceControl({ sid, sddl: current, run, runFile });
  return { ok: false, reason: 'Revoked service permissions did not read back. '
    + (restored.ok ? 'Previous descriptor restored.' : restored.reason) };
}

/** Restore the exact DACL read before a temporary operator hold. */
export async function restoreServiceControl({
  sid,
  sddl,
  run = shellRun,
  runFile = shellRunFile,
} = {}) {
  if (!isAccountSid(sid)) return { ok: false, reason: 'no user account to restore' };
  if (typeof sddl !== 'string' || !SDDL_SAFE.test(sddl)) {
    return { ok: false, reason: 'the saved service permissions are not valid SDDL; nothing was changed' };
  }
  if (!operatorAceState(sddl, sid).granted) {
    return { ok: false, reason: 'the saved service permissions do not contain the expected operator grant' };
  }

  let target;
  try {
    target = withServiceDefaults(sddl);
  } catch (error) {
    return { ok: false, reason: error.message };
  }

  const written = await writeServiceDescriptor(target, { run, runFile });
  if (!written.ok) return { ok: false, reason: written.reason };
  return operatorAceState(written.sddl, sid).granted
    ? { ok: true }
    : { ok: false, reason: 'the service DACL was written but the operator grant did not read back' };
}

/**
 * Makes sure the service descriptor carries the Windows defaults, without
 * touching any other ACE. Used by `ezz service recover` when the installing
 * account cannot be identified (or has no grant to renew).
 *
 * @returns {Promise<{ ok: boolean, reason?: string, changed?: boolean }>}
 */
export async function ensureServiceDefaults({ run = shellRun, runFile = shellRunFile } = {}) {
  const current = await readServiceSddl({ run, runFile });
  if (!current) return { ok: false, reason: `could not read the ${SERVICE_ID} service permissions` };
  let target;
  try {
    target = withServiceDefaults(current);
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  if (target === current) return { ok: true, changed: false };
  const written = await writeServiceDescriptor(target, { run, runFile });
  return written.ok ? { ok: true, changed: true } : { ok: false, reason: written.reason };
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
 * Whether `dir` is one of the machine's executable roots. Those are protected
 * differently: a constant number of icacls calls for the whole tree, never one
 * per file, and never a window in which a file has an empty DACL.
 */
function isServiceCodeRoot(dir) {
  const base = programDataDir();
  const target = path.win32.resolve(dir);
  return ['bin', 'runtime', 'runtime.prev'].some((name) =>
    path.win32.resolve(path.win32.join(base, name)) === target);
}

/** Trustees as icacls prints them, including SID form on localized Windows. */
const SYSTEM_TRUSTEES = ['NT AUTHORITY\\SYSTEM', 'SYSTEM', 'S-1-5-18', '*S-1-5-18'];
const ADMIN_TRUSTEES = ['BUILTIN\\Administrators', 'Administrators', 'S-1-5-32-544', '*S-1-5-32-544'];
const USERS_TRUSTEES = ['BUILTIN\\Users', 'Users', 'S-1-5-32-545', '*S-1-5-32-545'];
const SERVICE_TRUSTEES = [SERVICE_ACCOUNT];

function normalizeTrustee(value) {
  return String(value ?? '').trim().replace(/^\*/, '').toUpperCase();
}

/** The trustee exactly as icacls printed it, if it is safe as one argv value. */
function removableTrustee(trustee) {
  const value = String(trustee ?? '').trim();
  if (!value || /["\x00-\x1f]/.test(value)) return null;
  return value;
}

/**
 * Removes every explicit ACE on the folder for an account that is not SYSTEM,
 * Administrators, Users or the service account.
 *
 * `/grant:r` replaces only the trustees it names, so an explicit
 * `Everyone:(OI)(CI)F` from an earlier install would otherwise survive and give
 * that account write access to code the service runs.
 *
 * @returns {Promise<{ ok: boolean, removed?: string[], reason?: string }>}
 */
export async function removeUnapprovedCodeRootAces({ dir, runFile }) {
  const icacls = systemTool('icacls.exe');
  const read = await runFile(icacls, [dir], { timeout: 120_000 });
  if (!read.success) {
    return { ok: false, reason: `could not read the folder permissions: ${icaclsOutput(read).slice(0, 200)}` };
  }
  const entries = parseIcaclsListing(read.stdout);
  const folder = entries.find((entry) => samePath(entry.path, dir)) ?? entries[0];
  if (!folder) return { ok: false, reason: `the read-back of ${dir} contained no entry for the folder` };

  const allowed = new Set([
    ...SYSTEM_TRUSTEES, ...ADMIN_TRUSTEES, ...USERS_TRUSTEES, ...SERVICE_TRUSTEES,
  ].map(normalizeTrustee));
  const removed = [];
  const seen = new Set();
  for (const ace of folder.aces) {
    if (aclAceIsInherited(ace)) continue;
    const trustee = removableTrustee(ace.trustee);
    if (!trustee) {
      return { ok: false, reason: `refusing an unusual trustee on ${dir}: ${JSON.stringify(ace.trustee)}` };
    }
    const key = normalizeTrustee(trustee);
    if (allowed.has(key) || seen.has(key)) continue;
    seen.add(key);
    const result = await runFile(icacls, [dir, '/remove:g', trustee, '/L', '/Q'], { timeout: 120_000 });
    if (!result.success) {
      return { ok: false, reason: `could not remove ${trustee} from ${dir}: ${icaclsOutput(result).slice(0, 200)}` };
    }
    removed.push(trustee);
  }
  return { ok: true, removed };
}

function icaclsOutput(result) {
  return `${result?.stdout ?? ''}${result?.stderr ?? ''}`.trim();
}

function isAccessDenied(result) {
  return /access is denied/i.test(icaclsOutput(result));
}

function samePath(left, right) {
  return path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
}

/**
 * Reads a protected tree back and checks every entry: a non-empty DACL with
 * SYSTEM and Administrators full control, and the service account able to read
 * and execute when it is registered.
 *
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function verifyServiceCodeRoot({ dir, serviceAccount, runFile }) {
  const icacls = systemTool('icacls.exe');
  const children = path.win32.join(dir, '*');
  const folder = await runFile(icacls, [dir], { timeout: 120_000 });
  if (!folder.success) return { ok: false, reason: `could not read back ${dir}: ${icaclsOutput(folder).slice(0, 200)}` };
  const listing = await runFile(icacls, [children, '/T', '/C'], { timeout: 600_000 });
  if (!listing.success) {
    return { ok: false, reason: `could not read back the files under ${dir}: ${icaclsOutput(listing).slice(0, 200)}` };
  }

  const entries = [...parseIcaclsListing(folder.stdout), ...parseIcaclsListing(listing.stdout)];
  if (entries.length === 0) return { ok: false, reason: `the read-back of ${dir} contained no entries` };

  const serviceTrustees = [SERVICE_ACCOUNT];
  for (const entry of entries) {
    if (entry.aces.length === 0) {
      return { ok: false, reason: `${entry.path} has an empty ACL` };
    }
    if (!aclEntryAllowsFullControl(entry, SYSTEM_TRUSTEES)) {
      return { ok: false, reason: `${entry.path} does not give SYSTEM full control` };
    }
    if (!aclEntryAllowsFullControl(entry, ADMIN_TRUSTEES)) {
      return { ok: false, reason: `${entry.path} does not give Administrators full control` };
    }
    if (serviceAccount && !aclEntryAllowsReadExecute(entry, serviceTrustees)) {
      return { ok: false, reason: `${entry.path} cannot be read by ${SERVICE_ACCOUNT}` };
    }
    const excess = aclEntryExcessPermission(entry, [...SYSTEM_TRUSTEES, ...ADMIN_TRUSTEES]);
    if (excess) {
      return {
        ok: false,
        reason: `${entry.path} gives ${excess.trustee} more than read and execute `
          + `(${excess.permissions.join('')})`,
      };
    }
  }

  // The three files whose unreadable DACLs broke real servers: when they exist
  // they must be present in the read-back and pass the same checks.
  const probes = [path.win32.join(dir, 'EasyDevOps.exe'), path.win32.join(dir, 'node.exe'),
    path.win32.join(dir, 'app', 'src', 'cli', 'index.js')];
  for (const probe of probes) {
    if (!fs.existsSync(probe)) continue;
    const entry = entries.find((candidate) => samePath(candidate.path, probe));
    if (!entry) return { ok: false, reason: `${probe} is missing from the read-back` };
    if (!aclEntryAllowsFullControl(entry, SYSTEM_TRUSTEES)
        || !aclEntryAllowsFullControl(entry, ADMIN_TRUSTEES)
        || (serviceAccount && !aclEntryAllowsReadExecute(entry, serviceTrustees))) {
      return { ok: false, reason: `${probe} does not keep SYSTEM, Administrators and the service account` };
    }
  }
  return { ok: true };
}

/**
 * Protects one executable root with a constant number of icacls calls.
 *
 * Order is deliberate: the folder's explicit grants are written BEFORE
 * inheritance is removed, so it is never empty; the children are then reset so
 * they inherit that list instead of keeping whatever a previous run left. On
 * any failure the saved tree is restored and the caller gets one clear message.
 *
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function protectCodeRoot(dir, { serviceAccount, runFile }) {
  const icacls = systemTool('icacls.exe');
  const target = safePath(dir);
  const children = path.win32.join(target, '*');
  const parent = path.dirname(target);
  const saved = path.join(os.tmpdir(), `ez-acl-${process.pid}-${randomUUID()}.acl`);
  const scope = ['/L', '/Q'];
  const grants = [
    `${SID_SYSTEM}:(OI)(CI)F`,
    `${SID_ADMINISTRATORS}:(OI)(CI)F`,
    `${SID_USERS}:(OI)(CI)RX`,
    ...(serviceAccount ? [`${SERVICE_ACCOUNT}:(OI)(CI)RX`] : []),
  ];

  let step = 'saving the current permissions';
  const run = (args, timeout = 600_000) => runFile(icacls, args, { timeout });

  try {
    const save = await run([target, '/save', saved, '/T', '/C', ...scope]);
    if (!save.success) throw new Error(`saving the current permissions failed: ${icaclsOutput(save).slice(0, 200)}`);

    step = 'taking ownership for Administrators';
    const owner = await run([target, '/setowner', SID_ADMINISTRATORS, ...scope]);
    if (!owner.success) throw new Error(`taking ownership failed: ${icaclsOutput(owner).slice(0, 200)}`);

    step = 'granting SYSTEM, Administrators, Users and the service account';
    // Grant first, remove inheritance second: the folder is never left empty.
    const grant = await run([target, '/grant:r', ...grants, ...scope]);
    if (!grant.success) throw new Error(`granting access failed: ${icaclsOutput(grant).slice(0, 200)}`);

    step = 'removing inheritance from the folder';
    const inherit = await run([target, '/inheritance:r', ...scope]);
    if (!inherit.success) throw new Error(`removing inheritance failed: ${icaclsOutput(inherit).slice(0, 200)}`);

    step = 'removing unapproved explicit permissions';
    const cleaned = await removeUnapprovedCodeRootAces({ dir: target, runFile });
    if (!cleaned.ok) throw new Error(cleaned.reason);

    step = 'resetting the files so they inherit from the folder';
    let reset = await run([children, '/reset', '/T', '/C', ...scope]);
    if (!reset.success && isAccessDenied(reset)) {
      step = 'taking ownership of the files';
      const take = await run([children, '/setowner', SID_ADMINISTRATORS, '/T', '/C', ...scope]);
      if (!take.success) throw new Error(`taking ownership of the files failed: ${icaclsOutput(take).slice(0, 200)}`);
      step = 'resetting the files so they inherit from the folder';
      reset = await run([children, '/reset', '/T', '/C', ...scope]);
    }
    if (!reset.success) throw new Error(`resetting the files failed: ${icaclsOutput(reset).slice(0, 200)}`);

    step = 'verifying the new permissions';
    const verified = await verifyServiceCodeRoot({ dir: target, serviceAccount, runFile });
    if (!verified.ok) throw new Error(verified.reason);
  } catch (error) {
    let restored = false;
    try {
      const result = await run([parent, '/restore', saved, '/C', ...scope]);
      restored = result.success;
    } catch { /* reported below */ }
    return {
      ok: false,
      reason: `${target}: ${step} failed: ${error.message}. `
        + (restored ? 'The previous permissions were restored.' : 'The previous permissions could not be restored.')
        + ' Run `ezz service recover` from an Administrator PowerShell.',
    };
  } finally {
    try { fs.rmSync(saved, { force: true }); } catch { /* a temp file is not worth failing over */ }
  }
  return { ok: true };
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
      if (isServiceCodeRoot(dir)) {
        // A missing root is reported, never created here.
        let stat = null;
        try {
          stat = fs.lstatSync(dir, { throwIfNoEntry: false }) ?? null;
        } catch (err) {
          throw new Error(`could not inspect the directory: ${err.code ?? err.message}`);
        }
        if (!stat) throw new Error('the directory does not exist');
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error('refusing a reparse point or non-directory');
        }
        const result = await protectCodeRoot(dir, { serviceAccount, runFile });
        if (!result.ok) throw new Error(result.reason);
        done.push(dir);
        log(`  ${dir}: administrators only (read & execute for the service and users); `
          + 'every file inherits it and was verified');
        continue;
      }
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
      log(`  ${dir}: could not be protected: ${error}`);
    } else {
      done.push(dir);
      if (!isServiceCodeRoot(dir)) {
        log(`  ${dir}: administrators only (${usersRead ? 'read & execute for the service and users' : `${
          serviceAccess === 'M' ? 'modify' : 'read & execute'
        } for the service`})`);
      }
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
