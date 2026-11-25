import { pathToFileURL } from 'node:url';
/**
 * core/service/systemd.js
 *
 * The Linux service: a systemd unit that runs `ezz daemon`.
 *
 * ── Why the unit runs as the invoking user, not root ───────────────────────
 *
 * The daemon writes to `~/.config/easy-devops` and reads the user's nginx
 * configuration. Running it as root would put root-owned files in the user's
 * data directory, which then breaks every subsequent `ezz` command run
 * normally — a failure that looks like corruption rather than a permission
 * problem. `User=` is the invoking user for that reason, and it is also the
 * least privilege that works: nginx control already goes through `sudo -n`
 * with specific sudoers rules, so the daemon does not need to be root to
 * reload nginx.
 *
 * ── Why sudo is asked for by sudo ──────────────────────────────────────────
 *
 * Writing to `/etc/systemd/system` needs root. The command is run with
 * `runInteractive`, so sudo prompts on the user's own terminal and the
 * password never passes through this process. Nothing here ever reads,
 * stores, or asks for a password itself.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { run, runFile, runInteractive } from '../shell.js';
import { isDefaultDataDir } from '../platform.js';
import { runtimeNodePath } from './runtime.js';

/** Unit name and path. One unit, one name, no per-user variants. */
export const UNIT_NAME = 'easy-devops.service';
export const UNIT_PATH = `/etc/systemd/system/${UNIT_NAME}`;

/** How long to wait for the daemon's heartbeat after starting the service. */
export const STARTUP_GRACE_MS = 10_000;

/**
 * The package root for an entry script, used as the unit's WorkingDirectory.
 *
 * The entry is `<root>/src/cli/index.js`, so the directory containing it is
 * two levels below the root. Using `dirname(entry)` would set the working
 * directory to `src/cli`, where a relative path such as `package.json` does
 * not resolve.
 *
 * @param {string} entry
 * @returns {string}
 */
export function packageRootFor(entry) {
  // `path.posix`, not `path`: every path in a systemd unit is a Linux path,
  // and the platform-sensitive `path` would rewrite one with a drive letter
  // when this runs anywhere else — which is exactly what made this testable
  // only on Linux before. It also means no `path.resolve`, which consults the
  // host's cwd.
  const dir = path.posix.dirname(entry);

  // Only climb when the layout is the one we ship. Anything else is left alone
  // rather than guessed at.
  if (path.posix.basename(dir) === 'cli' && path.posix.basename(path.posix.dirname(dir)) === 'src') {
    return path.posix.dirname(path.posix.dirname(dir));
  }
  return dir;
}

/** Whether this machine has systemd at all. */
export async function hasSystemd({ runner = run } = {}) {
  // The directory is the cheapest reliable signal; `systemctl --version` also
  // exists on machines where systemd is installed but not the init system,
  // which is exactly the case that must not be treated as supported.
  if (!fs.existsSync('/run/systemd/system')) return false;

  const probe = await runner('systemctl --version', { timeout: 10_000 });
  return probe.success;
}

/**
 * The unit file.
 *
 * Choices worth knowing:
 *
 *  - `After=network-online.target nginx.service` plus `Wants=network-online`:
 *    the daemon's first action is to probe domains and reach the Hub, both of
 *    which fail noisily on a machine whose network is not up yet. `After` on
 *    `nginx.service` is ordering only — a machine without nginx as a service
 *    still starts, because it is not listed under `Requires`.
 *  - `Restart=always` with `RestartSec=5`: a crash loop is handled by
 *    `StartLimitBurst` below rather than by giving up after one failure.
 *  - `StartLimitIntervalSec`/`StartLimitBurst` let systemd stop restarting a
 *    daemon that cannot start at all, which is what makes `status` able to
 *    report a crash loop instead of showing "activating" for ever.
 *  - No `ExecStop`: the daemon handles SIGTERM, releases the lock and closes
 *    the database. systemd's default is exactly that signal.
 *
 * @param {Object} opts
 * @param {string} opts.nodeExe  The pinned runtime path (a symlink)
 * @param {string} opts.entry    Absolute path to the ez entry script
 * @param {string} opts.user
 * @param {string} opts.dataDir
 * @param {string} [opts.workingDir]
 * @returns {string}
 */
function unitArg(value) {
  if (/[\r\n\0]/.test(value)) throw new Error('Invalid systemd argument');
  const escaped = value.replaceAll('%', '%%').replaceAll('$', '$$');
  return /^[=a-zA-Z0-9_./:-]+$/.test(escaped) ? escaped : JSON.stringify(escaped);
}

export function buildUnit({ nodeExe, entry, user, dataDir, workingDir = null }) {
  // Only passed when it is NOT the default. A unit that sets it to the very
  // directory the code already resolves on its own adds nothing, and the one
  // that did set it needlessly turned the service into a dev run — staging
  // certificates on real domains. See isDevDataDir() in core/platform.js.
  const dataDirLine = isDefaultDataDir(dataDir)
    ? '# EASY_DEVOPS_DATA_DIR is not set: this is the default directory.'
    : `Environment=${unitArg(`EASY_DEVOPS_DATA_DIR=${dataDir}`)}`;

  return `[Unit]
Description=Easy DevOps background service
Documentation=https://github.com/farghaly/easy-devops
After=network-online.target nginx.service
Wants=network-online.target

# These belong in [Unit], not [Service]: systemd moved them in v229 and still
# accepts the old position only with a deprecation warning in the journal.
# Stop restarting after 5 failures inside 60s, so a daemon that cannot start
# ends in a state 'systemctl status' reports plainly instead of thrashing.
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=${unitArg(user)}
WorkingDirectory=${unitArg(workingDir ?? packageRootFor(entry))}

# The pinned runtime, not whatever "node" resolves to in a shell. A version
# manager can change that at any time; this path is ours.
ExecStart=${unitArg(nodeExe)} ${unitArg(`--experimental-loader=${pathToFileURL(path.resolve(path.dirname(entry), '../core/service/runtime-loader.mjs')).href}`)} ${unitArg(entry)} daemon

Environment=NODE_OPTIONS=
Environment=NODE_PATH=
Environment=WS_NO_BUFFER_UTIL=1
Environment=WS_NO_UTF_8_VALIDATE=1
Environment=NODE_ENV=production
${dataDirLine}

Restart=always
RestartSec=5

# Give the daemon time to release its lock and close the database.
TimeoutStopSec=20
KillSignal=SIGTERM

StandardOutput=journal
StandardError=journal
SyslogIdentifier=easy-devops

[Install]
WantedBy=multi-user.target
`;
}

/** What to print when systemd is absent. */
export function manualInstructions({ nodeExe, entry, dataDir }) {
  return [
    'This machine does not use systemd, so there is no unit to install.',
    '',
    'Run the daemon yourself with whatever supervisor you use. The command is:',
    '',
    `  EASY_DEVOPS_DATA_DIR=${dataDir} ${nodeExe} ${entry} daemon`,
    '',
    'It runs in the foreground, logs to stdout and stderr, and stops cleanly on',
    'SIGTERM. Anything that can keep a foreground process alive will do:',
    '',
    '  • OpenRC    — an /etc/init.d script with supervise-daemon',
    '  • runit     — a run script under /etc/service/easy-devops/',
    '  • s6        — an s6-rc service definition',
    '  • supervisord — a [program:easy-devops] section',
    '',
    'Only one daemon may run at a time; a second refuses to start and says so,',
    'so a supervisor that accidentally starts two cannot duplicate notifications.',
  ].join('\n');
}

/**
 * Installs and starts the unit.
 *
 * sudo asks for the
 * password, on the user's terminal, in its own words. This process never sees
 * it. That also means a real TTY is required, which is checked first rather
 * than discovered as a hang.
 *
 * @param {Object} opts
 * @param {string} opts.nodeExe
 * @param {string} opts.entry
 * @param {string} opts.dataDir
 * @param {string} [opts.user]
 * @param {(line: string) => void} [opts.log]
 * @param {Function} [opts.runner]
 * @param {Function} [opts.interactive]
 * @param {string} [opts.unitPath]
 * @returns {Promise<{ ok: boolean, reason?: string, unitPath?: string }>}
 */
export async function install({
  nodeExe,
  entry,
  dataDir,
  user = os.userInfo().username,
  log = () => {},
  runner = run,
  interactive = runInteractive,
  fileRunner = runFile,
  unitPath = UNIT_PATH,
  stdin = process.stdin,
} = {}) {
  if (!stdin?.isTTY) {
    return {
      ok: false,
      reason: 'installing the service needs a real terminal, because sudo has to ask for your password. '
        + 'Run `ezz service install` from a shell rather than from a script or the dashboard.',
    };
  }

  const unit = buildUnit({ nodeExe, entry, user, dataDir });

  const written = await writeUnit(unit, { fileRunner, interactive, unitPath, log });
  if (!written.ok) return written;
  const enable = await interactive(`sudo systemctl enable ${UNIT_NAME}`);
  if (!enable.success) return { ok: false, reason: `systemctl enable ${UNIT_NAME} failed` };

  const start = await interactive(`sudo systemctl restart ${UNIT_NAME}`);
  if (!start.success) {
    const recent = await journal({ lines: 20, runner });
    return {
      ok: false,
      reason: `the service was installed but would not start.\n\nLast log lines:\n${recent.output}`,
      unitPath,
    };
  }

  return { ok: true, unitPath };
}

async function writeUnit(unit, { fileRunner = runFile, interactive = runInteractive, unitPath = UNIT_PATH, log = () => {} } = {}) {
  let stagingDir;
  try {
    let staged;
    try {
      // mkdtemp creates the directory atomically with mode 0700 on Linux.
      stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-devops-unit-'));
      staged = path.join(stagingDir, UNIT_NAME);
      fs.writeFileSync(staged, unit, { flag: 'wx', mode: 0o600 });
    } catch (err) {
      return { ok: false, reason: `could not stage the unit file: ${err.message}` };
    }

    log(`Installing ${unitPath} (sudo will ask for your password)`);
    // sudo reads passwords directly from its controlling terminal.
    const copy = await fileRunner('sudo', ['install', '-m', '0644', '--', staged, unitPath], { timeout: 300_000 });
    if (!copy.success) {
      return { ok: false, reason: `could not write ${unitPath}. sudo exited ${copy.exitCode ?? 'non-zero'}.` };
    }

    const reload = await interactive('sudo systemctl daemon-reload');
    if (!reload.success) return { ok: false, reason: 'systemctl daemon-reload failed' };

    return { ok: true };
  } finally {
    if (stagingDir) fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

// Preserve the installed service identity, limits and other operator settings.
export async function refreshUnit({ entry, dataDir, unitPath = UNIT_PATH, ...options }) {
  const original = fs.readFileSync(unitPath, 'utf8');
  if (!/^\[Service\]$/m.test(original) || !/^ExecStart=.* daemon$/m.test(original)) {
    return { ok: false, reason: 'Unrecognized service definition. Review the unit before repair.' };
  }
  let updated = original;
  for (const setting of ['WS_NO_BUFFER_UTIL=1', 'WS_NO_UTF_8_VALIDATE=1', 'NODE_OPTIONS=', 'NODE_PATH=']) {
    if (!updated.split('\n').includes(`Environment=${setting}`)) updated = updated.replace('[Service]', `[Service]\nEnvironment=${setting}`);
  }
  if (!/^ExecStart=.*--experimental-loader=/m.test(updated)) {
    const line = buildUnit({ nodeExe: runtimeNodePath(dataDir), entry, dataDir, user: 'unused' }).match(/^ExecStart=.*$/m)[0];
    updated = updated.replace(/^ExecStart=.* daemon$/m, () => line);
  }
  return updated === original ? { ok: true } : writeUnit(updated, { ...options, unitPath });
}

/**
 * Stops, disables and removes the unit.
 *
 * Every step tolerates "already gone": uninstall must succeed on a machine
 * where the user removed the unit by hand, or they are left unable to clean up
 * through the tool at all.
 */
export async function uninstall({
  log = () => {},
  interactive = runInteractive,
  fileRunner = runFile,
  unitPath = UNIT_PATH,
  stdin = process.stdin,
} = {}) {
  if (!stdin?.isTTY) {
    return {
      ok: false,
      reason: 'removing the service needs a real terminal, because sudo has to ask for your password.',
    };
  }

  log(`Removing ${unitPath} (sudo will ask for your password)`);

  await interactive(`sudo systemctl stop ${UNIT_NAME} || true`);
  await interactive(`sudo systemctl disable ${UNIT_NAME} || true`);
  const remove = await fileRunner('sudo', ['rm', '-f', '--', unitPath], { timeout: 300_000 });
  if (!remove.success) return { ok: false, reason: `could not remove ${unitPath}` };

  const reload = await interactive('sudo systemctl daemon-reload');
  if (!reload.success) return { ok: false, reason: 'systemctl daemon-reload failed' };
  await interactive(`sudo systemctl reset-failed ${UNIT_NAME} || true`);

  return { ok: true };
}

/** `systemctl restart`, which needs no password beyond sudo's own prompt. */
export async function restart({ interactive = runInteractive } = {}) {
  const result = await interactive(`sudo systemctl restart ${UNIT_NAME}`);
  return { ok: result.success, reason: result.success ? null : `systemctl restart ${UNIT_NAME} failed` };
}

/**
 * `systemctl stop` — temporary. The unit stays enabled, so the daemon comes
 * back at the next boot. Removing it permanently is `ezz service uninstall`.
 */
export async function stop({ interactive = runInteractive } = {}) {
  if (!fs.existsSync(UNIT_PATH)) {
    return { ok: false, reason: 'the service is not installed, so there is nothing to stop' };
  }
  if (!process.stdin.isTTY) {
    return {
      ok: false,
      reason: 'stopping the service needs a terminal, because sudo has to ask for your password.',
    };
  }

  const result = await interactive(`sudo systemctl stop ${UNIT_NAME}`);
  return { ok: result.success, reason: result.success ? null : `systemctl stop ${UNIT_NAME} failed` };
}

/** `systemctl start`. */
export async function start({ interactive = runInteractive } = {}) {
  if (!fs.existsSync(UNIT_PATH)) {
    return { ok: false, reason: 'the service is not installed; run `ezz service install` first' };
  }
  if (!process.stdin.isTTY) {
    return {
      ok: false,
      reason: 'starting the service needs a terminal, because sudo has to ask for your password.',
    };
  }

  const result = await interactive(`sudo systemctl start ${UNIT_NAME}`);
  return { ok: result.success, reason: result.success ? null : `systemctl start ${UNIT_NAME} failed` };
}

/**
 * Recent log lines, from the journal.
 *
 * Read with plain `journalctl` and no sudo: a unit running as the current user
 * logs where that user can read it, and requiring sudo to read your own logs
 * would be a password prompt for a status command.
 */
export async function journal({ lines = 50, runner = run } = {}) {
  const result = await runner(
    `journalctl -u ${UNIT_NAME} -n ${Math.max(1, Math.min(5000, Number(lines) || 50))} --no-pager`,
    { timeout: 20_000 },
  );

  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();

  if (!result.success) {
    return {
      ok: false,
      output: output || `journalctl could not read the unit's logs. If this says "No journal files were found", `
        + 'the journal is not persistent on this machine.',
    };
  }

  return { ok: true, output };
}

/**
 * The unit's state, including whether it is in a crash loop.
 *
 * A crash loop is the failure mode a naive status read misses: `is-active`
 * says `activating` while systemd is restarting a daemon that dies every five
 * seconds, which reads as "starting up" for ever. `NRestarts` is what reveals
 * it, so it is read explicitly and reported.
 *
 * @param {Object} [opts]
 * @returns {Promise<Object>}
 */
export async function status({ runner = run } = {}) {
  const installed = fs.existsSync(UNIT_PATH);

  if (!installed) {
    return {
      installed: false,
      running: false,
      enabledOnBoot: false,
      state: 'not installed',
      restarts: 0,
      crashLooping: false,
      unitPath: UNIT_PATH,
    };
  }

  // One call for several properties: cheaper than four systemctl invocations,
  // and consistent — four calls can straddle a state change.
  const props = await runner(
    `systemctl show ${UNIT_NAME} --property=ActiveState --property=SubState --property=NRestarts `
    + '--property=UnitFileState --property=ExecMainStartTimestamp --property=Result --no-pager',
    { timeout: 15_000 },
  );

  const parsed = Object.fromEntries(
    (props.stdout || '').split('\n')
      .map((line) => line.split('='))
      .filter((pair) => pair.length >= 2)
      .map(([key, ...rest]) => [key.trim(), rest.join('=').trim()]),
  );

  const activeState = parsed.ActiveState || 'unknown';
  const restarts = Number(parsed.NRestarts) || 0;

  // Restarting repeatedly, or stopped by the start limit. Either way the
  // daemon is not staying up, which is the thing worth saying.
  const crashLooping = restarts >= 3 && activeState !== 'active'
    || parsed.Result === 'start-limit-hit'
    || (activeState === 'failed' && restarts >= 3);

  return {
    installed: true,
    running: activeState === 'active',
    enabledOnBoot: parsed.UnitFileState === 'enabled',
    state: parsed.SubState ? `${activeState} (${parsed.SubState})` : activeState,
    restarts,
    crashLooping,
    result: parsed.Result || null,
    startedAt: parsed.ExecMainStartTimestamp || null,
    unitPath: UNIT_PATH,
  };
}

/**
 * Re-points the runtime symlink and reloads the unit.
 *
 * The repair case this exists for: the user upgraded Node through nvm, the old
 * version was removed, and the link now points at nothing. Re-pointing the
 * link is enough — the unit itself refers to the link, not to a Node version,
 * which is the entire reason it is a link.
 */
export async function repair({ dataDir, entry, nodeExe = process.execPath, log = () => {}, interactive = runInteractive } = {}) {
  const { linkRuntime } = await import('./runtime.js');

  const linked = linkRuntime({ dataDir, nodeExe });
  if (!linked.ok) return { ok: false, reason: linked.reason };
  log(`Runtime link → ${linked.target}`);

  if (!fs.existsSync(UNIT_PATH)) {
    return { ok: true, relinked: true, reason: 'the runtime link was fixed; no unit is installed' };
  }

  if (!process.stdin.isTTY) {
    return {
      ok: false,
      reason: 'the runtime link was fixed, but restarting the unit needs a terminal for sudo.',
    };
  }

  if (entry) {
    const result = await refreshUnit({ dataDir, entry, interactive, log });
    if (!result.ok) return { ...result, relinked: true };
  }
  const result = await interactive(`sudo systemctl restart ${UNIT_NAME}`);
  return result.success
    ? { ok: true, relinked: true, target: linked.target }
    : { ok: false, reason: `the link was fixed but \`systemctl restart ${UNIT_NAME}\` failed` };
}

/** The pinned runtime path for this data directory. Re-exported for the installer. */
export { runtimeNodePath };
