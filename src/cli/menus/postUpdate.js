/**
 * Hidden handoff target for the updater.
 *
 * The old updater starts this file from the newly installed package after npm
 * succeeds. It performs only pre-start service setup and prints one structured
 * result line, which the old updater uses to decide whether to start or roll
 * back.
 */

import {
  POST_UPDATE_RESULT_PREFIX,
  applyPostUpdate,
} from '../../core/service/postUpdate.js';

function emit(stdout, result) {
  const text = `\n${POST_UPDATE_RESULT_PREFIX}${JSON.stringify(result)}\n`;
  return new Promise((resolve, reject) => {
    stdout.write(text, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function postUpdateCommand({
  env = process.env,
  stdout = process.stdout,
  deps = {},
} = {}) {
  const dataDir = env.EASY_DEVOPS_DATA_DIR;
  if (!dataDir) {
    await emit(stdout, { ok: false, step: 'environment', reason: 'EASY_DEVOPS_DATA_DIR is required' });
    return 1;
  }

  try {
    const result = await applyPostUpdate({
      dataDir,
      mode: env.EZ_UPDATE_MODE || null,
      mechanism: env.EZ_UPDATE_MECHANISM || null,
      targetVersion: env.EZ_UPDATE_TARGET || null,
      nodeExe: env.EZ_UPDATE_NODE_EXE || null,
      log: (line) => stdout.write(`${line}\n`),
      deps,
    });
    if (!result.ok) {
      // Printed here, not only returned: the updater streams this child's
      // output, and the operator has to see whether the previous permissions
      // came back and what to run next.
      stdout.write(`The post-update step failed${result.step ? ` (${result.step})` : ''}: ${result.reason}\n`);
      if (result.next && !String(result.reason ?? '').includes('ezz service')) {
        stdout.write(`Next: ${result.next}\n`);
      }
    }
    await emit(stdout, result);
    return result.ok ? 0 : 1;
  } catch (error) {
    await emit(stdout, { ok: false, step: 'exception', reason: error.message });
    return 1;
  }
}
