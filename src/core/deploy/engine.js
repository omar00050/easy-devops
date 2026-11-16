/**
 * core/deploy/engine.js
 *
 * Puts a project on the server and keeps the previous version one step away.
 *
 * One deployment, in order:
 *
 *   1. fetch     a fresh checkout into releases/<id> — never over the live one
 *   2. settings  ez.json + package.json + the app's overrides (ezfile.js)
 *   3. pre hook → install → build      all in the new directory
 *   4. switch    stop the old process, start the new one under PM2
 *   5. health    the app must answer (or stay up) before it counts
 *   6. post hook, save the PM2 list, prune old releases
 *
 * Nothing before step 4 touches what is running, so a broken build costs
 * nothing. If step 4 or 5 fails and there is a previous release, it is started
 * again — the same files that were running before, not a rebuild.
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

import { run as defaultRun, runCommandLine as defaultRunCommandLine } from '../shell.js';
import * as defaultRunner from '../runner.js';
import { createDeployEvent } from '../events.js';
import { sendNotification as defaultSendNotification } from '../notifier.js';
import { publish } from '../jobs/bus.js';

import { getApp, deleteApp, pm2Name, AUTH_TYPES, deployKeyPath, validateRef, setAppDir } from './apps.js';
import { deleteLinkedDomain, syncLinkedDomain } from './domainLink.js';
import {
  EZ_FILE_LOCATIONS, parseEzFile, resolveSettings, parseStartCommand,
} from './ezfile.js';
import { LAUNCHER_FILE, LAUNCHER_SOURCE, LAUNCHER_COMMAND_ENV } from './launcher.js';
import {
  acquireLock, appPaths, ensureAppDirs, listReleases, logFile, newReleaseId, pathsIn, pruneReleases, pruneRuns,
  readRun, readState, releaseDir, validateDeployDir, writeRun, writeState,
} from './store.js';

/** The PM2 config written into every release. Its presence is what makes a release startable. */
export const PM2_CONFIG_FILE = 'ez.pm2.json';

const GIT_TIMEOUT_MS = 5 * 60 * 1000;
/** Installs and builds are slow on small servers; a tight limit only produces false failures. */
const STEP_TIMEOUT_MS = 20 * 60 * 1000;
const HEALTH_POLL_MS = 2000;
/** Without a port there is nothing to ask, so the app only has to stay up this long. */
const NO_PORT_SETTLE_MS = 8000;
const ROLLBACK_HEALTH_TIMEOUT_S = 30;

export const RUN_STATUS = Object.freeze({
  RUNNING: 'running',
  SUCCESS: 'success',
  FAILED: 'failed',
  ROLLED_BACK: 'rolled_back',
});

/** A failure with the step it happened in, so the run record can say where. */
class StepError extends Error {
  constructor(step, message) {
    super(message);
    this.step = step;
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

// ─── The engine ───────────────────────────────────────────────────────────────

function resolveDeps(deps = {}) {
  return {
    run: deps.run ?? defaultRun,
    runCommandLine: deps.runCommandLine ?? defaultRunCommandLine,
    runner: deps.runner ?? defaultRunner,
    probe: deps.probe ?? probeHttp,
    sleep: deps.sleep ?? sleepFor,
    sendNotification: deps.sendNotification ?? defaultSendNotification,
    syncDomain: deps.syncDomain ?? syncLinkedDomain,
    deleteDomain: deps.deleteDomain ?? deleteLinkedDomain,
    now: deps.now ?? (() => Date.now()),
  };
}

/** Appends timestamped lines to a run's log. Never throws: a full disk must not mask the real error. */
function makeLogger(appId, runId) {
  const file = logFile(appId, runId);
  let partial = '';

  const write = (text) => {
    try { fs.appendFileSync(file, text); } catch { /* ignore */ }
  };
  const stamp = () => new Date().toISOString().slice(11, 19);

  return {
    file,
    /** A line written by the engine itself. */
    line(text = '') {
      write(`${stamp()}  ${text}\n`);
    },
    /** A heading for a step. */
    step(title) {
      write(`\n${stamp()}  ── ${title}\n`);
    },
    /** Raw output from a command, line-buffered so chunks do not interleave mid-line. */
    output(chunk) {
      partial += String(chunk).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const lines = partial.split('\n');
      partial = lines.pop() ?? '';
      if (lines.length > 0) write(lines.map((l) => `          ${l}`).join('\n') + '\n');
    },
    flush() {
      if (partial) { write(`          ${partial}\n`); partial = ''; }
    },
  };
}

/** Double-quotes a path for a shell command. Paths come from the data directory, never from user input. */
function q(p) {
  return `"${String(p)}"`;
}

/**
 * The git invocation prefix and environment for an app's credentials.
 *
 * A token is passed as a per-command HTTP header rather than embedded in the
 * remote URL: in the URL it would be written into the checkout's .git/config
 * and stay on disk in every release. `display` is what goes in the log.
 */
function gitAuth(app) {
  const env = { GIT_TERMINAL_PROMPT: '0' };

  if (app.auth?.type === AUTH_TYPES.TOKEN && app.auth.token) {
    const basic = Buffer.from(`x-access-token:${app.auth.token}`).toString('base64');
    return {
      env,
      flags: `-c "http.extraHeader=Authorization: Basic ${basic}"`,
      display: '-c "http.extraHeader=Authorization: Basic ***"',
    };
  }

  if (app.auth?.type === AUTH_TYPES.DEPLOY_KEY) {
    const key = deployKeyPath(app.id);
    if (!key) throw new StepError('fetch', 'This app uses a deploy key, but none has been generated yet.');
    // Forward slashes: git runs this through its own sh, where a backslash in
    // a Windows path would be read as an escape.
    const keyArg = key.replace(/\\/g, '/');
    env.GIT_SSH_COMMAND =
      `ssh -i "${keyArg}" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new`;
  }

  return { env, flags: '', display: '' };
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
  return { ...resolved, warnings, ezLocation };
}

/** The environment a deployed app (and its build) runs with. */
function appEnvironment(app, settings, releaseId) {
  const env = { ...(app.env ?? {}) };
  // Most frameworks read PORT. Setting it from the declared port means the
  // port in ez.json is the port the app actually listens on.
  if (settings.port && env.PORT === undefined) env.PORT = String(settings.port);
  env.EZ_APP = app.id;
  env.EZ_RELEASE = releaseId;
  return env;
}

/** Writes the PM2 config (and the launcher, when needed) into a release directory. */
function writePm2Config(dir, app, settings, env) {
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
    fs.writeFileSync(path.join(dir, LAUNCHER_FILE), LAUNCHER_SOURCE);
    entry.script = LAUNCHER_FILE;
    entry.env[LAUNCHER_COMMAND_ENV] = start.command;
  }

  const file = path.join(dir, PM2_CONFIG_FILE);
  // Holds the app's environment, so owner-only like the deploy key.
  fs.writeFileSync(file, JSON.stringify({ apps: [entry] }, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* not meaningful on Windows */ }
  return file;
}

/** Reads back the health settings a release was started with, for a rollback. */
function releaseHealth(dir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'ez.release.json'), 'utf8'));
    return {
      port: Number.isInteger(meta.port) ? meta.port : null,
      healthPath: typeof meta.healthPath === 'string' ? meta.healthPath : '/',
      strict: Boolean(meta.strict),
      sha: typeof meta.sha === 'string' ? meta.sha : null,
      ref: typeof meta.ref === 'string' ? meta.ref : null,
    };
  } catch {
    return { port: null, healthPath: '/', strict: false, sha: null, ref: null };
  }
}

/** What a release was built from, for the UI's release list. */
export function describeRelease(appId, releaseId) {
  let dir;
  try { dir = releaseDir(appId, releaseId); } catch { return null; }
  const meta = releaseHealth(dir);
  return {
    id: releaseId,
    sha: meta.sha,
    ref: meta.ref,
    startable: fs.existsSync(path.join(dir, PM2_CONFIG_FILE)),
  };
}

/**
 * Waits for a freshly started app to be healthy.
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
async function waitHealthy({ name, port, healthPath, strict, timeoutS, pm2Path, d }) {
  const status = async () => {
    const listed = await d.runner.list({ run: d.run, pm2Path });
    if (!listed.ok) return null;
    return listed.apps.find((a) => a.name === name) ?? null;
  };

  if (!port) {
    // Nothing to ask over HTTP: the app has to stay online, without PM2
    // restarting it, for a few seconds.
    await d.sleep(Math.min(2000, NO_PORT_SETTLE_MS));
    const early = await status();
    await d.sleep(NO_PORT_SETTLE_MS - 2000);
    const late = await status();
    if (!late) return { ok: false, detail: 'PM2 no longer lists the process.' };
    if (late.status !== 'online') return { ok: false, detail: `The process is "${late.status}", not online.` };
    if (early && late.restarts > early.restarts) {
      return { ok: false, detail: 'The process keeps restarting — it starts and then exits.' };
    }
    return { ok: true, detail: 'The process stayed online (no port is configured, so no HTTP check was made).' };
  }

  const deadline = d.now() + timeoutS * 1000;
  let last = 'no response yet';

  for (;;) {
    const res = await d.probe(port, healthPath);
    if (res.ok && isHealthyStatus(res.status, strict)) {
      return { ok: true, detail: `GET ${healthPath} on port ${port} answered ${res.status}.` };
    }
    last = res.ok ? `it answered ${res.status}` : `no answer (${res.error})`;

    // A process PM2 has given up on will never become healthy; stop waiting.
    const app = await status();
    if (app && (app.status === 'errored' || app.status === 'stopped')) {
      return { ok: false, detail: `The process is "${app.status}" — it exited instead of listening on port ${port}.` };
    }

    if (d.now() >= deadline) break;
    await d.sleep(HEALTH_POLL_MS);
  }

  return {
    ok: false,
    detail: `No healthy response from GET ${healthPath} on port ${port} within ${timeoutS}s (${last}).`,
  };
}

/** Stops whatever is running under the app's PM2 name and starts a release. */
async function switchTo(dir, name, pm2Path, d, log) {
  const config = path.join(dir, PM2_CONFIG_FILE);
  if (!fs.existsSync(config)) return { ok: false, output: `${PM2_CONFIG_FILE} is missing from ${dir}.` };

  // `delete` rather than `restart`: the working directory and the environment
  // belong to the release, and PM2 keeps the old ones across a restart.
  // Deleting a name PM2 does not know fails harmlessly on a first deployment.
  await d.runner.del(name, { run: d.run, pm2Path });
  const started = await d.runner.startConfig(config, { run: d.run, pm2Path });
  if (!started.ok) log.line(started.output || 'pm2 start failed with no output');
  return started;
}

async function notify(app, run, d) {
  const event = createDeployEvent(app.id, run.status, {
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
 * @returns {{ ok: true, runId: string, done: Promise<Object> }
 *          | { ok: false, status: number, error: string, runId?: string|null }}
 */
export function startDeployment(appId, { trigger = 'manual', ref = null, actor = null, deps = {} } = {}) {
  const app = getApp(appId);
  if (!app) return { ok: false, status: 404, error: `No app named "${appId}".` };

  if (ref !== null && ref !== undefined && ref !== '') {
    const refError = validateRef(String(ref));
    if (refError) return { ok: false, status: 400, error: refError };
  }

  const d = resolveDeps(deps);
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
    startedAt: d.now(),
    finishedAt: null,
    error: null,
    warnings: [],
    rolledBackTo: null,
  };
  writeRun(run);

  const done = executeDeployment(app, run, d)
    .catch((err) => {
      // executeDeployment handles its own failures; this is the net under it.
      run.status = RUN_STATUS.FAILED;
      run.error = err?.message ?? String(err);
      run.finishedAt = d.now();
      try { writeRun(run); } catch { /* ignore */ }
      return run;
    })
    .finally(() => lock.release());

  return { ok: true, runId, done };
}

async function executeDeployment(app, run, d) {
  const log = makeLogger(app.id, run.id);
  const name = pm2Name(app.id);
  const dir = releaseDir(app.id, run.releaseId);
  const before = readState(app.id);

  let switched = false;
  let pm2Path = 'pm2';

  const setStep = (step, title) => {
    run.step = step;
    writeRun(run);
    log.step(title);
  };

  /** Runs one of the engine's own commands (git) through the shared shell. */
  const sh = async (step, command, display, options = {}) => {
    log.line(`$ ${display ?? command}`);
    const r = await d.run(command, { timeout: GIT_TIMEOUT_MS, onData: (c) => log.output(c), ...options });
    log.flush();
    if (!r.success) {
      const tail = (r.stderr || r.stdout || '').split('\n').filter(Boolean).slice(-1)[0] ?? '';
      throw new StepError(step, tail ? `${step} failed: ${tail}` : `${step} failed (exit ${r.exitCode ?? 'none'})`);
    }
    return r;
  };

  /** Runs the user's commands for one step, in the release directory. */
  const userCommands = async (step, title, commands, env) => {
    if (!commands || commands.length === 0) return;
    setStep(step, title);
    for (const command of commands) {
      log.line(`$ ${command}`);
      const r = await d.runCommandLine(command, {
        cwd: dir, env, timeout: STEP_TIMEOUT_MS, onData: (c) => log.output(c),
      });
      log.flush();
      if (!r.success) {
        const why = r.exitCode === null ? (r.stderr || 'it was stopped') : `exit code ${r.exitCode}`;
        throw new StepError(step, `${title} failed: "${command}" — ${why}`);
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

    const auth = gitAuth(app);
    const gitOpts = { env: auth.env };
    const flags = auth.flags ? ` ${auth.flags}` : '';
    const shown = auth.display ? ` ${auth.display}` : '';

    fs.mkdirSync(dir, { recursive: true });
    await sh('fetch', `git init -q ${q(dir)}`, null, gitOpts);
    await sh('fetch', `git -C ${q(dir)} remote add origin ${q(app.repoUrl)}`, null, gitOpts);
    await sh(
      'fetch',
      `git -C ${q(dir)}${flags} fetch --depth 1 origin ${q(run.ref)}`,
      `git -C ${q(dir)}${shown} fetch --depth 1 origin ${q(run.ref)}`,
      gitOpts,
    );
    await sh('fetch', `git -C ${q(dir)} checkout -q FETCH_HEAD`, null, gitOpts);
    const head = await sh('fetch', `git -C ${q(dir)} rev-parse HEAD`, null, gitOpts);
    run.sha = head.stdout.trim().split(/\s+/).pop() || null;
    writeRun(run);

    // ── 2. settings ─────────────────────────────────────────────────────────
    setStep('settings', 'Reading project settings');
    const project = loadProjectSettings(dir, app.settings ?? {});
    for (const w of project.warnings ?? []) { log.line(`warning: ${w}`); run.warnings.push(w); }
    if (!project.ok) throw new StepError('settings', project.error);

    const { settings, sources } = project;
    log.line(project.ezLocation ? `ez.json found at ${project.ezLocation}` : 'no ez.json — using package.json defaults');
    for (const field of ['install', 'build', 'start', 'port', 'healthPath']) {
      const value = Array.isArray(settings[field]) ? (settings[field].join(' && ') || '(none)') : (settings[field] ?? '(none)');
      log.line(`  ${field.padEnd(10)} ${value}   [${sources[field]}]`);
    }

    const env = appEnvironment(app, settings, run.releaseId);
    const strict = sources.healthPath !== 'default';

    // ── 3. pre → install → build ────────────────────────────────────────────
    await userCommands('pre', 'Pre-deploy hook', settings.pre, env);
    await userCommands('install', 'Install', settings.install, env);
    await userCommands('build', 'Build', settings.build, env);

    // ── 4. switch ───────────────────────────────────────────────────────────
    setStep('start', 'Starting the new release');

    const pm2 = await d.runner.detect({ run: d.run, probeVersion: false });
    if (!pm2.installed) {
      throw new StepError('start', 'PM2 is not installed. Install it from the Processes page, or run: npm install -g pm2');
    }
    pm2Path = pm2.path ?? 'pm2';

    writePm2Config(dir, app, settings, env);
    fs.writeFileSync(path.join(dir, 'ez.release.json'), JSON.stringify({
      sha: run.sha, ref: run.ref, port: settings.port, healthPath: settings.healthPath, strict,
      deployedAt: new Date(d.now()).toISOString(),
    }, null, 2));

    log.line(`$ pm2 delete ${name}; pm2 start ${PM2_CONFIG_FILE}`);
    switched = true;
    const started = await switchTo(dir, name, pm2Path, d, log);
    if (!started.ok) throw new StepError('start', 'PM2 could not start the new release.');

    // ── 5. health ───────────────────────────────────────────────────────────
    setStep('health', 'Checking that the app is healthy');
    const health = await waitHealthy({
      name, port: settings.port, healthPath: settings.healthPath, strict,
      timeoutS: settings.healthTimeout, pm2Path, d,
    });
    log.line(health.detail);
    if (!health.ok) throw new StepError('health', health.detail);

    // ── 6. it is live ───────────────────────────────────────────────────────
    writeState(app.id, { current: run.releaseId, previous: before.current });

    // A linked domain follows the app's port.
    const domainNote = await d.syncDomain(app, settings.port);
    if (domainNote) {
      log.line(domainNote);
      if (domainNote.startsWith('warning:')) run.warnings.push(domainNote.replace(/^warning:\s*/, ''));
    }

    try {
      await userCommands('post', 'Post-deploy hook', settings.post, env);
    } catch (err) {
      // The new release is live and healthy. A failing post hook is worth
      // saying loudly, but undoing a good deployment for it is not.
      const warning = `The post-deploy hook failed, but the release is live: ${err.message}`;
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
    run.error = err?.message ?? String(err);
    run.step = err?.step ?? run.step;
    log.line(`ERROR: ${run.error}`);
    run.status = RUN_STATUS.FAILED;

    if (!switched) {
      // Nothing that was running has been touched. The half-built directory
      // is of no use to a rollback and can be large; the log is what explains
      // the failure.
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      log.line('The running release was not touched.');
    } else if (before.current && app.autoRollback !== false) {
      log.step(`Rolling back to ${before.current}`);
      let restored = false;
      try {
        const previousDir = releaseDir(app.id, before.current);
        const back = await switchTo(previousDir, name, pm2Path, d, log);
        if (back.ok) {
          const meta = releaseHealth(previousDir);
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

      if (restored) {
        run.status = RUN_STATUS.ROLLED_BACK;
        run.rolledBackTo = before.current;
        log.line(`The previous release (${before.current}) is running again.`);
      } else {
        log.line('The previous release could NOT be restored. The app may be down.');
        run.error += ' The automatic rollback also failed — the app may be down.';
      }
    } else {
      // No release to return to (a first deployment) or rollback is switched
      // off. Remove the broken process so PM2 does not restart it in a loop.
      try { await d.runner.del(name, { run: d.run, pm2Path }); } catch { /* ignore */ }
      log.line(before.current
        ? 'Automatic rollback is switched off for this app; the process was stopped.'
        : 'There is no earlier release to roll back to; the process was stopped.');
    }
  }

  run.finishedAt = d.now();
  if (run.status !== RUN_STATUS.RUNNING) run.step = run.status === RUN_STATUS.SUCCESS ? 'done' : run.step;
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

  const before = readState(appId);
  const target = releaseId ?? before.previous;
  if (!target) return { ok: false, status: 409, error: 'There is no earlier release to roll back to.' };
  if (target === before.current) return { ok: false, status: 409, error: 'That release is already the live one.' };
  if (!listReleases(appId).includes(target)) {
    return { ok: false, status: 404, error: `Release ${target} is no longer on this server.` };
  }

  let targetDir;
  try { targetDir = releaseDir(appId, target); } catch { return { ok: false, status: 400, error: 'Invalid release id.' }; }
  if (!fs.existsSync(path.join(targetDir, PM2_CONFIG_FILE))) {
    return { ok: false, status: 409, error: `Release ${target} was never started, so it cannot be rolled back to.` };
  }

  const d = resolveDeps(deps);
  const runId = newReleaseId(new Date(d.now()));
  const lock = acquireLock(appId, { runId });
  if (!lock.ok) return { ok: false, status: 409, error: lock.reason, runId: lock.runId };

  const meta = releaseHealth(targetDir);
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
    startedAt: d.now(),
    finishedAt: null,
    error: null,
    warnings: [],
    rolledBackTo: null,
  };
  writeRun(run);

  const done = (async () => {
    const log = makeLogger(appId, runId);
    const name = pm2Name(appId);
    let pm2Path = 'pm2';

    try {
      log.line(`Rollback ${runId} of ${appId} to release ${target}${actor ? ` (by ${actor})` : ''}`);
      const pm2 = await d.runner.detect({ run: d.run, probeVersion: false });
      if (!pm2.installed) throw new StepError('start', 'PM2 is not installed.');
      pm2Path = pm2.path ?? 'pm2';

      log.step(`Starting release ${target}`);
      const started = await switchTo(targetDir, name, pm2Path, d, log);
      if (!started.ok) throw new StepError('start', 'PM2 could not start that release.');

      run.step = 'health';
      writeRun(run);
      log.step('Checking that the app is healthy');
      const health = await waitHealthy({
        name, port: meta.port, healthPath: meta.healthPath, strict: meta.strict,
        timeoutS: ROLLBACK_HEALTH_TIMEOUT_S, pm2Path, d,
      });
      log.line(health.detail);
      if (!health.ok) throw new StepError('health', health.detail);

      writeState(appId, { current: target, previous: before.current });
      await d.runner.save({ run: d.run, pm2Path });
      run.status = RUN_STATUS.SUCCESS;
      run.step = 'done';
      log.line('Rollback succeeded.');
    } catch (err) {
      run.status = RUN_STATUS.FAILED;
      run.error = err?.message ?? String(err);
      run.step = err?.step ?? run.step;
      log.line(`ERROR: ${run.error}`);

      // Put back what was running, so a failed rollback is not also an outage.
      if (before.current) {
        try {
          const back = await switchTo(releaseDir(appId, before.current), name, pm2Path, d, log);
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
      run.error = err?.message ?? String(err);
      run.finishedAt = d.now();
      try { writeRun(run); } catch { /* ignore */ }
      return run;
    })
    .finally(() => lock.release());

  return { ok: true, runId, done };
}

/**
 * Removes an app: stops its process, forgets it, deletes its files.
 *
 * @param {string} appId
 * @param {Object} [opts]
 * @param {boolean} [opts.deleteDomain] Also remove the domain linked to it
 * @returns {Promise<{ ok: boolean, status: number, error: string|null, domainDeleted?: boolean, warning?: string|null }>}
 */
export async function removeApp(appId, { deleteDomain = false, deps = {} } = {}) {
  const app = getApp(appId);
  if (!app) return { ok: false, status: 404, error: `No app named "${appId}".` };

  const d = resolveDeps(deps);
  const lock = acquireLock(appId, { runId: null });
  if (!lock.ok) return { ok: false, status: 409, error: 'A deployment of this app is running. Wait for it to finish.' };

  try {
    await stopProcess(appId, d, { save: true });
  } catch { /* the registry entry is removed regardless */ } finally {
    lock.release();
  }

  // The domain goes first, while the app record still says which one it is. A
  // failure here does not keep the app: the person asked for the app to go.
  let domainDeleted = false;
  let warning = null;
  if (deleteDomain && app.domain) {
    const removed = await d.deleteDomain(app);
    domainDeleted = removed.ok;
    if (!removed.ok) warning = `The app was deleted, but the domain ${app.domain} was not: ${removed.error}`;
  }

  deleteApp(appId);
  return { ok: true, status: 200, error: null, domainDeleted, warning };
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

  await d.runner.del(name, { run: d.run, pm2Path });
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
    fs.renameSync(from, to);
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
    const config = path.join(releaseDir(appId, state.current), PM2_CONFIG_FILE);
    if (!fs.existsSync(config)) return false;
    const started = await d.runner.startConfig(config, { run: d.run, pm2Path });
    if (started.ok) await d.runner.save({ run: d.run, pm2Path });
    return started.ok;
  };

  try {
    ({ pm2Path, wasRunning } = await stopProcess(appId, d));

    // An empty folder left by an earlier attempt would make the rename fail.
    if (fs.existsSync(to)) fs.rmdirSync(to);

    try {
      if (fs.existsSync(from)) moveDirectory(from, to);
      else fs.mkdirSync(to, { recursive: true });
    } catch (err) {
      // Nothing was recorded, so the app is still where it was. Put it back up.
      if (wasRunning) await startCurrent();
      return { ok: false, status: 500, error: `The folder could not be moved: ${err.message}` };
    }

    setAppDir(appId, to);

    // The lock file travelled with the folder; it is ours, and the old path it
    // was taken at no longer exists for release() to clean up.
    try { fs.rmSync(pathsIn(to).lock, { force: true }); } catch { /* ignore */ }

    // Each release's PM2 config names its own absolute path.
    for (const id of listReleases(appId)) {
      const dir = releaseDir(appId, id);
      const file = path.join(dir, PM2_CONFIG_FILE);
      try {
        const config = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const entry of config.apps ?? []) entry.cwd = dir;
        fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
      } catch { /* a release that never started has no config */ }
    }

    let restarted = false;
    let warning = null;
    if (wasRunning) {
      restarted = await startCurrent();
      if (!restarted) warning = 'The app was moved, but PM2 could not start it again. Deploy it, or start it from the Processes page.';
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
