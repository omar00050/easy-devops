/**
 * core/nginx-apply.js
 *
 * The single place where a generated nginx config is written, tested and —
 * if the test fails — rolled back. The CLI, the dashboard API and the Hub
 * command path all go through `writeConfWithTest()`, so the write/test/restore
 * behaviour cannot drift between them.
 *
 * Why this is separate from nginx-conf-generator.js: the generator stays a
 * pure config builder with no subprocess execution. This module is the part
 * that touches nginx.
 *
 * Windows certificate-path handling
 * ---------------------------------
 * nginx's config lexer treats `\` as an escape character, so an unquoted
 * `C:\nginx\test\certs\a.pem` has its \n and \t read as a newline and a tab.
 * Configs are therefore written with forward slashes first. Only if nginx
 * rejects THIS config file for a certificate-loading reason do we retry once
 * with quoted, escaped backslashes. Linux never retries and never changes.
 */

import fs from 'fs/promises';
import path from 'path';
import { loadConfig } from './config.js';
import { run } from './shell.js';
import {
  isWindows,
  nginxTestCmd,
  combineOutput,
  isNginxTestOk,
  isCertPathErrorFor,
  parseNginxErrorFiles,
} from './platform.js';
import { generateConf, getConfDDir, CERT_PATH_STYLES, NginxFieldError } from './nginx-conf-generator.js';

/** Runs `nginx -t` and returns { ok, output }. Never inspects the exit code directly. */
async function runNginxTest(nginxDir) {
  const cmd = isWindows ? nginxTestCmd(nginxDir) : 'nginx -t';
  const result = await run(cmd, { cwd: nginxDir });
  return { ok: isNginxTestOk(result), output: combineOutput(result) };
}

/** Reads a file's current contents, or null when it does not exist. */
async function snapshot(confPath) {
  try {
    return await fs.readFile(confPath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Restores a config file to a previous state.
 * @param {string} confPath
 * @param {string|null} previous Contents to restore, or null to delete the file
 */
async function restore(confPath, previous) {
  try {
    if (previous === null) {
      await fs.unlink(confPath);
    } else {
      await fs.writeFile(confPath, previous, 'utf8');
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds the error message for a failed apply, naming the file nginx blamed.
 * @param {string} confPath
 * @param {Array<{ style: string, output: string }>} attempts
 * @returns {string}
 */
function describeFailure(confPath, attempts) {
  const last = attempts[attempts.length - 1];
  const blamed = parseNginxErrorFiles(last.output);

  // Prefer the file nginx actually named; fall back to the one we wrote.
  const file = blamed.length > 0 ? blamed.join(', ') : confPath;
  const sameFile =
    blamed.length === 0 ||
    blamed.some((f) => f.replace(/\\/g, '/').toLowerCase() === confPath.replace(/\\/g, '/').toLowerCase());

  const lines = [`nginx rejected the configuration in ${file}.`];

  if (!sameFile) {
    lines.push(
      `Note: the error is in a different file than the one just written (${confPath}), ` +
        'so it is probably pre-existing and unrelated to this change.'
    );
  }

  if (attempts.length > 1) {
    lines.push(
      'Both certificate path forms were tried (forward slashes, then escaped backslashes) ' +
        'and both were rejected, so the path format is not the cause — check that the ' +
        'certificate files exist and are readable.'
    );
  }

  lines.push('', 'nginx output:', last.output || '(no output)');
  return lines.join('\n');
}

/**
 * Writes a domain's config, tests it, and restores the previous content on failure.
 *
 * On Windows, if the test fails specifically because nginx could not load this
 * config's certificates, the config is rewritten once with escaped backslash
 * paths and tested again.
 *
 * Always targets the configured nginx directory: generateConf() resolves it
 * from loadConfig(), so an override here would silently disagree with the file
 * actually written.
 *
 * @param {Object} domain Domain object (v2 schema); its configFile/updatedAt are set on success
 * @returns {Promise<{
 *   ok: boolean,
 *   confPath: string|null,
 *   style: string|null,
 *   output: string,
 *   error: string|null,
 *   restored: boolean,
 *   existed: boolean
 * }>}
 */
export async function writeConfWithTest(domain) {
  const { nginxDir } = loadConfig();

  // Resolve the target path without writing, so we can snapshot it first.
  const confPath = path.join(getConfDDir(nginxDir), `${domain.name}.conf`);

  const previous = await snapshot(confPath);
  const existed = previous !== null;

  // Windows gets a fallback attempt; Linux behaviour is unchanged.
  const styles = isWindows
    ? [CERT_PATH_STYLES.FORWARD, CERT_PATH_STYLES.ESCAPED]
    : [CERT_PATH_STYLES.FORWARD];

  const attempts = [];

  for (let i = 0; i < styles.length; i++) {
    const style = styles[i];

    try {
      await generateConf(domain, { certPathStyle: style });
    } catch (err) {
      // Field validation runs before the generator writes anything.
      if (err instanceof NginxFieldError && i === 0) {
        return { ok: false, confPath: null, style: null, output: '', error: err.message, restored: false, existed };
      }
      await restore(confPath, previous);
      return {
        ok: false,
        confPath: null,
        style: null,
        output: '',
        error: `Failed to write ${confPath}: ${err.message}`,
        restored: true,
        existed,
      };
    }

    const { ok, output } = await runNginxTest(nginxDir);
    attempts.push({ style, output });

    if (ok) {
      return { ok: true, confPath, style, output, error: null, restored: false, existed };
    }

    const isLastAttempt = i === styles.length - 1;
    // Only retry when nginx blamed THIS file's certificate directives — a cert
    // error in someone else's config must not trigger a path rewrite here.
    if (isLastAttempt || !isCertPathErrorFor(output, confPath)) break;
  }

  const restored = await restore(confPath, previous);
  return {
    ok: false,
    confPath,
    style: null,
    output: attempts[attempts.length - 1]?.output ?? '',
    error: describeFailure(confPath, attempts),
    restored,
    existed,
  };
}

/**
 * Lists stored domains whose certificate paths still contain backslashes.
 *
 * Report-only: existing configs are never rewritten automatically. Regenerating
 * such a domain through the normal update path applies the fix, because that
 * path goes through writeConfWithTest().
 *
 * @param {Array<Object>} domains Domain objects (as stored)
 * @returns {Array<{ name: string, certPath: string, keyPath: string }>}
 */
export function findBackslashCertPaths(domains) {
  if (!Array.isArray(domains)) return [];

  return domains
    .filter((d) => d?.ssl?.enabled)
    .filter((d) => hasBackslash(d.ssl.certPath) || hasBackslash(d.ssl.keyPath))
    .map((d) => ({
      name: d.name,
      certPath: d.ssl.certPath ?? '',
      keyPath: d.ssl.keyPath ?? '',
    }));
}

function hasBackslash(p) {
  return typeof p === 'string' && p.includes('\\');
}
