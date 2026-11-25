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
import { protectServiceFiles } from './operator.js';
import { binDir, refreshServiceDefinition } from './windowsService.js';
import { recoverInterruptedUpdate } from './updateTransaction.js';
import * as windowsPersonal from './windowsPersonal.js';
import * as systemd from './systemd.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..', '..', '..');
const ENTRY = path.join(PACKAGE_ROOT, 'src', 'cli', 'index.js');

export const POST_UPDATE_RESULT_PREFIX = '__EASY_DEVOPS_POST_UPDATE__';

export function installedPackageVersion() {
  return String(JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version);
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
      // left by 1.4.4-1.4.6. Verify both before the new XML is written.
      secured = await (deps.protectServiceFiles ?? protectServiceFiles)({
        dirs: [copied.dir, binDir()],
        log,
      });
    } catch (error) {
      return { ok: false, step: 'permissions', version, reason: error.message };
    }
    if (!secured?.ok) {
      return {
        ok: false,
        step: 'permissions',
        version,
        reason: secured?.failed?.map((entry) => `${entry.path}: ${entry.reason}`).join('; ')
          || 'the runtime permissions could not be secured',
      };
    }

    try {
      (deps.refreshServiceDefinition ?? refreshServiceDefinition)({ dataDir, runtime: copied });
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
