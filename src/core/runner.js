/**
 * core/runner.js
 *
 * The one PM2 wrapper. Everything that talks to PM2 — the CLI `service`
 * commands, the dashboard's Processes page, the hub agent's reporting — goes
 * through here.
 *
 * Why PM2 at all: Easy DevOps deliberately does not implement its own daemon.
 * PM2 already solves keeping a process alive, restarting it after a crash and
 * bringing it back after a reboot, on both platforms this project supports.
 * Easy DevOps' job is to manage PM2 on the user's behalf, never to reinvent it.
 *
 * Rules this module keeps:
 *   - Every subprocess call goes through core/shell.js.
 *   - Every OS difference comes from core/platform.js.
 *   - PM2 is NEVER installed silently. install() exists, but the decision to
 *     call it belongs to the CLI or the dashboard, which must ask first.
 *   - `run` is injectable on every function so tests can assert the exact
 *     command without executing it.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { run as defaultRun } from './shell.js';
import { quoteExe, pm2StartupCmd, pm2UnstartupCmd, isWindows } from './platform.js';

/** PM2 can be slow to answer while the daemon is starting up. */
const PM2_TIMEOUT_MS = 60_000;
/** `npm install -g pm2` pulls a lot of packages. */
const INSTALL_TIMEOUT_MS = 300_000;

/**
 * Name PM2 knows the dashboard by.
 *
 * Dev mode gets its own app so a developer's instance can never be mistaken
 * for — or stop — the real one. The suffix follows the data directory, which
 * is the thing that actually differs.
 *
 * @param {boolean} dev
 * @returns {string}
 */
export function appName(dev) {
  return dev ? 'ez-dashboard-dev' : 'ez-dashboard';
}

/** Both names, so callers can recognise anything Easy DevOps created. */
export const EZ_APP_NAMES = Object.freeze(['ez-dashboard', 'ez-dashboard-dev']);

/** @returns {boolean} True when PM2 knows this app name as one of ours. */
export function isEzApp(name) {
  return EZ_APP_NAMES.includes(String(name ?? ''));
}

/**
 * Locates the pm2 executable and its version.
 *
 * Resolution is deliberately a plain `pm2 --version`: PM2 is installed
 * globally by npm, so it is on PATH exactly when it is usable, and asking the
 * shell avoids guessing at npm's global prefix layout per platform.
 *
 * `pm2 --version` has a side effect worth knowing about: it STARTS the PM2
 * daemon if it is not already running. Pass `probeVersion: false` to skip it
 * when you only need to know whether PM2 exists — a status read must not
 * spawn a daemon on a machine that does not use PM2.
 *
 * @param {{ run?: Function, probeVersion?: boolean }} [deps]
 * @returns {Promise<{ installed: boolean, version: string|null, path: string|null, error: string|null }>}
 */
export async function detect({ run = defaultRun, probeVersion = true } = {}) {
  const which = isWindows ? 'where.exe pm2' : 'command -v pm2';
  const located = await run(which, { timeout: 15_000 });

  if (!located.success || !located.stdout.trim()) {
    return { installed: false, version: null, path: null, error: null };
  }

  const candidates = located.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const exePath = pickExecutable(candidates);

  if (!probeVersion) {
    return { installed: true, version: null, path: exePath, error: null };
  }

  const ver = await run(`${quoteExe(exePath)} --version`, { timeout: 30_000 });
  // PM2 prints the daemonisation notice before the version, so take the last
  // line that looks like a version rather than the whole output.
  const version = (ver.stdout.match(/\d+\.\d+\.\d+/g) ?? []).pop() ?? null;

  return {
    installed: true,
    version,
    path: exePath,
    error: version ? null : (ver.stderr || 'Could not read the PM2 version'),
  };
}

/**
 * Chooses the entry that this OS can actually execute.
 *
 * npm's global bin directory holds BOTH a Unix shell script with no extension
 * and a Windows `.cmd` shim, and `where.exe pm2` lists the extensionless one
 * first. Running that on Windows fails silently-ish — the command returns
 * nothing useful — which showed up as "PM2 installed, version null" and an
 * unparseable process list. Prefer an extension Windows knows how to run.
 *
 * @param {string[]} candidates
 * @returns {string|null}
 */
export function pickExecutable(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  if (!isWindows) return candidates[0];

  const runnable = ['.cmd', '.bat', '.exe'];
  const match = candidates.find((c) => runnable.includes(c.slice(c.lastIndexOf('.')).toLowerCase()));
  return match ?? candidates[0];
}

/**
 * Installs PM2 globally.
 *
 * The caller MUST have asked the user first — see the module header.
 *
 * @param {{ run?: Function }} [deps]
 * @returns {Promise<{ ok: boolean, output: string }>}
 */
export async function install({ run = defaultRun } = {}) {
  const r = await run('npm install -g pm2', { timeout: INSTALL_TIMEOUT_MS });
  return { ok: r.success, output: combine(r) };
}

/**
 * Installs the pm2-logrotate module, so PM2's logs cannot grow without bound.
 *
 * A PM2 module, not an npm dependency of this project: it is installed into
 * the user's PM2, exactly like PM2 itself.
 *
 * @param {{ run?: Function, pm2Path?: string }} [deps]
 * @returns {Promise<{ ok: boolean, output: string }>}
 */
export async function installLogrotate({ run = defaultRun, pm2Path = 'pm2' } = {}) {
  const r = await run(`${quoteExe(pm2Path)} install pm2-logrotate`, { timeout: INSTALL_TIMEOUT_MS });
  return { ok: r.success, output: combine(r) };
}

/**
 * True when pm2-logrotate is present.
 * @param {{ run?: Function, pm2Path?: string }} [deps]
 * @returns {Promise<boolean>}
 */
export async function hasLogrotate({ run = defaultRun, pm2Path = 'pm2' } = {}) {
  const r = await run(`${quoteExe(pm2Path)} ls`, { timeout: PM2_TIMEOUT_MS });
  return /pm2-logrotate/.test(combine(r));
}

/**
 * Lists PM2 apps.
 *
 * `pm2 jlist` prints JSON on stdout, but PM2 also writes its daemonisation
 * notices there, so the JSON array has to be extracted rather than parsed
 * from the whole buffer.
 *
 * @param {{ run?: Function, pm2Path?: string }} [deps]
 * @returns {Promise<{ ok: boolean, apps: Array<Object>, error: string|null }>}
 */
export async function list({ run = defaultRun, pm2Path = 'pm2' } = {}) {
  const r = await run(`${quoteExe(pm2Path)} jlist`, { timeout: PM2_TIMEOUT_MS });

  const raw = extractJsonArray(r.stdout);
  if (raw === null) {
    return { ok: false, apps: [], error: combine(r) || 'PM2 returned no process list' };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, apps: [], error: `Could not parse the PM2 process list: ${err.message}` };
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, apps: [], error: 'PM2 process list was not an array' };
  }

  return { ok: true, apps: parsed.map(normalizeApp), error: null };
}

/**
 * Reduces a `pm2 jlist` entry to the fields the UI needs.
 *
 * Shapes the numbers here rather than in each consumer: PM2 reports memory in
 * bytes and uptime as an epoch milliseconds *start* time, which is easy to
 * misread as a duration.
 *
 * @param {Object} app One entry from `pm2 jlist`
 */
export function normalizeApp(app) {
  const env = app?.pm2_env ?? {};
  const startedAt = typeof env.pm_uptime === 'number' ? env.pm_uptime : null;

  return {
    name: app?.name ?? '(unnamed)',
    pmId: typeof app?.pm_id === 'number' ? app.pm_id : null,
    pid: typeof app?.pid === 'number' && app.pid > 0 ? app.pid : null,
    status: env.status ?? 'unknown',
    cpu: typeof app?.monit?.cpu === 'number' ? app.monit.cpu : null,
    memoryBytes: typeof app?.monit?.memory === 'number' ? app.monit.memory : null,
    startedAt,
    uptimeMs: startedAt && env.status === 'online' ? Math.max(0, Date.now() - startedAt) : null,
    restarts: typeof env.restart_time === 'number' ? env.restart_time : 0,
    unstableRestarts: typeof env.unstable_restarts === 'number' ? env.unstable_restarts : 0,
    execPath: env.pm_exec_path ?? null,
    cwd: env.pm_cwd ?? null,
    user: env.username ?? null,
    /** True for the apps Easy DevOps created, which the UI may act on freely. */
    managed: isEzApp(app?.name),
    /** The data directory this app was started with, when it carries one. */
    dataDir: env.env?.EASY_DEVOPS_DATA_DIR ?? env.EASY_DEVOPS_DATA_DIR ?? null,
  };
}

/**
 * Starts a script as a named PM2 app.
 *
 * Arguments for the script go after `--`, which is how PM2 separates its own
 * options from the child's. The script path is passed explicitly rather than
 * relying on the `ezz` shim being on PATH: on Windows that shim is a .cmd,
 * which PM2 cannot run as a Node script.
 *
 * @param {Object} opts
 * @param {string} opts.script     Absolute path to the script
 * @param {string} opts.name       PM2 app name
 * @param {string[]} [opts.args]   Arguments passed to the script
 * @param {string} [opts.cwd]      Working directory
 * @param {Function} [opts.run]
 * @param {string} [opts.pm2Path]
 * @returns {Promise<{ ok: boolean, output: string }>}
 */
export async function start({ script, name, args = [], cwd, run = defaultRun, pm2Path = 'pm2' }) {
  const parts = [`${quoteExe(pm2Path)} start "${script}"`, `--name "${name}"`];
  if (args.length > 0) parts.push('--', ...args);

  const r = await run(parts.join(' '), { timeout: PM2_TIMEOUT_MS, ...(cwd ? { cwd } : {}) });
  return { ok: r.success, output: combine(r) };
}

/** @returns {Promise<{ ok: boolean, output: string }>} */
export async function stop(name, { run = defaultRun, pm2Path = 'pm2' } = {}) {
  return simple('stop', name, run, pm2Path);
}

/** @returns {Promise<{ ok: boolean, output: string }>} */
export async function restart(name, { run = defaultRun, pm2Path = 'pm2' } = {}) {
  return simple('restart', name, run, pm2Path);
}

/**
 * Graceful reload (zero-downtime for apps in cluster mode).
 * @returns {Promise<{ ok: boolean, output: string }>}
 */
export async function reload(name, { run = defaultRun, pm2Path = 'pm2' } = {}) {
  return simple('reload', name, run, pm2Path);
}

/** Removes the app from PM2 entirely. @returns {Promise<{ ok: boolean, output: string }>} */
export async function del(name, { run = defaultRun, pm2Path = 'pm2' } = {}) {
  return simple('delete', name, run, pm2Path);
}

/**
 * Reads recent log lines for an app.
 *
 * `--nostream` is what makes this return instead of tailing forever.
 *
 * @param {string} name
 * @param {{ lines?: number, run?: Function, pm2Path?: string }} [opts]
 * @returns {Promise<{ ok: boolean, lines: string[], output: string }>}
 */
export async function logs(name, { lines = 200, run = defaultRun, pm2Path = 'pm2' } = {}) {
  const n = Math.max(1, Math.min(5000, Number(lines) || 200));
  const r = await run(`${quoteExe(pm2Path)} logs "${name}" --lines ${n} --nostream`, {
    timeout: PM2_TIMEOUT_MS,
  });
  const text = combine(r);
  return { ok: r.success, lines: text ? text.split(/\r?\n/) : [], output: text };
}

/**
 * Saves the current process list, so `pm2 resurrect` can restore it.
 * This is what makes a reboot bring the dashboard back.
 * @returns {Promise<{ ok: boolean, output: string }>}
 */
export async function save({ run = defaultRun, pm2Path = 'pm2' } = {}) {
  const r = await run(`${quoteExe(pm2Path)} save`, { timeout: PM2_TIMEOUT_MS });
  return { ok: r.success, output: combine(r) };
}

/**
 * Asks PM2 for its init-system startup hook.
 *
 * Linux and macOS only. PM2 has no Windows support here and exits non-zero,
 * which is why Windows gets its own two mechanisms — see core/service.js.
 *
 * PM2 does not install the hook itself when it needs root: it prints a command
 * for the user to run under sudo. That command is returned verbatim rather
 * than executed, so Easy DevOps never needs broad sudoers rules.
 *
 * @param {{ run?: Function, pm2Path?: string }} [deps]
 * @returns {Promise<{ ok: boolean, sudoCommand: string|null, output: string }>}
 */
export async function startup({ run = defaultRun, pm2Path = 'pm2' } = {}) {
  const r = await run(pm2StartupCmd(pm2Path), { timeout: PM2_TIMEOUT_MS });
  const output = combine(r);
  return { ok: r.success, sudoCommand: parseSudoCommand(output), output };
}

/**
 * Removes PM2's init-system hook (Linux/macOS).
 * Like startup(), this may only print a sudo command for the user to run.
 * @returns {Promise<{ ok: boolean, sudoCommand: string|null, output: string }>}
 */
export async function unstartup({ run = defaultRun, pm2Path = 'pm2' } = {}) {
  const r = await run(pm2UnstartupCmd(pm2Path), { timeout: PM2_TIMEOUT_MS });
  const output = combine(r);
  return { ok: r.success, sudoCommand: parseSudoCommand(output), output };
}

/**
 * Pulls the `sudo env PATH=… pm2 startup …` line out of PM2's output.
 *
 * PM2 prints guidance around it, so the line is matched rather than the whole
 * output being handed to the user as if it were a command.
 *
 * @param {string} output
 * @returns {string|null}
 */
export function parseSudoCommand(output) {
  if (!output) return null;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^sudo\s/.test(trimmed) && /pm2/.test(trimmed)) return trimmed;
  }
  return null;
}

/**
 * The OS user this process is running as.
 *
 * PM2 keeps a separate daemon and process list per user (under PM2_HOME), so
 * a service installed by another account is invisible here — and stopping or
 * restarting it would not work. Callers compare this against an app's owner
 * to warn rather than silently doing nothing.
 *
 * @returns {string}
 */
export function currentUser() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USERNAME || process.env.USER || 'unknown';
  }
}

/** The PM2_HOME in effect, which decides which process list we see. */
export function pm2Home() {
  return process.env.PM2_HOME || null;
}

/** The directory PM2 actually uses, whether or not PM2_HOME is set. */
export function pm2HomeDir() {
  return process.env.PM2_HOME?.trim() || path.join(os.homedir(), '.pm2');
}

/**
 * True when the PM2 daemon for this PM2_HOME is already running.
 *
 * This matters more than it looks: EVERY pm2 command — `pm2 --version`
 * included — starts the daemon if it is not running. A status read must never
 * do that, or simply opening the dashboard (or the hub agent reporting every
 * minute) would spawn a PM2 daemon on a machine that does not use PM2.
 *
 * Checked by pid file rather than by asking PM2, for the same reason.
 *
 * @returns {boolean}
 */
export function isDaemonRunning() {
  try {
    const pidFile = path.join(pm2HomeDir(), 'pm2.pid');
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0) return false;
    // A stale pid file outlives a crashed daemon, so confirm the process.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ─── internals ────────────────────────────────────────────────────────────────

async function simple(verb, name, run, pm2Path) {
  const r = await run(`${quoteExe(pm2Path)} ${verb} "${name}"`, { timeout: PM2_TIMEOUT_MS });
  return { ok: r.success, output: combine(r) };
}

function combine(r) {
  return [r?.stdout, r?.stderr].filter(Boolean).join('\n').trim();
}

/**
 * Extracts the JSON array from a noisy stdout buffer.
 *
 * Brace counting rather than a regex, because app names and cwd values contain
 * brackets. Every candidate `[` is tried in turn and kept only if it actually
 * parses: PM2 prefixes its own log lines with "[PM2]", so the FIRST `[` in the
 * buffer is routinely the start of a notice rather than the process list, and
 * taking it blindly returned the string "[PM2]".
 *
 * @param {string} text
 * @returns {string|null} The JSON array source, or null when there is none
 */
export function extractJsonArray(text) {
  const s = String(text ?? '');

  for (let start = s.indexOf('['); start !== -1; start = s.indexOf('[', start + 1)) {
    const candidate = balancedSlice(s, start);
    if (candidate === null) continue;

    try {
      if (Array.isArray(JSON.parse(candidate))) return candidate;
    } catch { /* this '[' began something else — keep looking */ }
  }

  return null;
}

/**
 * Returns the substring from `start` to its matching close bracket, honouring
 * strings and escapes, or null when it never balances.
 *
 * @param {string} s
 * @param {number} start Index of the opening '['
 * @returns {string|null}
 */
function balancedSlice(s, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < s.length; i++) {
    const ch = s[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') { inString = true; continue; }

    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
      if (depth < 0) return null;
    }
  }

  return null;
}
