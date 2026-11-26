/**
 * core/deploy/engine.js
 *
 * Puts a project on the server and keeps the previous version one step away.
 *
 * One deployment, in order:
 *
 *   1. fetch     a fresh checkout into releases/<id> — never over the live one
 *   2. settings  ez.json + package.json + the app's overrides (ezfile.js)
 *   3. pre hook → the steps list (install/build/migrate/custom) in order
 *   4. switch    stop the old process, start the new one under PM2
 *   5. health    the app must answer (or stay up) before it counts
 *   6. post hook, save the PM2 list, prune old releases
 *
 * Every step runs in the new release with the build's environment, before
 * anything is started. `migrate` keeps its forward-only hint: rolling the code
 * back does not undo a migration that already ran, which is why the hint on a
 * failure says to fix the migration rather than expect the rollback to undo it.
 * A disabled step is logged as skipped.
 *
 * Nothing before step 4 touches what is running, so a broken build or a failed
 * migration costs nothing. If step 4 or 5 fails and there is a previous
 * release, it is started again — the same files that were running before, not a
 * rebuild.
 *
 * Step 5 watches PM2 as well as HTTP. A release that answers once and then
 * crash-loops, or that PM2 reports errored/stopped, is a boot crash: the
 * previous release is restored, and the run records why, the last PM2 log
 * lines (with the app's environment values redacted) and whether that rollback
 * succeeded. A first release has nothing to return to, so it is stopped.
 *
 * ── What this does not do ────────────────────────────────────────────────────
 *
 * The switch is a restart, not a zero-downtime handover: the old process is
 * stopped before the new one starts, because they want the same port. The gap
 * is the app's start-up time. Running both behind nginx and switching the
 * upstream is the way to remove it, and is a later piece of work.
 *
 * ── Rules it keeps ───────────────────────────────────────────────────────────
 *
 *   - Every subprocess goes through core/shell.js; every PM2 call through
 *     core/runner.js. Both are injectable, so the whole pipeline is tested
 *     without PM2 and without a network.
 *   - An app record is trusted to be shell-safe: core/deploy/apps.js validated
 *     the id, the URL and the branch on the way in. A ref supplied at
 *     deploy time (the commit a hook names) is validated here.
 *   - One deployment per app at a time, enforced by a lock file, because the
 *     dashboard and the background service are different processes.
 */

import fs from 'fs';
import http from 'http';
import path from 'path';

import {
  commandEnvironment,
  commandEnvironmentSecrets,
  run as defaultRun,
  runFile as defaultRunFile,
  runCommandLine as defaultRunCommandLine,
} from '../shell.js';
import * as defaultRunner from '../runner.js';
import { createDeployEvent } from '../events.js';
import { sendNotification as defaultSendNotification } from '../notifier.js';
import { publish } from '../jobs/bus.js';

import { getApp, deleteApp, pm2Name, AUTH_TYPES, validateRef, setAppDir } from './apps.js';
import { sshCommand } from './deployKey.js';
import { deleteLinkedDomain, syncLinkedDomain } from './domainLink.js';
import {
  EZ_FILE_LOCATIONS, parseEzFile, resolveSettings, parseStartCommand,
} from './ezfile.js';
import { LAUNCHER_FILE, LAUNCHER_SOURCE, LAUNCHER_COMMAND_ENV } from './launcher.js';
import { RUN_STAGES, plannedSkippedStages, stageForStep } from './stages.js';
import {
  acquireLock, appPaths, engineReleaseDir, ensureAppDirs, ensureEngineReleaseDir, isId,
  listReleases, logFile, newReleaseId, pathsIn, pruneReleases, pruneRuns,
  readEngineJson, readRun, readState, releaseDir, removeEngineRelease,
  validateDeployDir, writeRun, writeState,
} from './store.js';
import { openVerifiedChild, writeFileEventual } from '../safe-file.js';
import { copyFileWithRetry, renameWithRetry } from '../atomicState.js';
import {
  LOG_SECURITY_REDACTED_V1,
  createDeployLogRedactor,
  sanitizeDeployText,
  snapshotDeploySecrets,
} from './logSecurity.js';

/** The PM2 config generated for every release. Its presence is what makes a release startable. */
export const PM2_CONFIG_FILE = 'ez.pm2.json';

const GIT_TIMEOUT_MS = 5 * 60 * 1000;
/** Installs and builds are slow on small servers; a tight limit only produces false failures. */
const STEP_TIMEOUT_MS = 20 * 60 * 1000;
const HEALTH_POLL_MS = 2000;
/** Without a port there is nothing to ask, so the app only has to stay up this long. */
const NO_PORT_SETTLE_MS = 8000;
const ROLLBACK_HEALTH_TIMEOUT_S = 30;
/**
 * How long a healthy answer must also stay online without a PM2 restart.
 * PM2's own `min_uptime` is 5 s, so a release that dies inside that window is
 * one PM2 itself considers unstable; matching it keeps the two judgements
 * aligned.
 */
const BOOT_CONFIRM_MS = 5000;
/** PM2 out+error lines kept in the run record when a release crashes at boot. */
const BOOT_LOG_LINES = 40;
/** Longest partial output line held by the logger before a safe fragment is written. */
export const MAX_LOG_FRAGMENT_CHARS = 16 * 1024;

const MIGRATE_HINT =
  'Migrations are forward-only: rolling the code back cannot undo a migration that already ran. ' +
  'Fix the migration, keep it backward-compatible for one release, and deploy again. ' +
  'The release that was running was not touched.';

export const RUN_STATUS = Object.freeze({
  RUNNING: 'running',
  SUCCESS: 'success',
  FAILED: 'failed',
  ROLLED_BACK: 'rolled_back',
});

/** A failure with the step it happened in, so the run record can say where. */
class StepError extends Error {
  constructor(step, message, { bootCrash = false, reason = null } = {}) {
    super(message);
    this.step = step;
    this.bootCrash = bootCrash;
    this.reason = reason;
  }
}

const sleepFor = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Health ───────────────────────────────────────────────────────────────────

/**
 * One GET against the app on loopback.
 * @returns {Promise<{ ok: boolean, status: number|null, error: string|null }>}
 */
export function probeHttp(port, healthPath, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: healthPath, method: 'GET', timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve({ ok: true, status: res.statusCode ?? null, error: null });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: null, error: 'timed out' }); });
    req.on('error', (err) => resolve({ ok: false, status: null, error: err.code || err.message }));
    req.end();
  });
}

/**
 * Whether an HTTP status counts as healthy.
 *
 * With an explicit health path the app has said "this URL means I am well", so
 * only 2xx/3xx will do. With the default `/`, plenty of healthy APIs answer 401
 * or 404 there; any response that is not a server error shows the process is
 * up and serving.
 */
export function isHealthyStatus(status, strict) {
  if (typeof status !== 'number') return false;
  return strict ? status >= 200 && status < 400 : status >= 100 && status < 500;
}

/**
 * Removes the app's secret values from text that is about to leave the engine.
 *
 * PM2's own logs are the app's output, and an app that prints its configuration
 * — or a crash dump that includes it — would otherwise put a database URL or a
 * token into a run record the dashboard and the Hub can read. Every non-empty
 * value of an environment variable on the app is replaced, longest first, so a
 * secret that contains another one is not half-redacted. The auth token is
 * included for the same reason even though it lives outside `env`.
 *
 * @param {string} text
 * @param {Object<string, *>} [env]
 * @param {string|null} [token]
 * @returns {string}
 */
export function redactSecrets(text, env = {}, token = null) {
  const values = [...Object.values(env ?? {}), token]
    .filter((v) => typeof v === 'string' && v.length > 0)
    .sort((a, b) => b.length - a.length);
  return sanitizeDeployText(text, values);
}

// ─── The engine ───────────────────────────────────────────────────────────────

function resolveDeps(deps = {}) {
  return {
    run: deps.run ?? defaultRun,
    runFile: deps.runFile ?? defaultRunFile,
    runCommandLine: deps.runCommandLine ?? defaultRunCommandLine,
    runner: deps.runner ?? defaultRunner,
    probe: deps.probe ?? probeHttp,
    sleep: deps.sleep ?? sleepFor,
    sendNotification: deps.sendNotification ?? defaultSendNotification,
    syncDomain: deps.syncDomain ?? syncLinkedDomain,
    deleteDomain: deps.deleteDomain ?? deleteLinkedDomain,
    recheck: typeof deps.recheck === 'function' ? deps.recheck : null,
    now: deps.now ?? (() => Date.now()),
  };
}

/**
 * The names a global npm install of PM2 leaves on PATH.
 *
 * Every spelling is asked for on every OS: an extra `fs.existsSync` on a file
 * that cannot exist costs nothing, and it keeps `process.platform` out of this
 * module (core/platform.js owns OS branching).
 */
const PM2_PATH_NAMES = Object.freeze(['pm2', 'pm2.cmd', 'pm2.exe', 'pm2.bat', 'pm2.ps1']);

/**
 * Whether a `pm2` executable is on PATH right now — decided WITHOUT spawning
 * anything.
 *
 * A deployment cannot be started without PM2 (the release is started and
 * watched through it), so a missing PM2 has to refuse before the first write
 * rather than fail at the `start` step with a lock held and a release folder
 * half built. The check has to be synchronous because `startDeployment` is:
 * callers use its answer before awaiting anything, and the lock is taken in the
 * same turn. `runner.detect()` spawns `where.exe`, which cannot be awaited
 * here, so this is the cheap equivalent: the same PATH lookup `where.exe
 * pm2` performs, in-process.
 *
 * It is deliberately conservative: only "nothing named pm2 anywhere on PATH"
 * refuses. Anything it cannot read (an unreadable PATH entry) counts as
 * "maybe", so an unusual installation is never blocked — it fails later, as it
 * did before, rather than refusing a working machine's deploy.
 *
 * @param {Object} [env]
 * @returns {boolean}
 */
function pm2OnPath(env = process.env) {
  const raw = env.PATH ?? env.Path ?? '';
  if (!String(raw).trim()) return false;

  const names = new Set(PM2_PATH_NAMES);
  for (const ext of String(env.PATHEXT ?? '').split(';')) {
    const clean = ext.trim().toLowerCase();
    if (!clean) continue;
    names.add(`pm2${clean.startsWith('.') ? clean : `.${clean}`}`);
  }

  for (const entry of String(raw).split(path.delimiter)) {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1');
    if (!dir) continue;
    for (const name of names) {
      try {
        if (fs.existsSync(path.join(dir, name))) return true;
      } catch {
        // A PATH entry we cannot read is not an answer about PM2.
      }
    }
  }

  return false;
}

/**
 * The PM2 precondition for starting a deployment, checked before the lock,
 * the run record, a release folder or any step.
 *
 * Two refusals, both shaped like every other engine refusal (`ok`, `status`,
 * `error`) plus the `reason`, `message` and `fix` a UI can show:
 *
 *   - `service_account`: this process is the Windows service, which must never
 *     spawn pm2 or npm (see core/runner.js pm2Access). The message and fix are
 *     runner's own, so the Hub shows the same words the dashboard would.
 *   - `not_installed`: there is nothing to start the release with. The fix is
 *     the one command to run, instead of discovering it at the start step.
 *
 * `deps.pm2Installed` is the test seam: a synchronous predicate. Without it the
 * real PATH lookup is used, and only for the real runner — a test double is not
 * the real PM2 model and must not be judged by the machine's PATH.
 *
 * @param {Object} d Resolved dependencies (see resolveDeps)
 * @param {Object} deps The caller's raw deps
 * @returns {{ ok: true } | {
 *   ok: false, status: number, reason: string, message: string, fix: string, error: string,
 * }}
 */
function pm2Preflight(d, deps) {
  const access = typeof d.runner.pm2Access === 'function' ? d.runner.pm2Access() : { ok: true };
  if (access && access.ok === false) {
    const message = access.message ?? 'PM2 is not available to this process.';
    const fix = access.fix ?? 'Manage these apps as the user who runs PM2.';
    return {
      ok: false,
      status: 403,
      reason: access.reason ?? 'service_account',
      message,
      fix,
      error: `${message} ${fix}`,
    };
  }

  let installed = true;
  if (typeof deps.pm2Installed === 'function') {
    try {
      installed = Boolean(deps.pm2Installed());
    } catch {
      installed = true;
    }
  } else if (d.runner === defaultRunner) {
    installed = pm2OnPath();
  }

  if (!installed) {
    return {
      ok: false,
      status: 409,
      reason: 'not_installed',
      message: 'PM2 is not installed.',
      fix: 'npm i -g pm2',
      error: 'PM2 is not installed, so nothing could start the release. Install it first: npm i -g pm2',
    };
  }

  return { ok: true };
}

/**
 * Appends timestamped lines to a run's log.
 *
 * The redactor is part of the writer, not a later reader. A secret is therefore
 * absent from the persisted file even if it is removed from Settings before
 * anyone opens the run. Neither this function nor its public accessors reveal
 * the snapshot.
 *
 * Never throws: a full disk must not mask the real deployment error.
 */
export function makeLogger(appId, runId, secrets) {
  const file = logFile(appId, runId);
  const redactor = createDeployLogRedactor(secrets);
  let partial = '';
  let atLineStart = true;
  let droppedPartial = 0;

  const write = (text) => {
    try { fs.appendFileSync(file, text); } catch { /* ignore */ }
  };
  const stamp = () => new Date().toISOString().slice(11, 19);
  const writeSanitized = (text) => write(redactor.write(text));

  const writeOutputLine = (line, { newline = true } = {}) => {
    let prefix = '';
    if (atLineStart) {
      prefix = '          ';
      atLineStart = false;
    }
    write(`${prefix}${line}${newline ? '\n' : ''}`);
    if (newline) atLineStart = true;
  };

  const drainOutput = (force = false) => {
    while (partial.length > 0) {
      const newline = partial.indexOf('\n');
      if (newline !== -1) {
        const line = partial.slice(0, newline).replace(/\r$/, '');
        partial = partial.slice(newline + 1);
        writeOutputLine(line);
        continue;
      }

      if (partial.length < MAX_LOG_FRAGMENT_CHARS && !force) return;

      /*
       * A newline-free producer must not grow this buffer without bound. The
       * redactor has already removed complete secrets, so writing a fragment is
       * safe. Keep the final character until flush because a carriage return
       * pair can be split across chunks.
       */
      let cut = Math.min(MAX_LOG_FRAGMENT_CHARS, partial.length);
      if (cut < partial.length) cut -= 1;
      if (force) cut = partial.length;
      const fragment = partial.slice(0, cut);
      partial = partial.slice(cut);
      writeOutputLine(fragment, { newline: false });
      if (force) break;
    }
  };

  return {
    file,
    /** A line written by the engine itself. */
    line(text = '') {
      writeSanitized(`${stamp()}  ${text}\n`);
    },
    /** A heading for a step. */
    step(title) {
      writeSanitized(`\n${stamp()}  ── ${title}\n`);
    },
    /** Raw output from a command, redacted before it reaches disk. */
    output(chunk) {
      const safe = redactor.write(String(chunk ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
      partial += safe;
      drainOutput(false);
    },
    flush() {
      partial += redactor.flush();
      if (droppedPartial > 0 && partial.length === 0) {
        partial = `[incomplete log line truncated: ${droppedPartial} characters]\n`;
        droppedPartial = 0;
      }
      drainOutput(true);
      if (!atLineStart) {
        write('\n');
        atLineStart = true;
      }
    },
  };
}

/**
 * Authentication is scoped to one fetch. It must never reach argv, checkout
 * hooks, build scripts or the persisted repository configuration.
 */
function gitAuth(app) {
  const env = { GIT_TERMINAL_PROMPT: '0' };

  if (app.auth?.type === AUTH_TYPES.TOKEN && app.auth.token) {
    const basic = Buffer.from(`x-access-token:${app.auth.token}`).toString('base64');
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
    // Git tracing can print headers to stderr, which becomes deploy output.
    env.GIT_TRACE_CURL = '0';
    env.GIT_CURL_VERBOSE = '0';
    env.GIT_TRACE_REDACT = '1';
  }

  if (app.auth?.type === AUTH_TYPES.DEPLOY_KEY) {
    // github.com is checked against GitHub's pinned host keys; see deployKey.js.
    let sshCmd;
    try {
      sshCmd = sshCommand(app.id, app.repoUrl);
    } catch (err) {
      throw new StepError('fetch', err.message);
    }
    if (!sshCmd) {
      throw new StepError('fetch', 'This app uses a deploy key, but none has been generated yet. Generate it in the app settings, add it to the repository, then deploy again.');
    }
    env.GIT_SSH_COMMAND = sshCmd;
  }

  return env;
}

function readTextIfExists(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/** Reads ez.json, package.json and the lockfiles out of a checkout and resolves the settings. */
export function loadProjectSettings(dir, overrides = {}) {
  const warnings = [];
  let ez = null;
  let ezLocation = null;

  for (const rel of EZ_FILE_LOCATIONS) {
    const text = readTextIfExists(path.join(dir, rel));
    if (text === null) continue;
    const parsed = parseEzFile(text);
    warnings.push(...parsed.warnings);
    if (!parsed.ok) return { ok: false, error: parsed.errors.join(' '), warnings, ezLocation: rel };
    ez = parsed.value;
    ezLocation = rel;
    break;
  }

  let pkg = null;
  const pkgText = readTextIfExists(path.join(dir, 'package.json'));
  if (pkgText !== null) {
    try { pkg = JSON.parse(pkgText); } catch { warnings.push('package.json is not valid JSON and was ignored'); }
  }

  const files = {
    packageLock: fs.existsSync(path.join(dir, 'package-lock.json')),
    yarnLock: fs.existsSync(path.join(dir, 'yarn.lock')),
    pnpmLock: fs.existsSync(path.join(dir, 'pnpm-lock.yaml')),
  };

  const resolved = resolveSettings({ ez, pkg, files, overrides });
  return {
    ...resolved,
    // ez.json warnings plus the runtime warnings (cluster mode's stateless note).
    warnings: [...warnings, ...(resolved.warnings ?? [])],
    ezLocation,
  };
}

// ─── Persistent paths ────────────────────────────────────────────────────────

/** The link path for one project-relative persistent path. */
function persistLink(dir, rel) {
  return path.join(dir, ...rel.split('/'));
}

/** What is at a path: 'dir', 'file', 'link', 'other', or null when nothing is. */
function entryKind(target) {
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) return 'link';
    if (st.isDirectory()) return 'dir';
    if (st.isFile()) return 'file';
    return 'other';
  } catch {
    return null;
  }
}

/** True when a name looks like a file rather than a folder: its last segment has a dot. */
function looksLikeFile(rel) {
  return (rel.split('/').pop() ?? '').includes('.');
}

/**
 * Refuses a link placed under a symbolic link that came from the repository.
 * Following one would put the app's writes outside the release — and outside
 * anything the deployment can clean up.
 */
function assertRealParents(dir, rel) {
  let at = dir;
  for (const part of rel.split('/').slice(0, -1)) {
    at = path.join(at, part);
    let st;
    try { st = fs.lstatSync(at); } catch { return; } // nothing below it exists yet
    if (st.isSymbolicLink()) {
      throw new StepError('settings', `"${rel}" is under a symbolic link in the repository, which persistent paths do not allow.`);
    }
    if (!st.isDirectory()) {
      throw new StepError('settings', `"${rel}" is inside "${path.relative(dir, at)}", which is a file in the repository.`);
    }
  }
}

/**
 * Creates a directory link, relative where possible.
 *
 * A relative link survives the app's folder being moved. On Windows a
 * non-elevated account cannot create symlinks; a junction needs no privilege
 * but stores an absolute path, which is why moveApp() recreates these links.
 */
function createDirLink(targetDir, linkAt) {
  fs.mkdirSync(path.dirname(linkAt), { recursive: true });
  const relative = path.relative(path.dirname(linkAt), targetDir) || '.';
  try {
    fs.symlinkSync(relative, linkAt, 'dir');
  } catch (err) {
    if (process.platform === 'win32' && (err.code === 'EPERM' || err.code === 'EACCES')) {
      fs.symlinkSync(targetDir, linkAt, 'junction');
      return;
    }
    throw err;
  }
}

/**
 * Creates a link to one file. Windows without symlink permission gets a hard
 * link instead: it needs no privilege, points at the same bytes, and the
 * inode comparison in verifyPersistentLinks() still notices when a build has
 * replaced it with a copy.
 */
function createFileLink(targetFile, linkAt) {
  fs.mkdirSync(path.dirname(linkAt), { recursive: true });
  const relative = path.relative(path.dirname(linkAt), targetFile) || '.';
  try {
    fs.symlinkSync(relative, linkAt, 'file');
  } catch (err) {
    if (process.platform === 'win32' && (err.code === 'EPERM' || err.code === 'EACCES')) {
      fs.linkSync(targetFile, linkAt);
      return;
    }
    throw err;
  }
}

/** The same inode on the same device — a hard link, not a copy. */
function sameHardLink(a, b) {
  try {
    const x = fs.statSync(a);
    const y = fs.statSync(b);
    return x.ino !== 0 && x.ino === y.ino && x.dev === y.dev;
  } catch {
    return false;
  }
}

/** Whether a link resolves to the shared copy. Windows paths compare case-insensitively. */
function linkPointsAt(linkAt, sharedAt) {
  try {
    const a = fs.realpathSync(linkAt);
    const b = fs.realpathSync(sharedAt);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

function removeAt(target) {
  let st = null;
  try { st = fs.lstatSync(target); } catch { return; }
  if (st) fs.rmSync(target, { recursive: true, force: true });
}

/** Copies the contents of a folder, leaving symlinks out: their targets are not part of this project. */
function copyInto(from, to, log, rel, { overwrite = false } = {}) {
  for (const entry of fs.readdirSync(from)) {
    const src = path.join(from, entry);
    const st = fs.lstatSync(src);
    if (st.isSymbolicLink()) {
      log.line(`  warning: skipped the symbolic link ${rel}/${entry} while seeding persistent data`);
      continue;
    }
    fs.cpSync(src, path.join(to, entry), {
      recursive: true, preserveTimestamps: true, force: overwrite, errorOnExist: !overwrite,
    });
  }
}

/**
 * Gives every persistent path one home outside the releases and links it in.
 *
 * A deployment starts from a fresh checkout, and old releases are deleted —
 * that is what makes a rollback clean, and why runtime data disappears with
 * it. A persistent path lives once, under `<app folder>/shared/`, and every
 * release gets a link to it, so a deploy, a rollback and a prune all see the
 * same data: a folder with its contents, or a single file.
 *
 * The first deployment seeds the shared copy from the repository, so a
 * committed empty uploads/ or a SQLite file is not lost. When the app was
 * already running, the live release is seeded after the repository and wins:
 * its copy is the one holding the data written until now. After that the
 * shared copy wins — editing the path in the repository changes nothing,
 * which is what "persistent" has to mean.
 *
 * A file is supported for the case where the folder is not the unit — one
 * database file beside code that is replaced on every deploy. A folder stays
 * the better choice when the app writes neighbours: SQLite creates `-wal` and
 * `-shm` files next to its database, and those would remain in the release.
 *
 * @param {string|null} [inheritDir] The release that is live now, if any
 */
function linkPersistentPaths(appId, dir, paths, log, inheritDir = null) {
  if (!paths || paths.length === 0) return;
  const shared = appPaths(appId).shared;
  fs.mkdirSync(shared, { recursive: true });

  for (const rel of paths) {
    const linkAt = persistLink(dir, rel);
    const sharedAt = path.join(shared, ...rel.split('/'));
    if (!isInside(linkAt, dir) || !isInside(sharedAt, shared)) {
      throw new StepError('settings', `"${rel}" is not inside the project.`);
    }
    assertRealParents(dir, rel);

    const inShared = entryKind(sharedAt);
    if (inShared === 'link' || inShared === 'other') {
      throw new StepError('settings', `"${rel}" is not a folder or a file in the app's shared data (${shared}).`);
    }

    let kind = inShared;
    let seededFrom = null;

    if (!inShared) {
      const inRelease = entryKind(linkAt);
      if (inRelease === 'link' || inRelease === 'other') {
        throw new StepError('settings', `"${rel}" is a symbolic link in the repository, which persistent paths do not allow.`);
      }

      let inPrevious = null;
      let previousAt = null;
      if (inheritDir && path.resolve(inheritDir) !== path.resolve(dir)) {
        previousAt = persistLink(inheritDir, rel);
        inPrevious = entryKind(previousAt);
        // A previous release that already had this path persistent points at
        // the shared copy itself; there is nothing of its own to take.
        if (inPrevious === 'link' || inPrevious === 'other') inPrevious = null;
      }

      const usable = (k) => k === 'dir' || k === 'file';
      kind = usable(inPrevious) ? inPrevious : usable(inRelease) ? inRelease : (looksLikeFile(rel) ? 'file' : 'dir');

      if (usable(inRelease) && inRelease !== kind) {
        log.line(`  warning: "${rel}" is a ${inRelease} in the repository, but the live copy is a ${kind}; the live copy is kept.`);
      }

      const sources = [];
      if (kind === 'dir') {
        fs.mkdirSync(sharedAt, { recursive: true });
        if (inRelease === 'dir') {
          copyInto(linkAt, sharedAt, log, rel);
          sources.push('the repository');
        }
        if (inPrevious === 'dir') {
          copyInto(previousAt, sharedAt, log, rel, { overwrite: true });
          sources.push('the live release');
        }
      } else {
        fs.mkdirSync(path.dirname(sharedAt), { recursive: true });
        const from = inPrevious === 'file' ? previousAt : inRelease === 'file' ? linkAt : null;
        if (from) {
          // Onto a persistent path a previous release may still hold open —
          // a scanner or the live app on Windows — so the copy rides out a
          // momentary sharing denial instead of failing the whole deployment.
          copyFileWithRetry(from, sharedAt);
          sources.push(from === linkAt ? 'the repository' : 'the live release');
        } else {
          // Nothing anywhere: start empty, so the app can open and fill it.
          fs.writeFileSync(sharedAt, '');
        }
      }
      if (sources.length > 0) seededFrom = sources.join(' and ');
    }

    // Whatever was at this path is replaced by the link: the shared copy is
    // the one that persists.
    removeAt(linkAt);
    if (kind === 'file') createFileLink(sharedAt, linkAt);
    else createDirLink(sharedAt, linkAt);
    log.line(`  persist    ${rel}${kind === 'file' ? ' (file)' : ''}${seededFrom ? ` (seeded from ${seededFrom})` : ''}`);
  }
}

/**
 * Checks the links again after the build. A build that deletes or recreates a
 * persistent path would put data back inside the release — where the next
 * deployment loses it — so that is a failure, not something to fix silently.
 */
function verifyPersistentLinks(appId, dir, paths) {
  if (!paths || paths.length === 0) return;
  const shared = appPaths(appId).shared;

  for (const rel of paths) {
    const linkAt = persistLink(dir, rel);
    const sharedAt = path.join(shared, ...rel.split('/'));
    const at = entryKind(linkAt);

    if (entryKind(sharedAt) === null) {
      if (looksLikeFile(rel)) fs.writeFileSync(sharedAt, '');
      else fs.mkdirSync(sharedAt, { recursive: true });
    }
    const isFile = entryKind(sharedAt) === 'file';

    const linked = (at === 'link' && linkPointsAt(linkAt, sharedAt))
      || (at === 'file' && isFile && sameHardLink(linkAt, sharedAt));
    if (linked) continue;

    if (at === null) {
      if (isFile) createFileLink(sharedAt, linkAt);
      else createDirLink(sharedAt, linkAt);
      continue;
    }
    throw new StepError('build', `The build replaced the persistent path "${rel}" with a real file or folder, so anything written there would be lost on the next deployment. Do not delete or recreate "${rel}" in the build.`);
  }
}

/** Every persistent link in every release of an app. */
function persistentLinks(appId) {
  const out = [];
  for (const id of listReleases(appId)) {
    const dir = releaseDir(appId, id);
    for (const rel of releaseHealth(appId, id, dir).persist) out.push({ dir, rel });
  }
  return out;
}

/**
 * Removes the links before the app's folder is moved, and recreates them after
 * — against the new shared folder. A relative link would survive on its own;
 * a Windows junction holds an absolute path and would point at a folder that
 * no longer exists. Detaching first also keeps a cross-device copy from
 * reading through the links.
 *
 * A hard link is removed only while it still shares its inode with the shared
 * file: a copy left by a build belongs to the release and stays with it.
 */
function detachPersistentLinks(appId) {
  const shared = appPaths(appId).shared;
  for (const { dir, rel } of persistentLinks(appId)) {
    const linkAt = persistLink(dir, rel);
    const sharedAt = path.join(shared, ...rel.split('/'));
    const kind = entryKind(linkAt);
    try {
      if (kind === 'link') fs.rmSync(linkAt, { force: true });
      else if (kind === 'file' && sameHardLink(linkAt, sharedAt)) fs.rmSync(linkAt, { force: true });
    } catch { /* gone already */ }
  }
}

/** @returns {string[]} One message per path that could not be linked again */
function attachPersistentLinks(appId) {
  const shared = appPaths(appId).shared;
  const failures = [];
  for (const { dir, rel } of persistentLinks(appId)) {
    const linkAt = persistLink(dir, rel);
    const sharedAt = path.join(shared, ...rel.split('/'));
    try {
      const kind = entryKind(linkAt);
      if (kind === 'link') {
        if (linkPointsAt(linkAt, sharedAt)) continue;
        fs.rmSync(linkAt, { force: true }); // a link left pointing at the old folder
      } else if (kind !== null) {
        continue; // real content in the release: not the deployment's to replace
      }

      if (entryKind(sharedAt) === 'file') {
        createFileLink(sharedAt, linkAt);
      } else {
        fs.mkdirSync(sharedAt, { recursive: true });
        createDirLink(sharedAt, linkAt);
      }
    } catch (err) {
      failures.push(`${rel}: ${err.message}`);
    }
  }
  return failures;
}

/** The environment a deployed app (and its build) runs with. */
function appEnvironment(app, settings, releaseId) {
  const env = { ...(app.env ?? {}) };
  // Most frameworks read PORT. Setting it from the declared port means the
  // port in ez.json is the port the app actually listens on.
  if (settings.port && env.PORT === undefined) env.PORT = String(settings.port);
  env.EZ_APP = app.id;
  env.EZ_RELEASE = releaseId;
  // One stable place for data, for an app that would rather build a path than
  // rely on the links: `${EZ_SHARED_DIR}/uploads`.
  if (settings.persist?.length) env.EZ_SHARED_DIR = appPaths(app.id).shared;
  return env;
}

function regularReleaseFile(file) {
  const parent = fs.lstatSync(path.dirname(file), { throwIfNoEntry: false });
  if (!parent?.isDirectory()) return false;
  const entry = fs.lstatSync(file, { throwIfNoEntry: false });
  return Boolean(entry?.isFile() && entry.nlink === 1);
}

function engineArtifactFile(appId, releaseId, fileName) {
  if (typeof fileName !== 'string' || path.basename(fileName) !== fileName) {
    throw new Error(`Invalid engine artifact name: ${JSON.stringify(fileName)}`);
  }
  return path.join(engineReleaseDir(appId, releaseId), fileName);
}

/** Publish an engine-owned artifact through exclusive create and atomic rename. */
function writeEngineFile(appId, releaseId, fileName, contents) {
  ensureEngineReleaseDir(appId, releaseId);
  writeFileEventual(engineArtifactFile(appId, releaseId, fileName), contents, { mode: 0o600 });
}

/**
 * Read a pre-1.4.5 artifact without following a final link, then publish the
 * validated copy into the engine-owned directory. Legacy checkouts are only a
 * migration source. No generated write ever targets them.
 */
function migrateLegacyArtifact(appId, releaseId, fileName, releaseDirectory) {
  const legacy = path.join(releaseDirectory, fileName);
  if (!regularReleaseFile(legacy)) return null;

  let opened;
  try {
    opened = openVerifiedChild(legacy, { expectedDirectory: releaseDirectory });
    const contents = fs.readFileSync(opened.fd, 'utf8');
    writeEngineFile(appId, releaseId, fileName, contents);
    return contents;
  } catch {
    return null;
  } finally {
    opened?.close();
  }
}

function readLegacyArtifact(appId, releaseId, fileName, releaseDirectory) {
  const current = engineArtifactFile(appId, releaseId, fileName);
  if (regularReleaseFile(current)) {
    try {
      return fs.readFileSync(current, 'utf8');
    } catch {
      return null;
    }
  }
  return migrateLegacyArtifact(appId, releaseId, fileName, releaseDirectory);
}

function configFileForRelease(appId, releaseId, directory) {
  const contents = readLegacyArtifact(appId, releaseId, PM2_CONFIG_FILE, directory);
  if (contents === null) return null;
  try {
    const parsed = JSON.parse(contents);
    return Array.isArray(parsed?.apps) ? engineArtifactFile(appId, releaseId, PM2_CONFIG_FILE) : null;
  } catch {
    return null;
  }
}

/** Writes the PM2 config and launcher into the engine-owned artifact directory. */
function writePm2Config(dir, app, releaseId, settings, env) {
  const start = parseStartCommand(settings.start);
  const entry = {
    name: pm2Name(app.id),
    cwd: dir,
    autorestart: true,
    max_restarts: 10,
    min_uptime: 5000,
    time: true,
    env: { ...env },
  };

  if (start.kind === 'node') {
    entry.script = start.script;
    if (start.args.length > 0) entry.args = start.args;
  } else {
    const launcher = engineArtifactFile(app.id, releaseId, LAUNCHER_FILE);
    writeEngineFile(app.id, releaseId, LAUNCHER_FILE, LAUNCHER_SOURCE);
    entry.script = launcher;
    entry.env[LAUNCHER_COMMAND_ENV] = start.command;
  }

  // Fork (the default) is left exactly as it was: PM2's own default. Cluster
  // needs both fields, and a rollback reads them back from the release meta.
  if (settings.execMode === 'cluster') {
    entry.exec_mode = 'cluster';
    entry.instances = settings.instances === 'max' ? 'max' : (settings.instances ?? 1);
  }

  const file = engineArtifactFile(app.id, releaseId, PM2_CONFIG_FILE);
  // Holds the app's environment, so owner-only like the deploy key.
  writeEngineFile(app.id, releaseId, PM2_CONFIG_FILE, JSON.stringify({ apps: [entry] }, null, 2));
  return file;
}

/** Reads back the health settings a release was started with, for a rollback. */
function releaseHealth(appId, releaseId, dir = releaseDir(appId, releaseId)) {
  try {
    const stored = readEngineJson(appId, releaseId, 'ez.release.json');
    const migrated = stored === null
      ? migrateLegacyArtifact(appId, releaseId, 'ez.release.json', dir)
      : null;
    if (stored === null && migrated === null) throw new Error('Missing or linked release metadata');
    const meta = stored ?? JSON.parse(migrated);
    return {
      port: Number.isInteger(meta.port) ? meta.port : null,
      healthPath: typeof meta.healthPath === 'string' ? meta.healthPath : '/',
      strict: Boolean(meta.strict),
      sha: typeof meta.sha === 'string' ? meta.sha : null,
      ref: typeof meta.ref === 'string' ? meta.ref : null,
      persist: Array.isArray(meta.persist) ? meta.persist.filter((p) => typeof p === 'string') : [],
      execMode: meta.execMode === 'cluster' ? 'cluster' : 'fork',
      instances: meta.instances === 'max' || Number.isInteger(meta.instances) ? meta.instances : 1,
    };
  } catch {
    return {
      port: null, healthPath: '/', strict: false, sha: null, ref: null, persist: [],
      execMode: 'fork', instances: 1,
    };
  }
}

/** What a release was built from, for the UI's release list. */
export function describeRelease(appId, releaseId) {
  let dir;
  try { dir = releaseDir(appId, releaseId); } catch { return null; }
  const meta = releaseHealth(appId, releaseId, dir);
  return {
    id: releaseId,
    sha: meta.sha,
    ref: meta.ref,
    execMode: meta.execMode,
    instances: meta.instances,
    startable: configFileForRelease(appId, releaseId, dir) !== null,
  };
}

/**
 * Reads one app's PM2 status through core/runner.js, as a list of instances.
 *
 * A cluster app has one PM2 entry per worker, so statusAll is preferred. The
 * older `status` and `list` fallbacks keep injected runners working; they
 * report one entry, which is all a fork app has anyway.
 *
 * @returns {Promise<{ read: boolean, apps: Object[] }>}
 */
async function readPm2Status(name, pm2Path, d) {
  if (typeof d.runner.statusAll === 'function') {
    const r = await d.runner.statusAll(name, { run: d.run, pm2Path });
    if (!r?.ok) return { read: false, apps: [] };
    return { read: true, apps: Array.isArray(r.apps) ? r.apps : [] };
  }
  if (typeof d.runner.status === 'function') {
    const r = await d.runner.status(name, { run: d.run, pm2Path });
    if (!r?.ok) return { read: false, apps: [] };
    return { read: true, apps: r.app ? [r.app] : [] };
  }
  const listed = await d.runner.list({ run: d.run, pm2Path });
  if (!listed.ok) return { read: false, apps: [] };
  return { read: true, apps: listed.apps.filter((a) => a.name === name) };
}

/**
 * Turns one PM2 observation into a boot-crash reason, or null when it is fine.
 *
 * `baseline` maps each instance to the restart count on the first observation
 * after the start. Anything above its baseline means that worker exited at
 * least once; PM2's state `errored`/`stopped` means it has given up. Both are
 * boot crashes even when an HTTP probe happened to answer once, which is the
 * case the health check alone cannot see. A cluster app is only healthy when
 * EVERY worker is.
 *
 * @param {{ read: boolean, apps: Object[] }} observed
 * @param {Map<number|string, number>|null} baseline
 * @param {{ port?: number|null }} ctx
 * @returns {string|null}
 */
function bootCrashReason(observed, baseline, { port = null } = {}) {
  if (!observed.read) return null;
  const apps = Array.isArray(observed.apps) ? observed.apps : [];
  if (apps.length === 0) return 'crashed at boot: PM2 no longer lists the process';

  for (let i = 0; i < apps.length; i++) {
    const app = apps[i];
    const key = app.pmId ?? i;
    const restarts = Number.isFinite(app.restarts) ? app.restarts : 0;

    if (baseline && baseline.has(key) && restarts > baseline.get(key)) {
      return `crashed at boot: restarting ${restarts} times`;
    }
    if (app.status === 'errored' || app.status === 'stopped') {
      const where = port ? ` instead of listening on port ${port}` : '';
      return `crashed at boot: process is "${app.status}" — it exited${where}`;
    }
  }

  return null;
}

/**
 * Waits for a freshly started app to be healthy.
 *
 * Healthy means both: the HTTP check (or the no-port settle) passes, AND PM2
 * keeps it online without increasing its restart count over a short
 * confirmation window. The second half is what catches a release that answers
 * a probe and then crashes at boot.
 *
 * @returns {Promise<{ ok: boolean, detail: string, crash: boolean, reason: string|null }>}
 */
async function waitHealthy({ name, port, healthPath, strict, timeoutS, pm2Path, d }) {
  let baseline = null;
  let last = 'no response yet';

  /** @returns {string|null} A boot-crash reason, or null */
  const observe = (observed) => {
    const reason = bootCrashReason(observed, baseline, { port });
    if (observed.read && observed.apps.length > 0 && baseline === null) {
      baseline = new Map();
      observed.apps.forEach((app, i) => {
        baseline.set(app.pmId ?? i, Number.isFinite(app.restarts) ? app.restarts : 0);
      });
    }
    return reason;
  };

  const failOrNull = (reason) => (reason
    ? { ok: false, crash: true, detail: reason, reason }
    : null);

  if (!port) {
    // Nothing to ask over HTTP: the app has to stay online, without PM2
    // restarting it, for a few seconds.
    await d.sleep(Math.min(2000, NO_PORT_SETTLE_MS));
    const early = await readPm2Status(name, pm2Path, d);
    const earlyCrash = failOrNull(observe(early));
    if (earlyCrash) return earlyCrash;

    await d.sleep(NO_PORT_SETTLE_MS - 2000);
    const late = await readPm2Status(name, pm2Path, d);
    const lateCrash = failOrNull(observe(late));
    if (lateCrash) return lateCrash;

    if (late.apps.length === 0) return { ok: false, crash: true, detail: 'crashed at boot: PM2 no longer lists the process', reason: 'crashed at boot: PM2 no longer lists the process' };
    const notOnline = late.apps.find((a) => a.status !== 'online');
    if (notOnline) {
      const reason = `crashed at boot: process is "${notOnline.status}", not online`;
      return { ok: false, crash: true, detail: reason, reason };
    }
    return {
      ok: true,
      crash: false,
      reason: null,
      detail: 'The process stayed online (no port is configured, so no HTTP check was made).',
    };
  }

  const deadline = d.now() + timeoutS * 1000;
  let answeredOnce = false;

  for (;;) {
    const res = await d.probe(port, healthPath);
    if (res.ok && isHealthyStatus(res.status, strict)) {
      if (answeredOnce) {
        const observed = await readPm2Status(name, pm2Path, d);
        const crash = failOrNull(observe(observed));
        if (crash) return crash;
        // A PM2 status that could not be read is not evidence of a crash; the
        // HTTP answer is what we have.
        if (!observed.read || (observed.apps.length > 0 && observed.apps.every((a) => a.status === 'online'))) {
          return { ok: true, crash: false, reason: null, detail: `GET ${healthPath} on port ${port} answered ${res.status}, and PM2 stayed online.` };
        }
      } else {
        const first = await readPm2Status(name, pm2Path, d);
        const crash = failOrNull(observe(first));
        if (crash) return crash;
        answeredOnce = true;
        // Keep watching for one short window: an app that answers and then
        // crash-loops must not be accepted on the strength of that first answer.
        const remaining = Math.max(0, deadline - d.now());
        await d.sleep(Math.min(BOOT_CONFIRM_MS, remaining));
        continue;
      }
    }
    last = res.ok ? `it answered ${res.status}` : `no answer (${res.error})`;

    const observed = await readPm2Status(name, pm2Path, d);
    const crash = failOrNull(observe(observed));
    if (crash) return crash;

    if (d.now() >= deadline) {
      // A process that never reached "online" is a boot crash, not merely a
      // slow health endpoint.
      const notOnline = observed.read ? observed.apps.find((a) => a.status !== 'online') : null;
      if (notOnline) {
        const reason = `crashed at boot: process is "${notOnline.status}", not online`;
        return { ok: false, crash: true, detail: reason, reason };
      }
      const detail = `No healthy response from GET ${healthPath} on port ${port} within ${timeoutS}s (${last}).`;
      return { ok: false, crash: false, detail, reason: `health check failed: ${detail}` };
    }
    await d.sleep(HEALTH_POLL_MS);
  }
}

/**
 * Reads the tail of a crashed release's PM2 out+error log, with the deployment's
 * immutable secret snapshot removed. Sanitizing the complete text matters:
 * splitting first would let a PEM block body survive as individual lines.
 *
 * @returns {Promise<string[]>} At most BOOT_LOG_LINES lines
 */
async function captureBootLog(name, secretSnapshot, pm2Path, d) {
  if (typeof d.runner.logs !== 'function') return [];
  try {
    const read = await d.runner.logs(name, { lines: BOOT_LOG_LINES, run: d.run, pm2Path });
    const text = Array.isArray(read?.lines) ? read.lines.join('\n') : String(read?.output ?? '');
    return sanitizeDeployText(text, secretSnapshot)
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .slice(-BOOT_LOG_LINES);
  } catch {
    return [];
  }
}

/**
 * Starts a release under PM2, or reloads it when both the new release and the
 * running app are in cluster mode.
 *
 * `delete` rather than `restart` is the ordinary path: the working directory
 * and the environment belong to the release, and PM2 keeps the old ones across
 * a restart. Deleting a name PM2 does not know fails harmlessly on a first
 * deployment. Cluster-to-cluster is the exception — PM2 reload overlaps the
 * workers, which is the zero-downtime handover; a first deployment or a
 * fork↔cluster switch cannot overlap and takes the delete/start path.
 *
 * @param {{ execMode?: 'fork'|'cluster' }} [options]
 */
async function switchTo(appId, releaseId, dir, name, pm2Path, d, log, { execMode = 'fork' } = {}) {
  const config = configFileForRelease(appId, releaseId, dir);
  if (!config || !regularReleaseFile(config)) {
    return { ok: false, output: `${PM2_CONFIG_FILE} is missing for release ${releaseId}.` };
  }

  if (execMode === 'cluster' && typeof d.runner.reloadConfig === 'function') {
    const current = await readPm2Status(name, pm2Path, d);
    const running = current.read && current.apps.length > 0;
    const allCluster = running && current.apps.every((a) => a.execMode === 'cluster');
    if (allCluster) {
      log.line(`$ pm2 reload ${PM2_CONFIG_FILE} (cluster mode, zero downtime)`);
      const reloaded = await d.runner.reloadConfig(config, { run: d.run, pm2Path });
      if (!reloaded.ok) log.line(reloaded.output || 'pm2 reload failed with no output');
      return reloaded;
    }
  }

  await d.runner.del(name, { run: d.run, pm2Path });
  const started = await d.runner.startConfig(config, { run: d.run, pm2Path });
  if (!started.ok) log.line(started.output || 'pm2 start failed with no output');
  return started;
}

async function notify(app, run, d) {
  // A boot crash is a failed run, but when the previous release is serving
  // again the notification should say so rather than only "failed".
  const outcome = run.rollbackSucceeded === true && run.status === RUN_STATUS.FAILED
    ? RUN_STATUS.ROLLED_BACK
    : run.status;
  const event = createDeployEvent(app.id, outcome, {
    sha: run.sha,
    reason: run.error,
    rollback: run.trigger === 'rollback',
  });
  // The in-app bell, when this process is the one feeding an open dashboard.
  publish('notification:new', event);
  try {
    await d.sendNotification(event, app.notifyChannelIds ?? []);
  } catch (err) {
    console.error('[deploy] notification failed:', err.message);
  }
}

/**
 * Starts a deployment and returns as soon as it is under way.
 *
 * The work continues in the background; `done` resolves with the finished run
 * record (it never rejects), for callers that want to wait — tests, and the
 * CLI.
 *
 * @param {string} appId
 * @param {Object} [opts]
 * @param {'manual'|'webhook'|'hub'} [opts.trigger]
 * @param {string|null} [opts.ref] Commit, tag or branch to deploy instead of the app's branch
 * @param {string|null} [opts.actor] Who asked, for the record
 * @param {Object} [opts.deps] Injected collaborators (testing only)
 * @param {Function} [opts.deps.pm2Installed] Synchronous PM2 presence predicate (testing only)
 * @returns {{ ok: true, runId: string, done: Promise<Object> }
 *          | { ok: false, status: number, error: string, runId?: string|null }}
 */
export function startDeployment(appId, { trigger = 'manual', ref = null, actor = null, deps = {} } = {}) {
  const app = getApp(appId);
  if (!app) return { ok: false, status: 404, error: `No app named "${appId}".` };
  const userCommandEnv = commandEnvironment(app.env ?? {});
  const secretSnapshot = [...new Set([
    ...snapshotDeploySecrets(app),
    ...commandEnvironmentSecrets(userCommandEnv),
  ])].sort((a, b) => b.length - a.length || a.localeCompare(b));

  if (ref !== null && ref !== undefined && ref !== '') {
    const refError = validateRef(String(ref));
    if (refError) return { ok: false, status: 400, error: refError };
  }

  const d = resolveDeps(deps);

  // Nothing has been written yet, and nothing will be when this refuses: no
  // lock, no run record, no release folder, no step. A deployment started by a
  // process that cannot use PM2 (the Windows service) or on a machine without
  // PM2 used to take the lock and fail at the start step, which left a failed
  // run and a half-built folder behind for a reason the Hub could not explain.
  const preflight = pm2Preflight(d, deps);
  if (!preflight.ok) return preflight;

  const runId = newReleaseId(new Date(d.now()));
  const lock = acquireLock(appId, { runId });
  if (!lock.ok) return { ok: false, status: 409, error: lock.reason, runId: lock.runId };

  const run = {
    id: runId,
    appId,
    trigger,
    actor,
    ref: ref ? String(ref) : app.branch,
    sha: null,
    releaseId: runId,
    status: RUN_STATUS.RUNNING,
    step: 'fetch',
    /** The canonical stage `step` maps to (see stages.js), for the stage bar. */
    stage: 'fetch',
    /** Stages this run will not perform; filled in once the settings are read. */
    skippedStages: [],
    startedAt: d.now(),
    finishedAt: null,
    error: null,
    warnings: [],
    rolledBackTo: null,
    /** A short human reason for a boot crash or health failure, else null. */
    reason: null,
    /** Redacted PM2 out+error tail for a boot crash; empty otherwise. */
    logTail: [],
    /** true/false once an automatic rollback was attempted, null when none was. */
    rollbackSucceeded: null,
    /** The writer that produced this run's file uses this exact policy. */
    logSecurity: LOG_SECURITY_REDACTED_V1,
  };
  writeRun(run);

  const done = executeDeployment(app, run, d, secretSnapshot)
    .catch((err) => {
      // executeDeployment handles its own failures; this is the net under it.
      run.status = RUN_STATUS.FAILED;
      run.error = sanitizeDeployText(err?.message ?? String(err), secretSnapshot);
      run.finishedAt = d.now();
      try { writeRun(run); } catch { /* ignore */ }
      return run;
    })
    .finally(() => lock.release());

  return { ok: true, runId, done };
}

async function executeDeployment(app, run, d, secretSnapshot) {
  const log = makeLogger(app.id, run.id, secretSnapshot);
  const name = pm2Name(app.id);
  const dir = releaseDir(app.id, run.releaseId);
  const before = readState(app.id);

  let switched = false;
  let pm2Path = 'pm2';

  const setStep = (step, title) => {
    run.step = step;
    // A custom step is "step N" in `step`; the stage it continues goes in `stage`.
    run.stage = stageForStep(step, run.stage);
    writeRun(run);
    log.step(title);
  };

  /** Runs one of the engine's own commands (git) through the shared shell. */
  const git = async (args, env) => {
    log.line(`$ git ${args.map(arg => JSON.stringify(arg)).join(' ')}`);
    const authenticated = Boolean(env?.GIT_CONFIG_VALUE_0);
    const r = await d.runFile('git', args, { timeout: GIT_TIMEOUT_MS, env, onData: authenticated ? undefined : c => log.output(c) });
    log.flush();
    if (!r.success) {
      const tail = authenticated ? '' : (r.stderr || r.stdout || '').split('\n').filter(Boolean).slice(-1)[0] ?? '';
      throw new StepError('fetch', tail ? `fetch failed: ${tail}` : `fetch failed (exit ${r.exitCode ?? 'none'})`);
    }
    return r;
  };

  /** Runs the user's commands for one step, in the release directory. */
  const userCommands = async (step, title, commands, env, { hint = null, includeOutput = false } = {}) => {
    if (!commands || commands.length === 0) return;
    setStep(step, title);
    for (const command of commands) {
      log.line(`$ ${command}`);
      let tail = '';
      const r = await d.runCommandLine(command, {
        cwd: dir,
        env: commandEnvironment({
          ...(env ?? {}),
        }),
        replaceEnv: true,
        timeout: STEP_TIMEOUT_MS,
        onData: (c) => {
          log.output(c);
          if (includeOutput) {
            tail += String(c);
            if (tail.length > 4000) tail = tail.slice(-4000);
          }
        },
      });
      log.flush();
      if (!r.success) {
        const why = r.exitCode === null ? (r.stderr || 'it was stopped') : `exit code ${r.exitCode}`;
        const lines = includeOutput
          ? tail.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean).slice(-5)
            .map((l) => sanitizeDeployText(l, secretSnapshot))
          : [];
        const detail = `${title} failed: "${command}" — ${why}${lines.length ? `\n${lines.join('\n')}` : ''}${hint ? `\n${hint}` : ''}`;
        if (hint) log.line(`hint: ${hint}`);
        throw new StepError(step, detail);
      }
    }
  };

  try {
    log.line(`Deployment ${run.id} of ${app.id} (${run.trigger}${run.actor ? `, by ${run.actor}` : ''})`);

    // ── 1. fetch ────────────────────────────────────────────────────────────
    setStep('fetch', `Fetching ${app.repoUrl} @ ${run.ref}`);
    ensureAppDirs(app.id);

    const gitCheck = await d.run('git --version', { timeout: 15000 });
    if (!gitCheck.success) {
      throw new StepError('fetch', 'git is not installed on this server (or not on PATH for the Easy DevOps service).');
    }

    const fetchEnv = gitAuth(app);

    fs.mkdirSync(dir, { recursive: true });
    await git(['init', '-q', dir]);
    await git(['-C', dir, 'remote', 'add', 'origin', app.repoUrl]);
    await git(['-C', dir, 'fetch', '--depth', '1', 'origin', run.ref], fetchEnv);
    await git(['-C', dir, 'checkout', '-q', 'FETCH_HEAD']);
    const head = await git(['-C', dir, 'rev-parse', 'HEAD']);
    run.sha = head.stdout.trim().split(/\s+/).pop() || null;
    writeRun(run);

    // ── 2. settings ─────────────────────────────────────────────────────────
    setStep('settings', 'Reading project settings');
    const project = loadProjectSettings(dir, app.settings ?? {});
    for (const w of project.warnings ?? []) {
      const safeWarning = sanitizeDeployText(w, secretSnapshot);
      log.line(`warning: ${safeWarning}`);
      run.warnings.push(safeWarning);
    }
    if (!project.ok) throw new StepError('settings', project.error);

    const { settings, sources } = project;
    log.line(project.ezLocation ? `ez.json found at ${project.ezLocation}` : 'no ez.json — using package.json defaults');
    for (const field of ['install', 'build', 'migrate', 'start', 'runtime', 'port', 'healthPath', 'execMode', 'instances']) {
      const value = Array.isArray(settings[field]) ? (settings[field].join(' && ') || '(none)') : (settings[field] ?? '(none)');
      log.line(`  ${field.padEnd(10)} ${value}   [${sources[field]}]`);
    }
    if (settings.steps.length > 0) {
      const shown = settings.steps
        .map((s, i) => `${i + 1}.${s.kind}${s.enabled === false ? ' (disabled)' : ''}: ${s.run}`)
        .join(' | ');
      log.line(`  steps      ${shown}   [${sources.steps}]`);
    }
    if (settings.persist.length > 0) {
      log.line(`  persist    ${settings.persist.join(', ')}   [${sources.persist}]`);
    }

    // Before the hooks: a pre-deploy script that writes to the database must
    // write to the shared copy, not to this disposable release. The live
    // release is where the data written up to now is, so it seeds a path
    // that is being made persistent for the first time.
    linkPersistentPaths(app.id, dir, settings.persist, log, before.current ? releaseDir(app.id, before.current) : null);

    const env = appEnvironment(app, settings, run.releaseId);
    const strict = sources.healthPath !== 'default';

    // Which stages this run will not perform is known as soon as the settings
    // are, and the bar should show them as skipped from the start.
    run.skippedStages = plannedSkippedStages(settings);
    writeRun(run);

    // ── 3. pre → steps (install/build/migrate/custom) ───────────────────────
    await userCommands('pre', 'Pre-deploy hook', settings.pre, env);
    for (let i = 0; i < settings.steps.length; i++) {
      const step = settings.steps[i];
      const number = i + 1;
      if (step.enabled === false) {
        log.line(`Skipping step ${number} (${step.kind}): disabled.`);
        continue;
      }
      // The run record's `step` is the kind for the three steps that have
      // special behaviour, and "step N" for a custom one.
      const stepId = step.kind === 'custom' ? `step ${number}` : step.kind;
      const title = step.kind === 'install'
        ? 'Install'
        : step.kind === 'build'
          ? 'Build'
          : step.kind === 'migrate'
            ? 'Migrate'
            : `Step ${number}`;
      await userCommands(stepId, title, [step.run], env, {
        hint: step.kind === 'migrate' ? MIGRATE_HINT : null,
        includeOutput: step.kind === 'migrate',
      });
    }
    verifyPersistentLinks(app.id, dir, settings.persist);

    // ── 4. switch ───────────────────────────────────────────────────────────
    setStep('start', 'Starting the new release');

    const pm2 = await d.runner.detect({ run: d.run, probeVersion: false });
    if (!pm2.installed) {
      throw new StepError('start', 'PM2 is not installed. Install it from the Processes page, or run: npm install -g pm2');
    }
    pm2Path = pm2.path ?? 'pm2';

    writePm2Config(dir, app, run.releaseId, settings, env);
    writeEngineFile(app.id, run.releaseId, 'ez.release.json', JSON.stringify({
      sha: run.sha, ref: run.ref, port: settings.port, healthPath: settings.healthPath, strict,
      persist: settings.persist,
      execMode: settings.execMode,
      instances: settings.instances,
      deployedAt: new Date(d.now()).toISOString(),
    }, null, 2));

    log.line(`$ pm2 delete ${name}; pm2 start ${PM2_CONFIG_FILE}${settings.execMode === 'cluster' ? ' (cluster mode; a running cluster app is reloaded instead)' : ''}`);
    switched = true;
    const started = await switchTo(
      app.id, run.releaseId, dir, name, pm2Path, d, log, { execMode: settings.execMode },
    );
    if (!started.ok) throw new StepError('start', 'PM2 could not start the new release.');

    // ── 5. health ───────────────────────────────────────────────────────────
    setStep('health', 'Checking that the app is healthy');
    const health = await waitHealthy({
      name, port: settings.port, healthPath: settings.healthPath, strict,
      timeoutS: settings.healthTimeout, pm2Path, d,
    });
    log.line(health.detail);
    if (!health.ok) {
      throw new StepError('health', health.detail, { bootCrash: health.crash, reason: health.reason });
    }

    // ── 6. it is live ───────────────────────────────────────────────────────
    writeState(app.id, { current: run.releaseId, previous: before.current });

    // A linked domain follows the app's port.
    const domainNote = await d.syncDomain(app, settings.port);
    if (domainNote) {
      log.line(domainNote);
      if (domainNote.startsWith('warning:')) {
        run.warnings.push(sanitizeDeployText(domainNote.replace(/^warning:\s*/, ''), secretSnapshot));
      }
    }

    try {
      await userCommands('post', 'Post-deploy hook', settings.post, env);
    } catch (err) {
      // The new release is live and healthy. A failing post hook is worth
      // saying loudly, but undoing a good deployment for it is not.
      const warning = sanitizeDeployText(
        `The post-deploy hook failed, but the release is live: ${err.message}`,
        secretSnapshot,
      );
      log.line(`warning: ${warning}`);
      run.warnings.push(warning);
    }

    setStep('finish', 'Finishing');
    const saved = await d.runner.save({ run: d.run, pm2Path });
    if (!saved.ok) log.line('warning: pm2 save failed — the app may not come back after a reboot.');

    const removed = pruneReleases(app.id, {
      keep: app.keepReleases, protect: [run.releaseId, before.current],
    });
    if (removed.length > 0) log.line(`Removed ${removed.length} old release(s).`);

    run.status = RUN_STATUS.SUCCESS;
    log.line('Deployment succeeded.');
  } catch (err) {
    log.flush();
    const bootCrash = err?.bootCrash === true;
    run.error = sanitizeDeployText(err?.message ?? String(err), secretSnapshot);
    run.step = err?.step ?? run.step;
    // The stage stays where the failure happened. A custom step is "step N",
    // which has no stage of its own, so only a canonical step moves `stage`.
    if (RUN_STAGES.includes(run.step)) run.stage = run.step;
    run.reason = err?.reason ? sanitizeDeployText(err.reason, secretSnapshot) : null;
    log.line(`ERROR: ${run.error}`);
    run.status = RUN_STATUS.FAILED;

    // Read the crashed release's own PM2 log BEFORE a rollback reuses the
    // same PM2 name — afterwards these lines belong to the restored release.
    if (bootCrash) {
      run.logTail = await captureBootLog(name, secretSnapshot, pm2Path, d);
      if (run.logTail.length > 0) {
        log.step(`PM2 log (last ${run.logTail.length} lines, secrets redacted)`);
        for (const line of run.logTail) log.line(line);
      } else {
        log.line('PM2 produced no log lines for the crashed release.');
      }
    }

    if (!switched) {
      // Nothing that was running has been touched. The half-built directory
      // is of no use to a rollback and can be large; the log is what explains
      // the failure.
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      run.logTail = [];
      log.line('The running release was not touched.');
    } else if (before.current && app.autoRollback !== false) {
      log.step(`Rolling back to ${before.current}`);
      let restored = false;
      try {
        const previousDir = releaseDir(app.id, before.current);
        const meta = releaseHealth(app.id, before.current, previousDir);
        const back = await switchTo(
          app.id, before.current, previousDir, name, pm2Path, d, log, { execMode: meta.execMode },
        );
        if (back.ok) {
          const health = await waitHealthy({
            name, port: meta.port, healthPath: meta.healthPath, strict: meta.strict,
            timeoutS: ROLLBACK_HEALTH_TIMEOUT_S, pm2Path, d,
          });
          log.line(health.detail);
          restored = health.ok;
        }
      } catch (rollbackErr) {
        log.line(`Rollback error: ${rollbackErr.message}`);
      }

      run.rollbackSucceeded = restored;
      if (restored) {
        // A boot crash stays a failed run — what was deployed never worked —
        // but the fact that the previous release is serving again is recorded
        // rather than hidden. A plain health-check failure keeps the older
        // `rolled_back` status.
        if (!bootCrash) run.status = RUN_STATUS.ROLLED_BACK;
        run.rolledBackTo = before.current;
        log.line(`The previous release (${before.current}) is running again.`);
      } else {
        log.line('The previous release could NOT be restored. The app may be down.');
        run.error += ' The automatic rollback also failed — the app may be down.';
      }
    } else {
      // No release to return to (a first deployment) or rollback is switched
      // off. Remove the broken process so PM2 does not restart it in a loop.
      run.rollbackSucceeded = null;
      try { await d.runner.del(name, { run: d.run, pm2Path }); } catch { /* ignore */ }
      log.line(before.current
        ? 'Automatic rollback is switched off for this app; the process was stopped. Fix the failure and deploy again.'
        : 'There is no earlier release to roll back to, so the new release was stopped. Fix the failure and deploy again.');
    }
  }

  run.finishedAt = d.now();
  if (run.status === RUN_STATUS.SUCCESS) {
    run.step = 'done';
    run.stage = stageForStep('done', run.stage);
  }
  writeRun(run);
  try { pruneRuns(app.id); } catch { /* ignore */ }
  await notify(app, run, d);
  return run;
}

/**
 * Switches an app back to an earlier release, without rebuilding anything.
 *
 * @param {string} appId
 * @param {Object} [opts]
 * @param {string|null} [opts.releaseId] Defaults to the release before the live one
 * @param {string|null} [opts.actor]
 * @param {Object} [opts.deps]
 * @returns {{ ok: true, runId: string, done: Promise<Object> }
 *          | { ok: false, status: number, error: string, runId?: string|null }}
 */
export function startRollback(appId, { releaseId = null, actor = null, deps = {} } = {}) {
  const app = getApp(appId);
  if (!app) return { ok: false, status: 404, error: `No app named "${appId}".` };
  const userCommandEnv = commandEnvironment(app.env ?? {});
  const secretSnapshot = [...new Set([
    ...snapshotDeploySecrets(app),
    ...commandEnvironmentSecrets(userCommandEnv),
  ])].sort((a, b) => b.length - a.length || a.localeCompare(b));

  const before = readState(appId);
  const target = releaseId ?? before.previous;
  if (!target) return { ok: false, status: 409, error: 'There is no earlier release to roll back to.' };
  if (target === before.current) return { ok: false, status: 409, error: 'That release is already the live one.' };
  if (!listReleases(appId).includes(target)) {
    return { ok: false, status: 404, error: `Release ${target} is no longer on this server.` };
  }

  let targetDir;
  try { targetDir = releaseDir(appId, target); } catch { return { ok: false, status: 400, error: 'Invalid release id.' }; }
  const targetConfig = configFileForRelease(appId, target, targetDir);
  if (!targetConfig || !regularReleaseFile(targetConfig)) {
    return { ok: false, status: 409, error: `Release ${target} was never started, so it cannot be rolled back to.` };
  }

  const d = resolveDeps(deps);
  const runId = newReleaseId(new Date(d.now()));
  const lock = acquireLock(appId, { runId });
  if (!lock.ok) return { ok: false, status: 409, error: lock.reason, runId: lock.runId };

  const meta = releaseHealth(appId, target, targetDir);
  const run = {
    id: runId,
    appId,
    trigger: 'rollback',
    actor,
    ref: meta.ref,
    sha: meta.sha,
    releaseId: target,
    status: RUN_STATUS.RUNNING,
    step: 'start',
    /** A rollback starts nothing and builds nothing: only start > health. */
    stage: 'start',
    skippedStages: ['fetch', 'settings', 'pre', 'install', 'build', 'migrate', 'post'],
    startedAt: d.now(),
    finishedAt: null,
    error: null,
    warnings: [],
    rolledBackTo: null,
    reason: null,
    logTail: [],
    rollbackSucceeded: null,
    logSecurity: LOG_SECURITY_REDACTED_V1,
  };
  writeRun(run);

  const done = (async () => {
    const log = makeLogger(appId, runId, secretSnapshot);
    const name = pm2Name(appId);
    let pm2Path = 'pm2';

    try {
      log.line(`Rollback ${runId} of ${appId} to release ${target}${actor ? ` (by ${actor})` : ''}`);
      const pm2 = await d.runner.detect({ run: d.run, probeVersion: false });
      if (!pm2.installed) throw new StepError('start', 'PM2 is not installed.');
      pm2Path = pm2.path ?? 'pm2';

      log.step(`Starting release ${target}`);
      const started = await switchTo(
        appId, target, targetDir, name, pm2Path, d, log, { execMode: meta.execMode },
      );
      if (!started.ok) throw new StepError('start', 'PM2 could not start that release.');

      run.step = 'health';
      run.stage = stageForStep('health', run.stage);
      writeRun(run);
      log.step('Checking that the app is healthy');
      const health = await waitHealthy({
        name, port: meta.port, healthPath: meta.healthPath, strict: meta.strict,
        timeoutS: ROLLBACK_HEALTH_TIMEOUT_S, pm2Path, d,
      });
      log.line(health.detail);
      if (!health.ok) throw new StepError('health', health.detail, { bootCrash: health.crash, reason: health.reason });

      writeState(appId, { current: target, previous: before.current });
      await d.runner.save({ run: d.run, pm2Path });
      run.status = RUN_STATUS.SUCCESS;
      run.step = 'done';
      run.stage = stageForStep('done', run.stage);
      log.line('Rollback succeeded.');
    } catch (err) {
      run.status = RUN_STATUS.FAILED;
      run.error = sanitizeDeployText(err?.message ?? String(err), secretSnapshot);
      run.reason = err?.reason ? sanitizeDeployText(err.reason, secretSnapshot) : null;
      run.step = err?.step ?? run.step;
      if (RUN_STAGES.includes(run.step)) run.stage = run.step;
      log.line(`ERROR: ${run.error}`);

      // Put back what was running, so a failed rollback is not also an outage.
      if (before.current) {
        try {
          const restoreDir = releaseDir(appId, before.current);
          const restoreMeta = releaseHealth(appId, before.current, restoreDir);
          const back = await switchTo(
            appId, before.current, restoreDir, name, pm2Path, d, log, { execMode: restoreMeta.execMode },
          );
          log.line(back.ok
            ? `Release ${before.current} was started again.`
            : `Release ${before.current} could NOT be started again. The app may be down.`);
        } catch (restoreErr) {
          log.line(`Restore error: ${restoreErr.message}`);
        }
      }
    }

    run.finishedAt = d.now();
    writeRun(run);
    try { pruneRuns(appId); } catch { /* ignore */ }
    await notify(app, run, d);
    return run;
  })()
    .catch((err) => {
      run.status = RUN_STATUS.FAILED;
      run.error = sanitizeDeployText(err?.message ?? String(err), secretSnapshot);
      run.finishedAt = d.now();
      try { writeRun(run); } catch { /* ignore */ }
      return run;
    })
    .finally(() => lock.release());

  return { ok: true, runId, done };
}

/**
 * Deletes one release folder — the files of an old deployment.
 *
 * The live release and the one an automatic rollback would return to are
 * refused: deleting either turns the next failure into an outage. Run records
 * are history and stay; only the files go, and the shared data they linked to
 * is untouched.
 *
 * @returns {{ ok: boolean, status: number, error: string|null, deleted?: string }}
 */
export function removeRelease(appId, releaseId) {
  const app = getApp(appId);
  if (!app) return { ok: false, status: 404, error: `No app named "${appId}".` };
  if (!isId(releaseId)) return { ok: false, status: 400, error: 'Invalid release id.' };
  if (!listReleases(appId).includes(releaseId)) {
    return { ok: false, status: 404, error: `Release ${releaseId} is no longer on this server.` };
  }

  const lock = acquireLock(appId, { runId: null });
  if (!lock.ok) return { ok: false, status: 409, error: 'A deployment of this app is running. Wait for it to finish.' };
  try {
    // Re-read under the lock: a deployment may have finished in between.
    const state = readState(appId);
    if (releaseId === state.current) {
      return { ok: false, status: 409, error: 'That release is live. Roll back to another release before deleting it.' };
    }
    if (releaseId === state.previous) {
      return { ok: false, status: 409, error: 'That release is the one an automatic rollback would return to. Delete it after the next deployment.' };
    }
    fs.rmSync(releaseDir(appId, releaseId), { recursive: true, force: true });
    removeEngineRelease(appId, releaseId);
    return { ok: true, status: 200, error: null, deleted: releaseId };
  } catch (err) {
    return { ok: false, status: 500, error: `The release could not be deleted: ${err.message}` };
  } finally {
    lock.release();
  }
}

/**
 * Removes an app: stops its process, forgets it, deletes its files.
 *
 * @param {string} appId
 * @param {Object} [opts]
 * @param {boolean} [opts.deleteDomain] Also remove the domain linked to it
 * @param {boolean} [opts.purgeData] Also delete the persistent paths, not just the app
 * @returns {Promise<{ ok: boolean, status: number, error: string|null, domainDeleted?: boolean,
 *   warning?: string|null, sharedKept?: boolean, sharedPath?: string }>}
 */
export async function removeApp(appId, { deleteDomain = false, purgeData = false, deps = {} } = {}) {
  const app = getApp(appId);
  if (!app) return { ok: false, status: 404, error: `No app named "${appId}".` };

  const d = resolveDeps(deps);
  const lock = acquireLock(appId, { runId: null });
  if (!lock.ok) return { ok: false, status: 409, error: 'A deployment of this app is running. Wait for it to finish.' };

  try {
    if (d.recheck) d.recheck();
    await stopProcess(appId, d, { save: true });
  } catch (error) {
    if (error?.code === 'HUB_PERMISSION_REVOKED') throw error;
    // Other stop failures do not keep a registry entry the caller asked to
    // remove, but a revocation must stop the larger operation immediately.
  } finally {
    lock.release();
  }

  // The domain goes first, while the app record still says which one it is. A
  // failure here does not keep the app: the person asked for the app to go.
  let domainDeleted = false;
  let warning = null;
  if (deleteDomain && app.domain) {
    if (d.recheck) d.recheck();
    const removed = await d.deleteDomain(app, { recheck: d.recheck });
    domainDeleted = removed.ok;
    if (!removed.ok) warning = `The app was deleted, but the domain ${app.domain} was not: ${removed.error}`;
  }

  // Resolved before the record goes: afterwards nothing knows this app's folder.
  const sharedPath = appPaths(appId).shared;
  if (d.recheck) d.recheck();
  const files = deleteApp(appId, { purgeData }) ?? { keptShared: false };
  return {
    ok: true, status: 200, error: null, domainDeleted, warning,
    sharedKept: Boolean(files.keptShared), sharedPath,
  };
}

/**
 * Stops an app's PM2 process — only when PM2 exists and its daemon is up: a
 * stop must never be the thing that starts a PM2 daemon on a machine that was
 * not running one.
 *
 * @returns {Promise<{ pm2Path: string|null, wasRunning: boolean }>}
 */
async function stopProcess(appId, d, { save = false } = {}) {
  const pm2 = await d.runner.detect({ run: d.run, probeVersion: false });
  const daemonUp = typeof d.runner.isDaemonRunning === 'function' ? d.runner.isDaemonRunning() : true;
  if (!pm2.installed || !daemonUp) return { pm2Path: pm2.installed ? (pm2.path ?? 'pm2') : null, wasRunning: false };

  const pm2Path = pm2.path ?? 'pm2';
  const name = pm2Name(appId);
  let wasRunning = false;
  try {
    const listed = await d.runner.list({ run: d.run, pm2Path });
    wasRunning = Boolean(listed.ok && listed.apps.some((a) => a.name === name));
  } catch { /* treat as not running */ }

  if (d.recheck) d.recheck();
  await d.runner.del(name, { run: d.run, pm2Path });
  if (d.recheck) d.recheck();
  if (save) await d.runner.save({ run: d.run, pm2Path });
  return { pm2Path, wasRunning };
}

/** True when `child` is `parent` or lies inside it. */
function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Moves a directory: a rename when possible, a copy-then-delete across devices. */
function moveDirectory(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    // A folder another process (a scanner, a just-stopped app releasing its
    // files) still holds open is a momentary Windows denial; retrying it is
    // what stops the whole move — and its rollback — failing on the first try.
    // Every other code, EXDEV included, is rethrown at once.
    renameWithRetry(from, to);
  } catch (err) {
    // EXDEV: the destination is on another disk or mount. Copy, then remove.
    if (err.code !== 'EXDEV') throw err;
    fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/**
 * Moves an app's folder to another place on the server.
 *
 * In order: stop its PM2 process (it holds the folder open, and on Windows a
 * folder in use cannot be moved at all) → move the folder → record the new
 * location → point each release's PM2 config at its new path → start the live
 * release again. If the move itself fails nothing has changed, and the process
 * is started again where it was.
 *
 * `targetDir` is the PARENT folder: the app ends up in `<targetDir>/<app id>`,
 * so a folder can hold several apps without them colliding.
 *
 * @param {string} appId
 * @param {string} targetDir
 * @param {{ deps?: Object }} [opts]
 * @returns {Promise<{ ok: boolean, status: number, error: string|null,
 *   from?: string, to?: string, restarted?: boolean, warning?: string|null }>}
 */
export async function moveApp(appId, targetDir, { deps = {} } = {}) {
  const app = getApp(appId);
  if (!app) return { ok: false, status: 404, error: `No app named "${appId}".` };

  const dirError = validateDeployDir(targetDir);
  if (dirError) return { ok: false, status: 400, error: dirError };

  const from = appPaths(appId).root;
  const to = path.join(path.resolve(String(targetDir).trim()), appId);

  if (path.resolve(from) === path.resolve(to)) {
    return { ok: false, status: 409, error: 'The app is already in that folder.' };
  }
  if (isInside(to, from)) return { ok: false, status: 400, error: 'The new folder cannot be inside the app’s current folder.' };
  if (fs.existsSync(to) && fs.readdirSync(to).length > 0) {
    return { ok: false, status: 409, error: `${to} already exists and is not empty.` };
  }

  const d = resolveDeps(deps);
  const lock = acquireLock(appId, { runId: null });
  if (!lock.ok) return { ok: false, status: 409, error: 'A deployment of this app is running. Wait for it to finish.' };

  const state = readState(appId);
  let pm2Path = null;
  let wasRunning = false;

  /** Starts the live release from wherever the app now is. */
  const startCurrent = async () => {
    if (!state.current || !pm2Path) return false;
    const currentDir = releaseDir(appId, state.current);
    const config = configFileForRelease(appId, state.current, currentDir);
    if (!config || !regularReleaseFile(config)) return false;
    const started = await d.runner.startConfig(config, { run: d.run, pm2Path });
    if (started.ok) await d.runner.save({ run: d.run, pm2Path });
    return started.ok;
  };

  try {
    if (d.recheck) d.recheck();
    ({ pm2Path, wasRunning } = await stopProcess(appId, d));

    // An empty folder left by an earlier attempt would make the rename fail.
    if (fs.existsSync(to)) fs.rmdirSync(to);

    // Detached first: a junction holds an absolute path into the old folder,
    // and a cross-device copy must not read through the links.
    if (d.recheck) d.recheck();
    detachPersistentLinks(appId);

    try {
      if (d.recheck) d.recheck();
      if (fs.existsSync(from)) moveDirectory(from, to);
      else fs.mkdirSync(to, { recursive: true });
    } catch (err) {
      // Nothing was recorded, so the app is still where it was. Put it back up.
      attachPersistentLinks(appId);
      if (wasRunning) await startCurrent();
      return { ok: false, status: 500, error: `The folder could not be moved: ${err.message}` };
    }

    if (d.recheck) d.recheck();
    setAppDir(appId, to);
    const relinkFailures = attachPersistentLinks(appId);

    // The lock file travelled with the folder; it is ours, and the old path it
    // was taken at no longer exists for release() to clean up.
    try { fs.rmSync(pathsIn(to).lock, { force: true }); } catch { /* ignore */ }

    // Each release's PM2 config names its own absolute path.
    for (const id of listReleases(appId)) {
      const dir = releaseDir(appId, id);
      try {
        const file = configFileForRelease(appId, id, dir);
        if (!file || !regularReleaseFile(file)) continue;
        const config = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const entry of config.apps ?? []) entry.cwd = dir;
        writeEngineFile(appId, id, PM2_CONFIG_FILE, JSON.stringify(config, null, 2));
      } catch { /* a release that never started has no config */ }
    }

    let restarted = false;
    let warning = null;
    if (wasRunning) {
      if (d.recheck) d.recheck();
      restarted = await startCurrent();
      if (!restarted) warning = 'The app was moved, but PM2 could not start it again. Deploy it, or start it from the Processes page.';
    }
    if (relinkFailures.length > 0) {
      const note = `These persistent paths could not be linked again: ${relinkFailures.join('; ')}. Deploy the app to restore them.`;
      warning = warning ? `${warning} ${note}` : `The app was moved, but ${note}`;
    }

    return { ok: true, status: 200, error: null, from, to, restarted, warning };
  } finally {
    lock.release();
  }
}

/** The finished-or-running record of a run, or null. */
export function getRun(appId, runId) {
  return readRun(appId, runId);
}
