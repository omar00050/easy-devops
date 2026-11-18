/**
 * e2e/lib/firstRun.mjs
 *
 * Helpers for suites that drive first-run setup through the HTTP API.
 *
 * `POST /api/setup` requires the one-time setup code whenever one is
 * outstanding (core/setupCode.js), which every started dashboard and daemon
 * issues while no password is set. That is the point of the feature: the
 * person setting the first password has to be able to read the server's
 * terminal or its service log. A test is in exactly that position, so it reads
 * it the same way — but deterministically, rather than racing the child
 * process's stdout.
 *
 * Two ways to get it, and both are used:
 *
 *   - `issueSetupCode()` runs a short-lived Node process against the suite's
 *     own data directory and asks core/setupCode.js for a fresh one. This is
 *     what `ezz dashboard setup-code` does, and it is deterministic: no
 *     waiting, no parsing of a log that may not have flushed yet.
 *   - `findSetupCodeInOutput()` extracts a code from captured server output,
 *     for the suite that wants to assert the server really prints it.
 *
 * This module deliberately imports nothing from `src/`: suites must reach src
 * only through a dynamic import, and the runner enforces that.
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

/**
 * Collects a child process's stdout and stderr into one growing string.
 *
 * @param {import('child_process').ChildProcess} proc
 * @returns {() => string}
 */
export function attachOutput(proc) {
  let text = '';
  proc.stdout?.on('data', (d) => { text += d; });
  proc.stderr?.on('data', (d) => { text += d; });
  return () => text;
}

/** The code as printed, `418 902`, reduced to its digits. */
export function findSetupCodeInOutput(text) {
  const block = String(text ?? '').match(/First-run setup code[\s\S]{0,400}?(\d{3}\s\d{3})/);
  return block ? block[1].replace(/\D/g, '') : null;
}

/**
 * Waits for a server to print a setup code.
 *
 * @param {() => string} getOutput
 * @param {Object} [opts]
 * @returns {Promise<string|null>}
 */
export async function waitForSetupCode(getOutput, { timeoutMs = 10_000, everyMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = findSetupCodeInOutput(getOutput());
    if (found) return found;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return null;
}

/**
 * Issues a fresh setup code for a data directory, the way
 * `ezz dashboard setup-code` does.
 *
 * Runs in its own process so the suite's module state is untouched, and so the
 * database handle it opens is closed again when it exits.
 *
 * @param {Object} opts
 * @param {string} opts.dataDir
 * @returns {Promise<string>} The six digits
 */
export function issueSetupCode({ dataDir, timeoutMs = 30_000 } = {}) {
  const moduleUrl = pathToFileURL(path.join(ROOT, 'src', 'core', 'setupCode.js')).href;

  const script = [
    `const m = await import(${JSON.stringify(moduleUrl)});`,
    'const issued = await m.issue();',
    'process.stdout.write("CODE:" + issued.code);',
  ].join('\n');

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: ROOT,
      env: { ...process.env, EASY_DEVOPS_DATA_DIR: dataDir, EZ_TEST: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`issuing a setup code timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      const match = out.match(/CODE:(\d{6})/);
      if (match) return resolve(match[1]);
      reject(new Error(`could not issue a setup code (exit ${code}): ${err.trim() || out.trim()}`));
    });
  });
}
