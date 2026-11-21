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

import { run as shellRun } from '../shell.js';
import { WINDOWS_SC, windowsCurrentUserCmd } from '../platform.js';
import { SERVICE_ID, SERVICE_ACCOUNT } from './winsw.js';

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
  const kept = parts.aces.filter((ace) => aceTrustee(ace).toUpperCase() !== sid.toUpperCase());
  return `${parts.head}${kept.join('')}(A;;${OPERATOR_SERVICE_RIGHTS};;;${sid})${parts.tail}`;
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

/** `sc.exe sdshow`, the DACL line only. */
export async function readServiceSddl({ run = shellRun } = {}) {
  const result = await run(`${WINDOWS_SC} sdshow ${SERVICE_ID}`, { timeout: 20_000 });
  const line = `${result?.stdout ?? ''}`.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith('D:'));
  return line ?? null;
}

/**
 * Lets `sid` start, stop and query the service. Needs elevation.
 *
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function grantServiceControl({ sid, run = shellRun } = {}) {
  if (!isAccountSid(sid)) return { ok: false, reason: 'no user account to grant it to' };

  const current = await readServiceSddl({ run });
  if (!current) return { ok: false, reason: `could not read the ${SERVICE_ID} service permissions` };

  let next;
  try {
    next = withOperatorAce(current, sid);
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  // The value is passed to a shell. SDDL is letters, digits and `:;()-`;
  // anything else means it was not read correctly, and it is not sent.
  if (!/^[A-Za-z0-9:;()-]+$/.test(next)) {
    return { ok: false, reason: 'the service permissions contained unexpected characters; nothing was changed' };
  }

  const result = await run(`${WINDOWS_SC} sdset ${SERVICE_ID} "${next}"`, { timeout: 20_000 });
  if (!result.success) {
    return { ok: false, reason: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(0, 300) || 'sc.exe sdset failed' };
  }

  const after = operatorAceState(await readServiceSddl({ run }), sid);
  return after.granted && !after.excessive
    ? { ok: true }
    : { ok: false, reason: 'the permission was written but does not read back as expected' };
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
  return `icacls "${safePath(dataDir)}" /grant "*${accountSid(sid)}:(OI)(CI)M" /C /Q`;
}

/** Removes every allow entry for the SID under the data directory. */
export function buildDataDirRevokeCommand(dataDir, sid) {
  return `icacls "${safePath(dataDir)}" /remove:g "*${accountSid(sid)}" /T /C /Q`;
}

/**
 * A path that can sit inside double quotes in a shell command. Windows paths
 * cannot contain `"`, so one that does was not a path; refused rather than
 * escaped. The data directory can come from EASY_DEVOPS_DATA_DIR.
 */
function safePath(dir) {
  const value = String(dir ?? '');
  if (!value || /["\r\n`$]/.test(value)) throw new Error(`refusing an unusual path: ${JSON.stringify(value)}`);
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
 * Inheritance off, then an explicit list replacing whatever was there, then
 * any leftover entry for the operator removed (a grant from before this
 * protection existed was applied with `/T`).
 */
export function buildProtectCommands(dir, sid = null, { serviceAccount = true } = {}) {
  const target = safePath(dir);
  // Before the service is registered its account does not exist yet, and
  // icacls refuses an unknown name; install protects again once it does.
  const service = serviceAccount ? ` "${SERVICE_ACCOUNT}:(OI)(CI)RX"` : '';
  const commands = [
    // Administrators own it, so no other account holds the owner's implicit
    // right to rewrite its permissions.
    `icacls "${target}" /setowner "${SID_ADMINISTRATORS}" /T /C /Q`,
    `icacls "${target}" /inheritance:r /grant:r "${SID_SYSTEM}:(OI)(CI)F" "${SID_ADMINISTRATORS}:(OI)(CI)F" `
      + `"${SID_USERS}:(OI)(CI)RX"${service} /T /C /Q`,
  ];
  if (isAccountSid(sid)) commands.push(`icacls "${target}" /remove:g "*${sid}" /T /C /Q`);
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
export async function protectServiceFiles({ dirs, sid = null, serviceAccount = true, run = shellRun, log = () => {} } = {}) {
  const done = [];
  const failed = [];
  for (const dir of dirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    let error = null;
    let commands = [];
    try {
      commands = buildProtectCommands(dir, sid, { serviceAccount });
    } catch (err) {
      error = err.message;
    }
    for (const command of commands) {
      const result = await run(command, { timeout: 120_000 });
      if (!result.success) {
        error = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(0, 300) || 'icacls failed';
        break;
      }
    }
    if (error) {
      failed.push({ path: dir, reason: error });
      log(`  ${dir}: could not be protected`);
    } else {
      done.push(dir);
      log(`  ${dir}: administrators only (read & execute for the service and users)`);
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
export async function grantOperator({ operator, dataDir, protectedDirs, run = shellRun, log = () => {} } = {}) {
  const protection = await protectServiceFiles({ dirs: protectedDirs, sid: operator?.sid ?? null, run, log });

  if (!operator || !isAccountSid(operator.sid)) {
    return {
      record: null,
      protection,
      notes: ['could not tell which account ran the install, so nobody was allowed to start or stop the service '
        + 'without elevation'],
    };
  }

  const notes = [];
  const control = await grantServiceControl({ sid: operator.sid, run });
  if (control.ok) log(`  ${operator.name ?? operator.sid}: may start, stop and restart the service`);
  else notes.push(`start/stop without elevation was not granted: ${control.reason}`);

  // Only once the service's own files are protected: the data grant is
  // inherited, and until then it would have reached them.
  let dataAccess = false;
  if (protection.ok) {
    const result = await runSafely(() => buildDataDirGrantCommand(dataDir, operator.sid), run, 60_000);
    dataAccess = result.success;
    if (dataAccess) log(`  ${operator.name ?? operator.sid}: may use the data directory without elevation`);
    else notes.push(`data directory access was not granted: ${`${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(0, 200)}`);
  } else {
    // Fail closed. A grant from an earlier install or repair would otherwise
    // still be inherited by a runtime folder that could not be protected.
    await runSafely(() => buildDataDirRevokeCommand(dataDir, operator.sid), run, 120_000);
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
export async function revokeOperator({ operator, dataDir, run = shellRun, log = () => {} } = {}) {
  if (!operator || !isAccountSid(operator.sid) || !dataDir || !fs.existsSync(dataDir)) return { ok: true };
  const result = await runSafely(() => buildDataDirRevokeCommand(dataDir, operator.sid), run, 120_000);
  if (result.success) log(`  ${operator.name ?? operator.sid}: data directory access removed`);
  return result.success
    ? { ok: true }
    : { ok: false, reason: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(0, 300) };
}

/** Builds a command and runs it; a refused build is a failed result, never a throw. */
async function runSafely(build, run, timeout) {
  let command;
  try {
    command = build();
  } catch (err) {
    return { success: false, stdout: '', stderr: err.message };
  }
  return run(command, { timeout });
}

/**
 * Creates a folder the service will run code from and protects it while it is
 * still empty.
 *
 * A fresh folder inside the data directory inherits the installing user's
 * Modify grant, so copying first and protecting afterwards would leave a window
 * in which a file could be placed or replaced before the service starts on it.
 *
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function prepareProtectedDir({ dir, sid = null, serviceAccount = true, run = shellRun, log = () => {} } = {}) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { ok: false, reason: `could not create ${dir}: ${err.message}` };
  }
  const result = await protectServiceFiles({ dirs: [dir], sid, serviceAccount, run, log });
  return result.ok ? { ok: true } : { ok: false, reason: result.failed[0]?.reason ?? `could not protect ${dir}` };
}
