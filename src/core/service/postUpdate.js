/**
 * Applies the newly installed package's service setup before the daemon is
 * started. This module is loaded by the hidden `_post-update` CLI command in a
 * fresh process, so it is always the newly installed code, not the updater
 * that initiated the replacement.
 *
 * It is idempotent on purpose: `ezz service repair` and `ezz service recover`
 * run it again on machines where the update was interrupted or where an older
 * updater installed this package without running it at all. Nothing here
 * depends on having run once already, and nothing here creates a file that a
 * second run would refuse to overwrite.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { copyRuntime, verifyNativeModules } from './runtime.js';
import { codeRootNextStep, protectServiceFiles } from './operator.js';
import { binDir, refreshServiceDefinition } from './windowsService.js';
import { recoverInterruptedUpdate } from './updateTransaction.js';
import { clearStopRequest, readStopRequest, stopRequestPath } from '../daemon/stopRequest.js';
import * as windowsPersonal from './windowsPersonal.js';
import * as systemd from './systemd.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..', '..', '..');
const ENTRY = path.join(PACKAGE_ROOT, 'src', 'cli', 'index.js');

/** What a failed protection pass tells the operator to run. */
export const POST_UPDATE_PROTECT_NEXT = codeRootNextStep('post-update');

export const POST_UPDATE_RESULT_PREFIX = '__EASY_DEVOPS_POST_UPDATE__';

/**
 * The reason a failed protection pass returns, said in full.
 *
 * The operator must be able to tell whether the previous permissions came back
 * and what to run next. `protectCodeRoot` already puts both in its reason; an
 * older or generic entry may not, so the missing half is added here rather
 * than left to the caller to invent.
 *
 * @param {Array<{ path?: string, reason?: string, restored?: boolean, next?: string|null }>} failed
 * @returns {string}
 */
export function permissionsFailureReason(failed = []) {
  const entries = (Array.isArray(failed) ? failed : []).filter(Boolean);
  if (entries.length === 0) {
    return `the service files could not be protected. ${POST_UPDATE_PROTECT_NEXT}.`;
  }
  return entries.map((entry) => {
    const reason = String(entry.reason ?? 'the permissions could not be written').trim();
    const restoreNote = entry.restored === true
      ? 'The previous permissions were restored.'
      : entry.restored === false
        ? 'The previous permissions were NOT restored automatically.'
        : 'The previous permissions may not have been restored.';
    const parts = [`${entry.path ? `${entry.path}: ` : ''}${reason.endsWith('.') ? reason : `${reason}.`}`];
    if (!/restor/i.test(reason)) parts.push(restoreNote);
    if (!/ezz service (?:repair|recover)/i.test(reason)) {
      parts.push(`Next: ${entry.next || POST_UPDATE_PROTECT_NEXT}`);
    }
    return parts.join(' ');
  }).join(' ');
}

export function installedPackageVersion() {
  return String(JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version);
}

/**
 * Clears a stop request left behind before this update.
 *
 * @returns {Promise<{ ok: boolean, cleared?: boolean, reason?: string }>}
 */
async function onStaleStopRequest({ dataDir, log, deps }) {
  const read = deps.readStopRequest ?? readStopRequest;
  const clear = deps.clearStopRequest ?? clearStopRequest;
  const pathFor = deps.stopRequestPath ?? stopRequestPath;
  let requested = false;
  try {
    requested = read({ dataDir }).requested === true;
  } catch { /* an unreadable file is still cleared below */ }
  if (!requested) return { ok: true, cleared: false };

  let cleared = false;
  try {
    cleared = clear({ dataDir }) !== false;
  } catch { cleared = false; }
  if (!cleared) {
    return {
      ok: false,
      reason: `the stop request at ${pathFor(dataDir)} could not be cleared, so a new daemon would exit as soon `
        + 'as it starts. Delete that file, then run `ezz service repair` from an Administrator PowerShell.',
    };
  }
  log('Cleared a stop request left by an earlier `ezz service stop`, so the new service does not exit at once.');
  return { ok: true, cleared: true };
}

/**
 * @returns {Promise<{ok:boolean, step:string, version?:string, reason?:string}>}
 */
export async function applyPostUpdate({
  dataDir,
  mode,
  mechanism,
  targetVersion,
  nodeExe = null,
  log = () => {},
  deps = {},
} = {}) {
  const version = (deps.installedPackageVersion ?? installedPackageVersion)();
  if (targetVersion && version !== targetVersion) {
    return {
      ok: false,
      step: 'version',
      reason: `the post-update command loaded v${version}, expected v${targetVersion}`,
    };
  }

  // An update that died before committing moved the runtime copy aside and
  // left the journal behind. Put the previous one back before this run reads
  // or replaces that folder, otherwise it copies on top of a half-made state.
  let recovered;
  try {
    recovered = await (deps.recoverInterruptedUpdate ?? recoverInterruptedUpdate)({ dataDir, log });
  } catch (error) {
    return { ok: false, step: 'journal', version, reason: error.message };
  }
  if (!recovered?.ok) {
    return {
      ok: false,
      step: 'journal',
      version,
      reason: recovered?.reason
        || 'an interrupted update could not be repaired. Run `ezz service recover`.',
    };
  }

  // A `ezz service stop` left in place by an older version (or by the update's
  // own stop on a broken install) makes the daemon exit again the moment the
  // service starts it. It is cleared by every start path; doing it here means
  // the start that follows cannot race a stale file, in any mode.
  const stopped = await onStaleStopRequest({ dataDir, log, deps });

  if (!stopped.ok) return { ok: false, step: 'stop-request', version, reason: stopped.reason };

  if (mode === 'server' || mechanism === 'winsw') {
    log('Refreshing the Windows Server runtime copy...');
    const sourceNode = nodeExe && fs.existsSync(nodeExe) ? nodeExe : process.execPath;
    let copied;
    try {
      copied = await (deps.copyRuntime ?? copyRuntime)({
        dataDir,
        appRoot: PACKAGE_ROOT,
        nodeExe: sourceNode,
        log: (line) => log(`  ${line}`),
      });
    } catch (error) {
      return { ok: false, step: 'copy', version, reason: error.message };
    }
    if (!copied?.ok) {
      return { ok: false, step: 'copy', version, reason: copied?.reason || 'the runtime copy returned no result' };
    }

    let native;
    try {
      native = await (deps.verifyNativeModules ?? verifyNativeModules)({
        nodeExe: copied.nodeExe,
        appDir: path.join(copied.dir, 'app'),
      });
    } catch (error) {
      return { ok: false, step: 'native', version, reason: error.message };
    }
    if (!native?.ok) {
      return {
        ok: false,
        step: 'native',
        version,
        reason: `${native?.reason ?? 'native-module verification returned no result'} ${native?.fix ?? ''}`.trim(),
      };
    }

    let secured;
    try {
      // `runtime` is fresh, while `bin` may still carry the empty file DACLs
      // left by 1.4.4-1.4.6. Verify both before the new XML is written, with
      // the routine that streams its verification and restores what it saved.
      secured = await (deps.protectServiceFiles ?? protectServiceFiles)({
        dirs: [copied.dir, binDir()],
        mode: 'post-update',
        log,
      });
    } catch (error) {
      return { ok: false, step: 'permissions', version, reason: permissionsFailureReason([{ reason: error.message }]) };
    }
    if (!secured?.ok) {
      const reason = permissionsFailureReason(secured?.failed ?? []);
      return {
        ok: false,
        step: 'permissions',
        version,
        reason,
        restored: Array.isArray(secured?.failed)
          && secured.failed.length > 0
          && secured.failed.every((entry) => entry?.restored === true),
        next: POST_UPDATE_PROTECT_NEXT,
      };
    }

    try {
      // The binary's own version decides between `--import` and the older
      // `--experimental-loader` flag, so every daemon start stops printing the
      // ExperimentalWarning (1.4.7 finding 8).
      (deps.refreshServiceDefinition ?? refreshServiceDefinition)({
        dataDir,
        runtime: copied,
        nodeVersion: native.version ?? null,
      });
    } catch (error) {
      return { ok: false, step: 'definition', version, reason: error.message };
    }
    return {
      ok: true,
      step: 'definition',
      version,
      runtime: { version: native.version, abi: native.abi },
    };
  }

  if (mode === 'personal' || mechanism === 'startup-supervisor') {
    let repaired;
    try {
      repaired = await (deps.repairPersonal ?? windowsPersonal.repair)({
        dataDir,
        entry: ENTRY,
        nodeExe: nodeExe && fs.existsSync(nodeExe) ? nodeExe : process.execPath,
        log,
      });
    } catch (error) {
      return { ok: false, step: 'definition', version, reason: error.message };
    }
    return repaired?.ok
      ? { ok: true, step: 'definition', version }
      : { ok: false, step: 'definition', version, reason: repaired?.reason || 'the Personal launcher repair returned no result' };
  }

  let refreshed;
  try {
    refreshed = await (deps.refreshUnit ?? systemd.refreshUnit)({
      dataDir,
      entry: ENTRY,
      log,
    });
  } catch (error) {
    return { ok: false, step: 'definition', version, reason: error.message };
  }
  return refreshed?.ok
    ? { ok: true, step: 'definition', version }
    : { ok: false, step: 'definition', version, reason: refreshed?.reason || 'the systemd refresh returned no result' };
}
