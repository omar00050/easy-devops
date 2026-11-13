/**
 * core/service.js
 *
 * Runs the Easy DevOps dashboard as a background service, through PM2.
 *
 * core/runner.js is the generic PM2 wrapper; this module is the policy on top
 * of it: which app name, which script, how "start on boot" is arranged per
 * platform, and what counts as installed.
 *
 * Start on boot, per platform
 * ---------------------------
 * Linux / macOS: INSTALLING uses `pm2 startup`, which detects the init system
 * and prints a command to run under sudo. That command is shown to the user,
 * never executed — Easy DevOps does not want broad sudoers rules for this.
 *
 * DETECTING is a different matter: `pm2 startup` is not a query. Given the
 * rights to act — running as root, typically — it installs the hook, so using
 * it to read state would silently enable start-on-boot during a status check.
 * bootStatus() therefore inspects the init system directly
 * (`systemctl is-enabled pm2-<user>`) and reports `enabled: null` — unknown —
 * on anything that is not systemd, rather than guessing.
 *
 * The boot mechanism is SHARED with every other PM2 app on the machine: one
 * systemd unit, one scheduled task, one Startup launcher, each just running
 * `pm2 resurrect`. uninstall() therefore removes it only when no other apps
 * remain in PM2's saved list.
 *
 * Windows: `pm2 startup` is not supported at all, so there are two modes.
 *
 *   logon ("personal/dev machine")
 *     A launcher in the user's Startup folder running `pm2 resurrect`. No
 *     administrator rights, no password. Starts at logon and stops when the
 *     user signs out, so it is wrong for a headless server.
 *
 *   boot ("server")
 *     A Task Scheduler task at system startup, as the same user, with a 30
 *     second delay. Survives a reboot with nobody logged in. It requires an
 *     elevated, interactive terminal, because the task needs a stored password
 *     and `schtasks /RP *` makes WINDOWS prompt for it — Easy DevOps never
 *     sees, logs, stores or passes the password. That is also why this mode is
 *     CLI-only and the dashboard can only report on it.
 *
 * The chosen mode is recorded so status can report it; it is not a source of
 * truth, and status always re-checks the task and the launcher file.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { run as defaultRun, runInteractive as defaultRunInteractive } from './shell.js';
import { dbGet, dbSet } from './db.js';
import {
  isWindows,
  getDataDir,
  isDevDataDir,
  getStartupFolder,
  windowsStartupLauncher,
  windowsBootTaskCmd,
  windowsBootTaskDeleteCmd,
  windowsBootTaskQueryCmd,
  windowsIsElevatedCmd,
  windowsProductTypeCmd,
  pm2SystemdUnit,
  hasSystemctlCmd,
  systemdIsEnabledCmd,
  WINDOWS_STARTUP_FILE,
  WINDOWS_BOOT_TASK,
} from './platform.js';
import * as runner from './runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The script PM2 runs: the CLI entry point, with --dash. */
const CLI_ENTRY = path.resolve(__dirname, '..', 'cli', 'index.js');

/** Where the chosen boot mode is remembered. */
const SERVICE_KEY = 'service-state';

/** Windows boot mechanisms. */
export const BOOT_MODES = Object.freeze({
  LOGON: 'logon',
  BOOT: 'boot',
});

/**
 * Collects the injectable dependencies.
 * Tests pass their own `run` and `startupDir` so that no real scheduled task
 * is created and nothing is written to the real Startup folder.
 */
function deps(overrides = {}) {
  return {
    run: overrides.run ?? defaultRun,
    runInteractive: overrides.runInteractive ?? defaultRunInteractive,
    startupDir: overrides.startupDir ?? getStartupFolder(),
    pm2Path: overrides.pm2Path ?? 'pm2',
    // An explicitly supplied path is trusted instead of looking PM2 up on
    // PATH. Production never passes one; tests do, and without this every
    // entry point here would re-resolve — and then use — the real PM2.
    pm2PathGiven: typeof overrides.pm2Path === 'string' && overrides.pm2Path.length > 0,
  };
}

/**
 * Locates PM2, or trusts an injected path.
 * @returns {Promise<{ installed: boolean, version: string|null, path: string|null }>}
 */
async function resolvePm2({ run, pm2Path, pm2PathGiven, probeVersion = true }) {
  if (pm2PathGiven) return { installed: true, version: null, path: pm2Path };
  return runner.detect({ run, probeVersion });
}

/** @returns {{ mode: string|null, installedAt: string|null }} */
export function readServiceState() {
  const s = dbGet(SERVICE_KEY);
  if (!s || typeof s !== 'object') return { mode: null, installedAt: null };
  return { mode: s.mode ?? null, installedAt: s.installedAt ?? null };
}

function writeServiceState(next) {
  dbSet(SERVICE_KEY, next);
}

// ─── status cache ─────────────────────────────────────────────────────────────
//
// A status read shells out several times: locating PM2, listing its processes,
// and querying the scheduled task or the systemd unit. The dashboard polls it,
// the Settings page asks for it, and the hub agent reports it — so without a
// cache the same handful of subprocesses run over and over for an answer that
// changes only when someone installs, uninstalls or restarts the service.
//
// Deliberately short: anything that changes the answer from OUTSIDE this
// process (a user deleting the scheduled task, PM2 crashing) is still picked
// up within a minute, and everything this module does itself invalidates it
// immediately.

/** How long a status result stays fresh. */
const STATUS_CACHE_MS = 60_000;

let statusCache = null;

/**
 * Identity for an injected function, so two different `run`s never share a
 * cache entry. Production passes none, so this stays empty there.
 */
const runnerIds = new WeakMap();
let nextRunnerId = 1;

function runIdentity(fn) {
  if (typeof fn !== 'function') return 0;
  if (!runnerIds.has(fn)) runnerIds.set(fn, nextRunnerId++);
  return runnerIds.get(fn);
}

/**
 * Cache key.
 *
 * Includes the injected dependencies — by identity, not merely by presence, so
 * an answer computed through one `run` is never served to a caller that passed
 * a different one — and the data directory, because dev mode is a different
 * service entirely.
 */
function statusCacheKey(overrides, dev) {
  return JSON.stringify([
    overrides.pm2Path ?? null,
    overrides.startupDir ?? null,
    overrides.allowDaemonStart === true,
    runIdentity(overrides.run),
    dev,
    getDataDir(),
  ]);
}

/**
 * Drops the cached status.
 *
 * Called automatically by install(), uninstall() and restart(). Exported so a
 * caller that changes the service by other means — or a test — can force the
 * next read to be real.
 */
export function invalidateStatusCache() {
  statusCache = null;
}

/** Absolute path of the Windows logon launcher, or null. */
export function startupLauncherPath(startupDir = getStartupFolder()) {
  return startupDir ? path.join(startupDir, WINDOWS_STARTUP_FILE) : null;
}

/**
 * True when this Windows session can create an at-boot task.
 * @returns {Promise<boolean>}
 */
export async function isElevated(overrides = {}) {
  if (!isWindows) return false;
  const { run } = deps(overrides);
  const r = await run(windowsIsElevatedCmd(), { timeout: 15_000 });
  return r.stdout.trim() === '1';
}

/**
 * True on Windows Server (or a domain controller), which is what makes "boot"
 * the sensible default there. ProductType: 1 workstation, 2 DC, 3 server.
 * @returns {Promise<boolean>}
 */
export async function isWindowsServer(overrides = {}) {
  if (!isWindows) return false;
  const { run } = deps(overrides);
  const r = await run(windowsProductTypeCmd(), { timeout: 15_000 });
  const n = Number(r.stdout.trim());
  return Number.isFinite(n) && n !== 1;
}

/**
 * The boot mode to offer by default on Windows.
 * @returns {Promise<'boot'|'logon'>}
 */
export async function defaultBootMode(overrides = {}) {
  return (await isWindowsServer(overrides)) ? BOOT_MODES.BOOT : BOOT_MODES.LOGON;
}

/**
 * Everything the CLI, the dashboard and the hub agent need to describe the
 * service, in one read.
 *
 * `enabledOnBoot` is re-derived from the system every time rather than trusted
 * from the database: a user can delete a scheduled task or a Startup entry
 * behind our back, and reporting "enabled" then would be a lie.
 *
 * This NEVER starts the PM2 daemon. Every pm2 command — `pm2 --version`
 * included — starts it, so a status read would otherwise spawn a PM2 daemon
 * on a machine that does not use PM2, just because the dashboard was opened
 * or the hub agent reported in. When the daemon is down nothing can be
 * running, so that is reported directly and PM2 is left alone. Pass
 * `allowDaemonStart: true` from a path where the user has asked for PM2 work.
 *
 * @returns {Promise<{
 *   pm2: { installed: boolean, version: string|null, path: string|null },
 *   appName: string, dev: boolean, dataDir: string,
 *   installed: boolean, running: boolean, status: string|null,
 *   app: Object|null,
 *   enabledOnBoot: boolean|null, bootMode: string|null, bootDetail: string|null,
 *   sameUser: boolean, currentUser: string, appUser: string|null,
 *   pm2Home: string|null,
 * }>}
 */
export async function status(overrides = {}) {
  const { run, startupDir, pm2Path, pm2PathGiven } = deps(overrides);
  const allowDaemonStart = overrides.allowDaemonStart === true;
  const dev = isDevDataDir();

  // `fresh: true` bypasses the cache for a caller that must see the system as
  // it is right now.
  const cacheKey = statusCacheKey(overrides, dev);
  if (overrides.fresh !== true &&
      statusCache &&
      statusCache.key === cacheKey &&
      Date.now() - statusCache.at < STATUS_CACHE_MS) {
    return statusCache.value;
  }

  const name = runner.appName(dev);
  const daemonRunning = runner.isDaemonRunning();
  const mayTalkToPm2 = allowDaemonStart || daemonRunning;

  const pm2 = await resolvePm2({ run, pm2Path, pm2PathGiven, probeVersion: mayTalkToPm2 });

  const base = {
    pm2: { installed: pm2.installed, version: pm2.version, path: pm2.path },
    appName: name,
    dev,
    dataDir: getDataDir(),
    daemonRunning,
    installed: false,
    running: false,
    status: null,
    app: null,
    enabledOnBoot: false,
    bootMode: readServiceState().mode,
    bootDetail: null,
    sameUser: true,
    currentUser: runner.currentUser(),
    appUser: null,
    pm2Home: runner.pm2Home(),
  };

  if (!pm2.installed) return remember(cacheKey, base);

  const resolvedPm2 = pm2.path ?? pm2Path;

  // With the daemon down there is nothing to list, and asking would start it.
  // `installed` then falls back to what the last install recorded.
  const recorded = readServiceState();
  const listed = mayTalkToPm2
    ? await runner.list({ run, pm2Path: resolvedPm2 })
    : { ok: false, apps: [], error: 'PM2 daemon is not running' };
  const app = listed.ok ? listed.apps.find((a) => a.name === name) ?? null : null;

  const boot = await bootStatus({
    ...overrides, run, startupDir, pm2Path: resolvedPm2, mayTalkToPm2,
  });

  return remember(cacheKey, {
    ...base,
    installed: mayTalkToPm2 ? app !== null : Boolean(recorded.installedAt),
    running: app?.status === 'online',
    status: app?.status ?? null,
    app,
    enabledOnBoot: boot.enabled,
    bootMode: boot.mode ?? base.bootMode,
    bootDetail: boot.detail,
    // PM2 is per-user: an app owned by someone else cannot be controlled here.
    sameUser: !app?.user || app.user === runner.currentUser(),
    appUser: app?.user ?? null,
  });
}

/** Stores a status result in the cache and returns it. */
function remember(key, value) {
  statusCache = { key, at: Date.now(), value };
  return value;
}

/**
 * Whether start-on-boot is actually arranged, and by which mechanism.
 * @returns {Promise<{ enabled: boolean, mode: string|null, detail: string|null }>}
 */
export async function bootStatus(overrides = {}) {
  const { run, startupDir } = deps(overrides);

  if (isWindows) {
    // A scheduled task wins: it is the stronger of the two mechanisms.
    const task = await run(windowsBootTaskQueryCmd(), { timeout: 20_000 });
    if (task.success && new RegExp(WINDOWS_BOOT_TASK, 'i').test(task.stdout)) {
      return {
        enabled: true,
        mode: BOOT_MODES.BOOT,
        detail: `Task Scheduler task "${WINDOWS_BOOT_TASK}" runs at system startup.`,
      };
    }

    const launcher = startupLauncherPath(startupDir);
    if (launcher) {
      try {
        await fs.access(launcher);
        return {
          enabled: true,
          mode: BOOT_MODES.LOGON,
          detail: `Startup launcher ${launcher} runs at logon. Signing out stops the service.`,
        };
      } catch { /* not installed */ }
    }

    return { enabled: false, mode: null, detail: null };
  }

  // ── Linux / macOS ─────────────────────────────────────────────────────────
  //
  // This inspects the init system directly and NEVER runs `pm2 startup`.
  // That command is not a query: when it has the rights to act — running as
  // root, typically — it installs the hook. Using it to "detect" state would
  // mean a status read silently enabling start-on-boot. It also starts the PM2
  // daemon, which a status read must not do either.
  //
  // `systemctl is-enabled pm2-<user>` only reads, and the unit name is fixed
  // by PM2, so it is a reliable signal where systemd exists.
  const user = runner.currentUser();
  const unit = pm2SystemdUnit(user);

  const hasSystemctl = await run(hasSystemctlCmd(), { timeout: 10_000 });
  if (!hasSystemctl.success || !hasSystemctl.stdout.trim()) {
    // openrc, launchd, SysV… PM2 supports several. Rather than guess from a
    // recorded value that may be stale, say so.
    return {
      enabled: null,
      mode: readServiceState().mode,
      detail: 'Cannot tell: this system does not use systemd, so the PM2 boot hook cannot be checked from here.',
    };
  }

  const enabled = await run(systemdIsEnabledCmd(user), { timeout: 10_000 });
  const verdict = enabled.stdout.trim().toLowerCase();

  if (verdict === 'enabled' || verdict === 'enabled-runtime') {
    return {
      enabled: true,
      mode: BOOT_MODES.BOOT,
      detail: `systemd unit ${unit} is enabled.`,
    };
  }

  if (verdict === 'disabled' || verdict === 'masked' || verdict === 'static') {
    return { enabled: false, mode: null, detail: `systemd unit ${unit} exists but is ${verdict}.` };
  }

  // `is-enabled` fails for a unit that does not exist, which is the normal
  // "never installed" case.
  return { enabled: false, mode: null, detail: null };
}

/**
 * Starts the dashboard under PM2 and, optionally, arranges start on boot.
 *
 * The caller is responsible for having asked the user before PM2 or
 * pm2-logrotate get installed — this function only reports what is missing
 * unless it is told it may install.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.installPm2=false]       May install PM2 if absent
 * @param {boolean} [opts.installLogrotate=false] May install pm2-logrotate
 * @param {string|null} [opts.bootMode=null]      'logon' | 'boot' | null to skip
 * @param {number} [opts.delaySeconds=30]         Boot-task delay (Windows 'boot')
 * @returns {Promise<{ ok: boolean, steps: Array<{step: string, ok: boolean, detail: string}>,
 *                     error: string|null, sudoCommand: string|null, status: Object|null }>}
 */
export async function install(opts = {}) {
  const {
    installPm2 = false,
    installLogrotate = false,
    bootMode = null,
    delaySeconds = 30,
  } = opts;
  const { run, runInteractive, startupDir, pm2Path: givenPm2, pm2PathGiven } = deps(opts);

  const steps = [];
  const note = (step, ok, detail = '') => { steps.push({ step, ok, detail }); };

  // ── PM2 itself ────────────────────────────────────────────────────────────
  let pm2 = await resolvePm2({ run, pm2Path: givenPm2, pm2PathGiven });
  if (!pm2.installed) {
    if (!installPm2) {
      return {
        ok: false, steps, sudoCommand: null, status: null,
        error: 'PM2 is not installed. Install it first (the CLI and the dashboard ask before doing so).',
      };
    }
    const res = await runner.install({ run });
    note('install PM2', res.ok, res.output.slice(0, 400));
    if (!res.ok) {
      return { ok: false, steps, sudoCommand: null, status: null, error: 'Could not install PM2.' };
    }
    pm2 = await resolvePm2({ run, pm2Path: givenPm2, pm2PathGiven });
    if (!pm2.installed) {
      return {
        ok: false, steps, sudoCommand: null, status: null,
        error: 'PM2 was installed but is still not on PATH. Open a new terminal and try again.',
      };
    }
  } else {
    note('PM2 present', true, `v${pm2.version ?? '?'} at ${pm2.path}`);
  }

  const pm2Path = pm2.path ?? 'pm2';

  // ── pm2-logrotate, so PM2's own logs cannot fill the disk ─────────────────
  if (await runner.hasLogrotate({ run, pm2Path })) {
    note('pm2-logrotate present', true);
  } else if (installLogrotate) {
    const res = await runner.installLogrotate({ run, pm2Path });
    note('install pm2-logrotate', res.ok, res.output.slice(0, 300));
  } else {
    note('pm2-logrotate', false, 'not installed — PM2 logs will grow unbounded');
  }

  // ── The app ───────────────────────────────────────────────────────────────
  const dev = isDevDataDir();
  const name = runner.appName(dev);

  // Replace any existing instance rather than stacking a second one on the
  // same port. Whether one existed matters for the failure message below: if
  // the delete succeeded and the start then failed, the user is left with NO
  // service where they previously had a working one, and must be told plainly
  // rather than being left to discover it.
  const before = await runner.list({ run, pm2Path });
  const hadPrevious = before.ok && before.apps.some((a) => a.name === name);

  // `delete` on a name PM2 does not know is a harmless no-op.
  await runner.del(name, { run, pm2Path });
  if (hadPrevious) note(`remove previous ${name}`, true, 'replacing the existing service');

  const started = await runner.start({
    script: CLI_ENTRY,
    name,
    args: ['--dash'],
    run,
    pm2Path,
  });
  note(`start ${name}`, started.ok, started.output.slice(0, 400));
  if (!started.ok) {
    invalidateStatusCache();
    const removedWarning = hadPrevious
      ? ` The previous "${name}" service was removed before this attempt, so nothing is running now` +
        ' — fix the error above and run `ezz service install` again.'
      : '';
    return {
      ok: false,
      steps,
      sudoCommand: null,
      status: null,
      previousRemoved: hadPrevious,
      error: `Could not start ${name}.${removedWarning}`,
    };
  }

  // `pm2 save` writes the process list that `pm2 resurrect` restores. Without
  // it, nothing comes back after a reboot no matter which boot mode is used.
  const saved = await runner.save({ run, pm2Path });
  note('pm2 save', saved.ok, saved.output.slice(0, 200));

  // ── Start on boot ─────────────────────────────────────────────────────────
  let sudoCommand = null;

  if (bootMode === null) {
    note('start on boot', false, 'skipped');
  } else if (!isWindows) {
    const r = await runner.startup({ run, pm2Path });
    sudoCommand = r.sudoCommand;
    // PM2 asks for root here. Printing the command instead of running it under
    // sudo keeps this out of sudoers entirely.
    note('pm2 startup', r.ok, sudoCommand ? 'run the printed command as root to finish' : r.output.slice(0, 300));
    writeServiceState({ mode: BOOT_MODES.BOOT, installedAt: new Date().toISOString() });
  } else if (bootMode === BOOT_MODES.LOGON) {
    const res = await writeLogonLauncher(pm2Path, startupDir);
    note('logon launcher', res.ok, res.detail);
    if (res.ok) writeServiceState({ mode: BOOT_MODES.LOGON, installedAt: new Date().toISOString() });
  } else if (bootMode === BOOT_MODES.BOOT) {
    const res = await createBootTask({ pm2Path, delaySeconds, run, runInteractive });
    note('boot task', res.ok, res.detail);
    if (res.ok) writeServiceState({ mode: BOOT_MODES.BOOT, installedAt: new Date().toISOString() });
    if (!res.ok) {
      return {
        ok: false, steps, sudoCommand: null, error: res.detail,
        status: await status({ ...opts, run, allowDaemonStart: true, fresh: true }),
      };
    }
  }

  // Record the install regardless of boot mode. status() falls back to this
  // when the PM2 daemon is down, and asking PM2 then would start it.
  // writeServiceState above may already have set a mode; keep it.
  const recordedMode = readServiceState().mode;
  writeServiceState({ mode: recordedMode, installedAt: new Date().toISOString() });
  invalidateStatusCache();

  return {
    ok: true,
    steps,
    error: null,
    sudoCommand,
    previousRemoved: hadPrevious,
    status: await status({ ...opts, run, allowDaemonStart: true, fresh: true }),
  };
}

/**
 * Removes the service: the PM2 app, the saved process list entry, and whichever
 * boot mechanism is in place.
 *
 * Deliberately does NOT uninstall PM2 or pm2-logrotate — the user may well be
 * running other things under PM2, and removing it would take those down too.
 *
 * @returns {Promise<{ ok: boolean, steps: Array<Object>, sudoCommand: string|null }>}
 */
export async function uninstall(opts = {}) {
  const { run, startupDir, pm2Path: givenPm2, pm2PathGiven } = deps(opts);
  const steps = [];
  const note = (step, ok, detail = '') => { steps.push({ step, ok, detail }); };

  const pm2 = await resolvePm2({ run, pm2Path: givenPm2, pm2PathGiven });
  const pm2Path = pm2.path ?? 'pm2';
  const name = runner.appName(isDevDataDir());

  // Anything PM2 still supervises once our app is gone. The boot mechanism is
  // SHARED — one systemd unit, one scheduled task, one Startup launcher, all
  // of which simply run `pm2 resurrect` — so removing it because WE are done
  // would stop every other app on the machine from coming back after a reboot.
  let remaining = [];
  let remainingKnown = false;

  if (pm2.installed) {
    const removed = await runner.del(name, { run, pm2Path });
    note(`delete ${name}`, removed.ok, removed.output.slice(0, 300));

    // Save first, so the saved list that `pm2 resurrect` reads no longer
    // mentions our app, and so the list we inspect below is the saved one.
    const saved = await runner.save({ run, pm2Path });
    note('pm2 save', saved.ok, saved.output.slice(0, 200));

    const listed = await runner.list({ run, pm2Path });
    if (listed.ok) {
      remainingKnown = true;
      remaining = listed.apps.filter((a) => a.name !== name);
    } else {
      note('read remaining PM2 apps', false, listed.error ?? 'could not read the process list');
    }
  } else {
    // No PM2 means no other apps can depend on the boot hook either.
    note('PM2 present', false, 'PM2 is not installed; nothing to remove from it');
    remainingKnown = true;
  }

  // When the list could not be read, keep the boot mechanism: leaving a hook
  // behind is recoverable, breaking someone else's reboot is not.
  const othersRemain = !remainingKnown || remaining.length > 0;
  const otherNames = remaining.map((a) => a.name).join(', ');

  let sudoCommand = null;
  let keptBootMechanism = false;

  if (othersRemain) {
    keptBootMechanism = true;
    const why = remainingKnown
      ? `${remaining.length} other PM2 app(s) still rely on it: ${otherNames}`
      : 'the PM2 app list could not be read, so it is left in place to be safe';
    note('keep start-on-boot', true, why);
  } else if (isWindows) {
    const launcher = startupLauncherPath(startupDir);
    if (launcher) {
      try {
        await fs.unlink(launcher);
        note('remove logon launcher', true, launcher);
      } catch (err) {
        note('remove logon launcher', err.code === 'ENOENT', err.code === 'ENOENT' ? 'none present' : err.message);
      }
    }

    const query = await run(windowsBootTaskQueryCmd(), { timeout: 20_000 });
    if (query.success && new RegExp(WINDOWS_BOOT_TASK, 'i').test(query.stdout)) {
      const del = await run(windowsBootTaskDeleteCmd(), { timeout: 20_000 });
      note('remove boot task', del.success,
        del.success ? WINDOWS_BOOT_TASK : 'needs an Administrator PowerShell');
    } else {
      note('remove boot task', true, 'none present');
    }
  } else if (pm2.installed) {
    const r = await runner.unstartup({ run, pm2Path });
    sudoCommand = r.sudoCommand;
    note('pm2 unstartup', r.ok, sudoCommand ? 'run the printed command as root to finish' : r.output.slice(0, 200));
  }

  writeServiceState({ mode: null, installedAt: null });
  invalidateStatusCache();

  return {
    ok: true,
    steps,
    sudoCommand,
    /** True when start-on-boot was deliberately left in place. */
    keptBootMechanism,
    /** Names of the PM2 apps that kept it alive, for the caller to report. */
    remainingApps: remaining.map((a) => a.name),
  };
}

/** Restarts the service. Used by the CLI and after an update. */
export async function restart(opts = {}) {
  const { run, pm2Path, pm2PathGiven } = deps(opts);
  const pm2 = await resolvePm2({ run, pm2Path, pm2PathGiven });
  if (!pm2.installed) return { ok: false, output: 'PM2 is not installed.' };

  const result = await runner.restart(runner.appName(isDevDataDir()), {
    run, pm2Path: pm2.path ?? 'pm2',
  });
  // Uptime and restart count have both just changed.
  invalidateStatusCache();
  return result;
}

/** Recent service log lines. */
export async function logs(opts = {}) {
  const { run, pm2Path, pm2PathGiven } = deps(opts);
  const pm2 = await resolvePm2({ run, pm2Path, pm2PathGiven });
  if (!pm2.installed) return { ok: false, lines: [], output: 'PM2 is not installed.' };
  return runner.logs(runner.appName(isDevDataDir()), {
    lines: opts.lines ?? 200, run, pm2Path: pm2.path ?? 'pm2',
  });
}

// ─── Windows boot mechanisms ──────────────────────────────────────────────────

/**
 * Writes the logon launcher into the Startup folder.
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
export async function writeLogonLauncher(pm2Path, startupDir = getStartupFolder()) {
  const target = startupLauncherPath(startupDir);
  if (!target) return { ok: false, detail: 'No Startup folder on this platform.' };

  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, windowsStartupLauncher(pm2Path), 'utf8');
    return { ok: true, detail: target };
  } catch (err) {
    return { ok: false, detail: `Could not write ${target}: ${err.message}` };
  }
}

/**
 * Creates the at-boot scheduled task.
 *
 * Runs through runInteractive so that `schtasks /RP *` can prompt on the real
 * console: Windows collects the password itself and Easy DevOps never handles
 * it. That is also why there is no dashboard path to this — an HTTP request
 * has no terminal to prompt on.
 *
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
export async function createBootTask({
  pm2Path,
  delaySeconds = 30,
  run = defaultRun,
  runInteractive = defaultRunInteractive,
  user = runner.currentUser(),
} = {}) {
  if (!isWindows) return { ok: false, detail: 'Scheduled tasks are Windows-only.' };

  if (!(await isElevated({ run }))) {
    return {
      ok: false,
      detail: 'Creating a start-at-boot task needs administrator rights. ' +
        'Re-run `ezz service install` in an Administrator PowerShell.',
    };
  }

  if (!process.stdin.isTTY) {
    return {
      ok: false,
      detail: 'Windows must prompt for the account password, which needs a real terminal. ' +
        'Run `ezz service install` in an Administrator PowerShell.',
    };
  }

  const cmd = windowsBootTaskCmd({ pm2Path, user, delaySeconds });
  const res = await runInteractive(cmd);

  return res.success
    ? { ok: true, detail: `Task "${WINDOWS_BOOT_TASK}" created, ${delaySeconds}s after startup, as ${user}.` }
    : { ok: false, detail: 'schtasks did not create the task (wrong password, or cancelled).' };
}
