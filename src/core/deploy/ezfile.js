/**
 * core/deploy/ezfile.js
 *
 * Works out HOW a project is installed, built, migrated and started.
 *
 * Three sources, in order of precedence:
 *
 *   1. overrides  — values set on the app in the dashboard or the Hub
 *   2. ez.json    — a file in the repository, versioned with the code
 *   3. defaults   — read from package.json, so a plain Node project deploys
 *                   with no configuration at all
 *
 * ez.json is optional. When it gives `steps`, or the older `install`, `build`,
 * `migrate` and `start`, those commands are run exactly as written, whatever the
 * language — which is what lets a Python or Go project deploy before anyone has
 * written auto-detection for it. Detection only ever saves writing the file.
 *
 * Pure: no filesystem, no shell, no config. The engine reads the files and
 * hands their contents in, so every rule here can be tested directly.
 *
 * ── ez.json ──────────────────────────────────────────────────────────────────
 *
 *   {
 *     "steps": [                            at most 5, run in list order
 *       { "run": "npm ci", "kind": "install", "enabled": true },
 *       { "run": "node scripts/build.js", "kind": "build" },
 *       { "run": "npx prisma migrate deploy", "kind": "migrate" },
 *       { "run": "node scripts/seed.js", "kind": "custom" }
 *     ],
 *     "install": "npm ci",                  the old three fields still work
 *     "build":   "npm run build",           string | string[] | false
 *     "migrate": "npx prisma migrate deploy"  string | string[] | false
 *     "start":     "node server.js",        string
 *     "runtime":   "node",                  the runtime; only "node" today
 *     "port":      3000,                    the port the app listens on
 *     "health":    "/healthz",              string, or { "path": "/healthz", "timeout": 60 }
 *     "hooks":     { "pre": "...", "post": "..." }  string | string[]
 *     "persist":   ["data", "upload"],      paths that survive deployments
 *     "instances": 2,                      1..CPU count, or "max"
 *     "execMode":  "cluster"               "fork" (default) | "cluster"
 *   }
 *
 * A persistent path is a folder or a single file.
 *
 * `false` (or an empty string) switches an old command off — "this project has
 * no build" is a real answer, and different from "work it out for me". A
 * skipped old field contributes no step. When `steps` and the old fields are
 * both present, `steps` wins and the old fields are ignored with a warning.
 *
 * ── The order the engine runs them in ────────────────────────────────────────
 *
 *   hooks.pre → steps (in list order) → start → health → hooks.post
 *
 * Every step runs in the NEW release directory, with the app's deploy
 * environment. `migrate` keeps its forward-only hint. A non-zero exit aborts the
 * deployment at that step; the previous release keeps running untouched.
 * Migrations are forward-only: a code rollback cannot undo one that already ran,
 * so keep each migration backward-compatible for one release.
 */

import os from 'os';

/** Where ez.json may live, relative to the repository root, first match wins. */
export const EZ_FILE_LOCATIONS = Object.freeze(['ez.json', 'deploy/ez.json', '.deploy/ez.json']);

export const DEFAULT_HEALTH_PATH = '/';
export const DEFAULT_HEALTH_TIMEOUT_S = 60;
export const MAX_HEALTH_TIMEOUT_S = 600;

export const EXEC_MODES = Object.freeze(['fork', 'cluster']);

export const CLUSTER_STATELESS_WARNING =
  'Cluster mode runs several copies of the app; it must be stateless ' +
  '(no in-memory sessions, sockets, caches or schedulers that assume one process).';

function clusterStartError(start) {
  return `execMode "cluster" needs a Node app started directly, such as "node dist/index.js" or ` +
    `"node server.mjs". "${start}" cannot run in cluster mode — change the start command to "node <file>".`;
}

function forkInstancesError(instances) {
  return `instances is ${instances} but execMode is "fork". Fork mode runs one process, and several ` +
    'copies would all try to bind the same port. Set execMode to "cluster" to run more than one instance.';
}

/**
 * The CPUs this machine offers PM2's cluster mode.
 * os.availableParallelism() respects cgroup/affinity limits where it exists;
 * os.cpus() is the fallback on older Node versions.
 *
 * @returns {number}
 */
export function availableCpuCount() {
  try {
    if (typeof os.availableParallelism === 'function') return Math.max(1, os.availableParallelism());
  } catch { /* fall through */ }
  try {
    return Math.max(1, os.cpus()?.length ?? 1);
  } catch {
    return 1;
  }
}

const COMMAND_FIELDS = Object.freeze(['install', 'build', 'migrate']);

/** Runtimes an app may run on. Only Node today; the list is the extension point. */
export const RUNTIMES = Object.freeze(['node']);

/** What a step does. `custom` has no special handling. */
export const STEP_KINDS = Object.freeze(['install', 'build', 'migrate', 'custom']);

export const MAX_STEPS = 5;

const KNOWN_KEYS = Object.freeze([
  '$schema', 'name', 'install', 'build', 'migrate', 'steps', 'start', 'runtime', 'port', 'health', 'hooks', 'persist',
  'instances', 'execMode',
]);
const MAX_COMMAND_LENGTH = 2000;

export const MAX_PERSIST_PATHS = 20;
const MAX_PERSIST_PATH_LENGTH = 200;

/** @returns {boolean} */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Normalises a command field to a list of command lines.
 *
 * @param {*} value string | string[] | false | null | undefined
 * @returns {{ commands: string[]|null, disabled: boolean, error: string|null }}
 *   `commands: null` with `disabled: false` means "not specified here".
 */
export function normalizeCommands(value) {
  if (value === undefined || value === null) return { commands: null, disabled: false, error: null };
  if (value === false) return { commands: [], disabled: true, error: null };

  const list = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') return { commands: null, disabled: false, error: 'must be a string, a list of strings, or false' };
    const trimmed = item.trim();
    if (trimmed.length > MAX_COMMAND_LENGTH) return { commands: null, disabled: false, error: `is longer than ${MAX_COMMAND_LENGTH} characters` };
    // A newline would let one field smuggle a second command past whoever reviews it.
    if (/[\r\n\0]/.test(trimmed)) return { commands: null, disabled: false, error: 'must be a single line — use a list for several commands' };
    if (trimmed) out.push(trimmed);
  }

  // An empty string or an empty list is the same answer as `false`.
  if (out.length === 0) return { commands: [], disabled: true, error: null };
  return { commands: out, disabled: false, error: null };
}

/**
 * Normalises a `steps` field to the ordered list a deployment runs.
 *
 * A step is `{ run, kind, enabled }`, where `run` is one command line (the
 * same validation as the old install/build/migrate fields), `kind` is one of
 * STEP_KINDS, and `enabled` defaults to true. `false` or `[]` is the explicit
 * "no steps" answer that clears a list from a lower-precedence source;
 * `null`/`undefined` means "not specified here".
 *
 * @param {*} value
 * @returns {{ steps: Array<{run:string,kind:string,enabled:boolean}>|null, error: string|null }}
 */
export function normalizeSteps(value) {
  if (value === undefined || value === null) return { steps: null, error: null };
  if (value === false) return { steps: [], error: null };
  if (!Array.isArray(value)) return { steps: null, error: `must be a list of steps (at most ${MAX_STEPS})` };
  if (value.length > MAX_STEPS) return { steps: null, error: `has more than ${MAX_STEPS} steps` };

  const steps = [];
  for (let i = 0; i < value.length; i++) {
    const raw = value[i];
    const at = `step ${i + 1}`;
    if (!isPlainObject(raw)) {
      return { steps: null, error: `${at} must be an object with "run", "kind" and optionally "enabled"` };
    }

    const command = normalizeCommands(raw.run);
    if (command.error) return { steps: null, error: `${at} "run" ${command.error}` };
    if (command.disabled || command.commands.length !== 1) {
      return { steps: null, error: `${at} "run" must be a single non-empty command` };
    }

    const kind = typeof raw.kind === 'string' ? raw.kind.trim().toLowerCase() : '';
    if (!STEP_KINDS.includes(kind)) {
      return { steps: null, error: `${at} "kind" must be one of: ${STEP_KINDS.join(', ')}` };
    }

    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
      return { steps: null, error: `${at} "enabled" must be true or false` };
    }

    steps.push({ run: command.commands[0], kind, enabled: raw.enabled !== false });
  }

  return { steps, error: null };
}

/**
 * The steps an older app or ez.json describes with install/build/migrate.
 * A skipped field (false or an empty list) contributes no step: the two
 * representations have the same effect, and an omitted step cannot be
 * confused with a disabled one.
 *
 * @param {{install?:string[],build?:string[],migrate?:string[]}} commands
 * @returns {Array<{run:string,kind:string,enabled:boolean}>}
 */
export function stepsFromCommands(commands = {}) {
  const steps = [];
  for (const kind of ['install', 'build', 'migrate']) {
    const commandsForKind = commands[kind];
    if (typeof commandsForKind === 'string' && commandsForKind.trim()) {
      steps.push({ run: commandsForKind.trim(), kind, enabled: true });
      continue;
    }
    for (const run of Array.isArray(commandsForKind) ? commandsForKind : []) {
      steps.push({ run, kind, enabled: true });
    }
  }
  return steps;
}

/**
 * Advisory notes for a list whose order would probably fail. Only enabled
 * steps are considered, and nothing here is an error: a custom step may
 * legitimately put a command between them.
 *
 * @param {Array<{kind:string,enabled?:boolean}>} steps
 * @returns {string[]}
 */
export function stepOrderWarnings(steps = []) {
  const first = {};
  steps.forEach((step, index) => {
    if (step?.enabled === false) return;
    if (!(step?.kind in first)) first[step.kind] = index;
  });

  const warnings = [];
  const before = (a, b, advice) => {
    if (first[a] !== undefined && first[b] !== undefined && first[a] < first[b]) warnings.push(advice);
  };

  before(
    'migrate', 'install',
    `The "migrate" step is listed before "install", but dependencies are not installed yet. Put "install" before "migrate".`,
  );
  before(
    'build', 'install',
    `The "build" step is listed before "install", but dependencies are not installed yet. Put "install" before "build".`,
  );
  before(
    'migrate', 'build',
    `The "migrate" step is listed before "build". Build first, then migrate, so the migration runs against the release that is about to start.`,
  );
  return warnings;
}

/**
 * Validates a `runtime` value.
 * @param {*} value
 * @returns {{ value: string|null, error: string|null }}
 */
export function normalizeRuntime(value) {
  if (value === undefined || value === null || value === '') return { value: null, error: null };
  const runtime = String(value).trim().toLowerCase();
  if (RUNTIMES.includes(runtime)) return { value: runtime, error: null };
  return {
    value: null,
    error: `must be one of: ${RUNTIMES.join(', ')}. Leave it out to use "node".`,
  };
}

/**
 * Validates a port value.
 * @returns {number|null} The port, or null when it is not usable
 */
export function normalizePort(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

/** @returns {string|null} A path starting with `/`, or null when not usable */
export function normalizeHealthPath(value) {
  if (typeof value !== 'string') return null;
  const p = value.trim();
  if (!p.startsWith('/') || p.length > 500 || /[\s\0]/.test(p)) return null;
  return p;
}

/**
 * Validates an `instances` value: a whole number from 1 to the CPU count, or
 * the string "max". A number above the CPU count is refused rather than
 * clamped: the operator asked for something the machine cannot do, and PM2
 * would otherwise silently start fewer workers than the file says.
 *
 * @param {*} value
 * @param {number} [cpu]
 * @returns {{ value: number|'max'|null, error: string|null }}
 */
export function normalizeInstances(value, cpu = availableCpuCount()) {
  if (value === undefined || value === null || value === '') return { value: null, error: null };

  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') return { value: null, error: null };
    if (text.toLowerCase() === 'max') return { value: 'max', error: null };
    const asNumber = Number(text);
    if (!Number.isFinite(asNumber) || !Number.isInteger(asNumber)) {
      return {
        value: null,
        error: `must be a whole number from 1 to ${cpu} (this server has ${cpu} CPU${cpu === 1 ? '' : 's'}), or "max"`,
      };
    }
    return normalizeInstances(asNumber, cpu);
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return {
      value: null,
      error: `must be a whole number from 1 to ${cpu} (this server has ${cpu} CPU${cpu === 1 ? '' : 's'}), or "max"`,
    };
  }
  if (value < 1 || value > cpu) {
    return {
      value: null,
      error: `must be from 1 to ${cpu} — this server has ${cpu} CPU${cpu === 1 ? '' : 's'}. Use "max" for one per CPU`,
    };
  }
  return { value, error: null };
}

/**
 * Validates an `execMode` value.
 * @param {*} value
 * @returns {{ value: 'fork'|'cluster'|null, error: string|null }}
 */
export function normalizeExecMode(value) {
  if (value === undefined || value === null || value === '') return { value: null, error: null };
  const mode = String(value).trim().toLowerCase();
  if (mode === 'fork' || mode === 'cluster') return { value: mode, error: null };
  return {
    value: null,
    error: 'must be "fork" (one process, the default) or "cluster" (one process per instance)',
  };
}

/**
 * The checks that need the resolved start command and both runtime fields.
 *
 * `assumeFork` marks a layer whose omitted execMode really means fork: the
 * app's own settings form. In an ez.json layer an omitted value may still be
 * supplied by an app override, so only an explicit "fork" is judged there.
 *
 * @param {{ start?: string|null, instances?: number|'max'|null, execMode?: string|null, runtime?: string|null }} settings
 * @param {{ assumeFork?: boolean }} [opts]
 * @returns {{ errors: string[], warnings: string[] }}
 */
function runtimeValidation(settings, { assumeFork = false } = {}) {
  const errors = [];
  const warnings = [];

  const mode = settings.execMode ?? (assumeFork ? 'fork' : null);
  const runtime = settings.runtime ?? 'node';
  const instances = settings.instances === 'max'
    ? availableCpuCount()
    : (settings.instances ?? (assumeFork ? 1 : null));

  if (mode === 'cluster') {
    warnings.push(CLUSTER_STATELESS_WARNING);
    if (runtime !== 'node') {
      errors.push(
        `execMode "cluster" is only available for runtime "node". Set runtime to "node", ` +
        `or set execMode to "fork" for runtime "${runtime}".`,
      );
    }
    if (settings.start && parseStartCommand(settings.start).kind !== 'node') {
      errors.push(clusterStartError(settings.start));
    }
  }

  if (instances !== null && instances > 1 && mode === 'fork') {
    errors.push(forkInstancesError(instances));
  }

  return { errors, warnings };
}

/** The advisory strings that belong with a set of (already normalized) settings. */
export function settingsWarnings(settings = {}) {
  const warnings = String(settings?.execMode ?? '').toLowerCase() === 'cluster' ? [CLUSTER_STATELESS_WARNING] : [];
  const steps = Array.isArray(settings?.steps) ? settings.steps : stepsFromCommands(settings);
  for (const warning of stepOrderWarnings(steps)) {
    if (!warnings.includes(warning)) warnings.push(warning);
  }
  return warnings;
}

/**
 * A `persist` path must stay inside the project and name a folder or a file.
 *
 * A folder is usually the right unit: SQLite writes `-wal` and `-shm` next to
 * its database, and an uploads folder gains new names every day. A single file
 * is supported for the case where that really is all there is — one database
 * file beside code that is replaced on every deploy.
 *
 * @returns {string|null} What is wrong with it, or null when it is usable
 */
function persistPathProblem(p) {
  if (p.length > MAX_PERSIST_PATH_LENGTH) return `is longer than ${MAX_PERSIST_PATH_LENGTH} characters`;
  if (/[\0\r\n]/.test(p)) return 'must be a single line';
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return 'must be relative to the project folder, not an absolute path';
  for (const segment of p.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return 'must be a relative path without "." or ".."';
    if (segment === '.git') return 'cannot be ".git" — the deployment manages it';
    if (segment === 'node_modules') return 'cannot be "node_modules" — dependencies are installed fresh for each release';
    if (/[<>:"|?*]/.test(segment)) return 'contains characters that are not allowed in a path name';
  }
  return null;
}

/**
 * Normalises a `persist` field to a list of project-relative paths.
 *
 * Paths are written with "/" on both platforms; the engine turns them into
 * platform paths. Overlapping paths are refused rather than merged, because
 * two links to the same data would look independent and then diverge.
 *
 * @param {*} value string | string[] | false | null | undefined
 * @returns {{ paths: string[]|null, error: string|null }}
 *   `paths: null` means "not specified here"; `[]` means "nothing persistent".
 */
export function normalizePersistPaths(value) {
  if (value === undefined || value === null) return { paths: null, error: null };
  if (value === false) return { paths: [], error: null };

  const list = Array.isArray(value) ? value : [value];
  if (list.length > MAX_PERSIST_PATHS) return { paths: null, error: `has more than ${MAX_PERSIST_PATHS} paths` };

  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') return { paths: null, error: 'must be project paths (folders or files), as a string or a list of strings' };
    const p = item.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
    if (!p) continue;
    const problem = persistPathProblem(p);
    if (problem) return { paths: null, error: `"${item.trim()}" ${problem}` };
    if (!out.includes(p)) out.push(p);
  }

  // Windows and macOS treat these as the same folder; one path cannot be
  // linked twice there, so the pair is refused everywhere.
  for (const a of out) {
    for (const b of out) {
      if (a !== b && b.toLowerCase().startsWith(`${a.toLowerCase()}/`)) {
        return { paths: null, error: `"${a}" and "${b}" overlap — keep only "${a}"` };
      }
    }
  }

  return { paths: out, error: null };
}

/**
 * Parses and validates the contents of an ez.json file.
 *
 * Errors make the file unusable and stop the deployment: silently ignoring a
 * mistyped `port` would deploy something the author did not ask for. Unknown
 * keys are only warnings — a newer ez.json should still deploy on an older
 * Easy DevOps.
 *
 * @param {string} text The file's raw contents
 * @returns {{ ok: boolean, value: Object|null, errors: string[], warnings: string[] }}
 */
export function parseEzFile(text) {
  const errors = [];
  const warnings = [];

  let raw;
  try {
    raw = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch (err) {
    return { ok: false, value: null, errors: [`ez.json is not valid JSON: ${err.message}`], warnings };
  }
  if (!isPlainObject(raw)) {
    return { ok: false, value: null, errors: ['ez.json must contain a JSON object'], warnings };
  }

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.includes(key)) warnings.push(`ez.json: unknown key "${key}" was ignored`);
  }

  const value = {};

  for (const field of COMMAND_FIELDS) {
    const n = normalizeCommands(raw[field]);
    if (n.error) errors.push(`ez.json: "${field}" ${n.error}`);
    else if (n.commands !== null) value[field] = n.commands;
  }

  if (raw.steps !== undefined && raw.steps !== null) {
    const n = normalizeSteps(raw.steps);
    if (n.error) errors.push(`ez.json: "steps" ${n.error}`);
    else {
      value.steps = n.steps;
      if (COMMAND_FIELDS.some((field) => raw[field] !== undefined && raw[field] !== null)) {
        warnings.push('ez.json: "steps" is set, so "install", "build" and "migrate" were ignored.');
        for (const field of COMMAND_FIELDS) delete value[field];
      }
    }
  }

  if (raw.start !== undefined && raw.start !== null) {
    const n = normalizeCommands(raw.start);
    if (n.error) errors.push(`ez.json: "start" ${n.error}`);
    else if (n.commands.length > 1) errors.push('ez.json: "start" must be a single command — it is the long-running process');
    else if (n.commands.length === 1) value.start = n.commands[0];
    else errors.push('ez.json: "start" cannot be empty or false — a deployment needs something to run');
  }

  if (raw.port !== undefined && raw.port !== null) {
    const port = normalizePort(raw.port);
    if (port === null) errors.push('ez.json: "port" must be a whole number from 1 to 65535');
    else value.port = port;
  }

  if (raw.health !== undefined && raw.health !== null) {
    const h = typeof raw.health === 'string' ? { path: raw.health } : raw.health;
    if (!isPlainObject(h)) {
      errors.push('ez.json: "health" must be a path like "/healthz" or an object with "path"');
    } else {
      if (h.path !== undefined) {
        const p = normalizeHealthPath(h.path);
        if (p === null) errors.push('ez.json: "health.path" must start with "/" and contain no spaces');
        else value.healthPath = p;
      }
      if (h.timeout !== undefined) {
        const t = Number(h.timeout);
        if (!Number.isInteger(t) || t < 1 || t > MAX_HEALTH_TIMEOUT_S) {
          errors.push(`ez.json: "health.timeout" must be a whole number of seconds from 1 to ${MAX_HEALTH_TIMEOUT_S}`);
        } else {
          value.healthTimeout = t;
        }
      }
    }
  }

  if (raw.hooks !== undefined && raw.hooks !== null) {
    if (!isPlainObject(raw.hooks)) {
      errors.push('ez.json: "hooks" must be an object with "pre" and/or "post"');
    } else {
      for (const key of Object.keys(raw.hooks)) {
        if (key !== 'pre' && key !== 'post') warnings.push(`ez.json: unknown hook "${key}" was ignored`);
      }
      for (const hook of ['pre', 'post']) {
        const n = normalizeCommands(raw.hooks[hook]);
        if (n.error) errors.push(`ez.json: "hooks.${hook}" ${n.error}`);
        else if (n.commands !== null) value[hook] = n.commands;
      }
    }
  }

  if (raw.persist !== undefined && raw.persist !== null) {
    const n = normalizePersistPaths(raw.persist);
    if (n.error) errors.push(`ez.json: "persist" ${n.error}`);
    else if (n.paths !== null) value.persist = n.paths;
  }

  if (raw.instances !== undefined && raw.instances !== null) {
    const n = normalizeInstances(raw.instances);
    if (n.error) errors.push(`ez.json: "instances" ${n.error}`);
    else if (n.value !== null) value.instances = n.value;
  }

  if (raw.execMode !== undefined && raw.execMode !== null) {
    const n = normalizeExecMode(raw.execMode);
    if (n.error) errors.push(`ez.json: "execMode" ${n.error}`);
    else if (n.value !== null) value.execMode = n.value;
  }

  if (raw.runtime !== undefined && raw.runtime !== null) {
    const n = normalizeRuntime(raw.runtime);
    if (n.error) errors.push(`ez.json: "runtime" ${n.error}`);
    else if (n.value !== null) value.runtime = n.value;
  }

  const runtime = runtimeValidation({
    start: value.start ?? null,
    instances: value.instances ?? null,
    execMode: value.execMode ?? null,
    runtime: value.runtime ?? (raw.runtime ? String(raw.runtime) : null),
  });
  errors.push(...runtime.errors);
  warnings.push(...runtime.warnings);
  for (const warning of stepOrderWarnings(value.steps ?? stepsFromCommands(value))) {
    if (!warnings.includes(warning)) warnings.push(warning);
  }

  return { ok: errors.length === 0, value: errors.length === 0 ? value : null, errors, warnings };
}

/**
 * Defaults for a Node project, read from its package.json.
 *
 * @param {Object|null} pkg Parsed package.json, or null when there is none
 * @param {{ packageLock?: boolean, yarnLock?: boolean, pnpmLock?: boolean }} [files] Lockfiles present
 * @returns {{ install?: string[], build?: string[], start?: string }}
 */
export function defaultsFromPackageJson(pkg, files = {}) {
  if (!isPlainObject(pkg)) return {};

  const out = {};
  const scripts = isPlainObject(pkg.scripts) ? pkg.scripts : {};

  // The lockfile decides the tool, and `ci`-style installs are used when one
  // exists: a deployment should build what was committed, not re-resolve.
  if (files.pnpmLock) out.install = ['pnpm install --frozen-lockfile'];
  else if (files.yarnLock) out.install = ['yarn install --frozen-lockfile'];
  else if (files.packageLock) out.install = ['npm ci'];
  else out.install = ['npm install'];

  const runner = files.pnpmLock ? 'pnpm' : files.yarnLock ? 'yarn' : 'npm';

  if (typeof scripts.build === 'string' && scripts.build.trim()) out.build = [`${runner} run build`];

  if (typeof scripts.start === 'string' && scripts.start.trim()) {
    out.start = runner === 'npm' ? 'npm start' : `${runner} start`;
  } else if (typeof pkg.main === 'string' && pkg.main.trim()) {
    out.start = `node ${pkg.main.trim()}`;
  }

  return out;
}

/**
 * Validates the per-app overrides set in the dashboard or the Hub.
 *
 * Same shape as a parsed ez.json (`install`, `build`, `migrate`, `start`,
 * `port`, `healthPath`, `healthTimeout`, `pre`, `post`, `persist`). An absent,
 * null or empty field means "do not override", so a form with untouched inputs
 * overrides nothing. `false` for install/build/migrate/pre/post switches that
 * step off; `[]` or `false` for persist means "nothing persistent", overriding
 * ez.json.
 *
 * @param {*} input
 * @returns {{ ok: boolean, value: Object, errors: string[], warnings: string[] }}
 */
export function normalizeOverrides(input) {
  const errors = [];
  const warnings = [];
  const value = {};
  if (input === undefined || input === null) return { ok: true, value, errors, warnings };
  if (!isPlainObject(input)) return { ok: false, value, errors: ['settings must be an object'], warnings };

  const stepsPresent = input.steps !== undefined && input.steps !== null && input.steps !== '';
  const legacyPresent = COMMAND_FIELDS.some((field) => input[field] !== undefined && input[field] !== null);

  if (stepsPresent) {
    const n = normalizeSteps(input.steps);
    if (n.error) errors.push(`steps ${n.error}`);
    else {
      value.steps = n.steps;
      if (legacyPresent) warnings.push('"steps" is set, so "install", "build" and "migrate" were ignored.');
    }
  } else {
    for (const field of COMMAND_FIELDS) {
      const raw = input[field];
      if (raw === undefined || raw === null || raw === '') continue;
      const n = normalizeCommands(raw);
      if (n.error) errors.push(`${field} ${n.error}`);
      else if (n.commands !== null) value[field] = n.commands;
    }
  }

  for (const field of ['pre', 'post']) {
    const raw = input[field];
    if (raw === undefined || raw === null || raw === '') continue;
    const n = normalizeCommands(raw);
    if (n.error) errors.push(`${field} ${n.error}`);
    else if (n.commands !== null) value[field] = n.commands;
  }

  if (input.start !== undefined && input.start !== null && input.start !== '') {
    const n = normalizeCommands(input.start);
    if (n.error) errors.push(`start ${n.error}`);
    else if (n.commands.length !== 1) errors.push('start must be a single command');
    else value.start = n.commands[0];
  }

  if (input.port !== undefined && input.port !== null && input.port !== '') {
    const port = normalizePort(input.port);
    if (port === null) errors.push('port must be a whole number from 1 to 65535');
    else value.port = port;
  }

  if (input.healthPath !== undefined && input.healthPath !== null && input.healthPath !== '') {
    const p = normalizeHealthPath(input.healthPath);
    if (p === null) errors.push('healthPath must start with "/" and contain no spaces');
    else value.healthPath = p;
  }

  if (input.healthTimeout !== undefined && input.healthTimeout !== null && input.healthTimeout !== '') {
    const t = Number(input.healthTimeout);
    if (!Number.isInteger(t) || t < 1 || t > MAX_HEALTH_TIMEOUT_S) {
      errors.push(`healthTimeout must be a whole number of seconds from 1 to ${MAX_HEALTH_TIMEOUT_S}`);
    } else {
      value.healthTimeout = t;
    }
  }

  if (input.persist !== undefined && input.persist !== null && input.persist !== '') {
    const n = normalizePersistPaths(input.persist);
    if (n.error) errors.push(`persist ${n.error}`);
    else if (n.paths !== null) value.persist = n.paths;
  }

  if (input.instances !== undefined && input.instances !== null && input.instances !== '') {
    const n = normalizeInstances(input.instances);
    if (n.error) errors.push(`instances ${n.error}`);
    else if (n.value !== null) value.instances = n.value;
  }

  if (input.execMode !== undefined && input.execMode !== null && input.execMode !== '') {
    const n = normalizeExecMode(input.execMode);
    if (n.error) errors.push(`execMode ${n.error}`);
    else if (n.value !== null) value.execMode = n.value;
  }

  if (input.runtime !== undefined && input.runtime !== null && input.runtime !== '') {
    const n = normalizeRuntime(input.runtime);
    if (n.error) errors.push(`runtime ${n.error}`);
    else if (n.value !== null) value.runtime = n.value;
  }

  const runtime = runtimeValidation({
    start: value.start ?? null,
    instances: value.instances ?? null,
    execMode: value.execMode ?? null,
    runtime: value.runtime ?? (input.runtime !== undefined && input.runtime !== null && input.runtime !== ''
      ? String(input.runtime)
      : null),
  }, { assumeFork: true });
  errors.push(...runtime.errors);
  warnings.push(...runtime.warnings);
  for (const warning of stepOrderWarnings(value.steps ?? stepsFromCommands(value))) {
    if (!warnings.includes(warning)) warnings.push(warning);
  }

  return { ok: errors.length === 0, value, errors, warnings };
}

/**
 * Merges the three sources into the settings a deployment actually runs with.
 *
 * `sources` records where each value came from, so the UI can show "from
 * ez.json" next to a command instead of leaving the operator to guess which
 * of three places to edit.
 *
 * @param {Object} input
 * @param {Object|null} [input.ez] Value from parseEzFile(), or null
 * @param {Object|null} [input.pkg] Parsed package.json, or null
 * @param {Object} [input.files] Lockfiles present, see defaultsFromPackageJson()
 * @param {Object} [input.overrides] Value from normalizeOverrides()
 * @returns {{
 *   ok: boolean, error: string|null,
 *   settings: { install: string[], build: string[], migrate: string[], steps: Array<Object>, start: string|null,
 *               runtime: string, port: number|null,
 *               healthPath: string, healthTimeout: number, pre: string[], post: string[],
 *               persist: string[], instances: number|'max', execMode: 'fork'|'cluster' },
 *   sources: Object<string, 'override'|'ez.json'|'package.json'|'default'>,
 *   warnings: string[]
 * }}
 */
export function resolveSettings({ ez = null, pkg = null, files = {}, overrides = {} } = {}) {
  const defaults = defaultsFromPackageJson(pkg, files);
  const layers = [
    ['override', overrides ?? {}],
    ['ez.json', ez ?? {}],
    ['package.json', defaults],
  ];

  const sources = {};
  const pick = (field, fallback) => {
    for (const [name, layer] of layers) {
      if (layer[field] !== undefined && layer[field] !== null) {
        sources[field] = name;
        return layer[field];
      }
    }
    sources[field] = 'default';
    return fallback;
  };

  const settings = {
    install: pick('install', []),
    build: pick('build', []),
    migrate: pick('migrate', []),
    start: pick('start', null),
    runtime: pick('runtime', 'node'),
    port: pick('port', null),
    healthPath: pick('healthPath', DEFAULT_HEALTH_PATH),
    healthTimeout: pick('healthTimeout', DEFAULT_HEALTH_TIMEOUT_S),
    pre: pick('pre', []),
    post: pick('post', []),
    persist: pick('persist', []),
    instances: pick('instances', 1),
    execMode: pick('execMode', 'fork'),
  };

  // `steps` is one field: the first layer that states it wins whole. When no
  // layer does, the old install/build/migrate fields are read as the same
  // list, so an existing app or ez.json deploys exactly as before.
  //
  // A higher layer can still be an older app whose stored settings use the old
  // fields. App settings must keep winning: when a layer above the one that
  // states `steps` has any old command fields, those become the list and the
  // lower `steps` are not used.
  const precedenceWarnings = [];
  const explicitIndex = layers.findIndex(([, layer]) => layer.steps !== undefined && layer.steps !== null);
  const higherWithLegacy = explicitIndex > 0
    ? layers.slice(0, explicitIndex).find(([, layer]) => COMMAND_FIELDS.some(
      (field) => layer[field] !== undefined && layer[field] !== null,
    ))
    : null;

  if (explicitIndex !== -1 && higherWithLegacy) {
    const higherLayers = layers.slice(0, explicitIndex);
    const higherCommands = {};
    const higherSources = {};
    for (const field of COMMAND_FIELDS) {
      const found = higherLayers.find(([, layer]) => layer[field] !== undefined && layer[field] !== null);
      higherCommands[field] = found ? found[1][field] : [];
      higherSources[field] = found ? found[0] : 'default';
    }

    settings.steps = stepsFromCommands(higherCommands);
    sources.steps = higherWithLegacy[0];
    for (const field of COMMAND_FIELDS) {
      settings[field] = settings.steps.filter((s) => s.enabled !== false && s.kind === field).map((s) => s.run);
      sources[field] = higherSources[field];
    }

    const stepsLayer = layers[explicitIndex][0];
    const higherName = higherWithLegacy[0] === 'override' ? "The app's" : `The "${higherWithLegacy[0]}"`;
    precedenceWarnings.push(
      `${higherName} install/build/migrate settings override the "steps" in ${stepsLayer}. ` +
      `Save the app's commands as steps to make this explicit.`,
    );
  } else if (explicitIndex !== -1) {
    settings.steps = layers[explicitIndex][1].steps;
    sources.steps = layers[explicitIndex][0];
    // Keep the legacy fields meaningful for older readers and the run log.
    // They are informational only: the engine runs settings.steps.
    for (const field of COMMAND_FIELDS) {
      settings[field] = settings.steps.filter((s) => s.enabled !== false && s.kind === field).map((s) => s.run);
      sources[field] = sources.steps;
    }
  } else {
    settings.steps = stepsFromCommands(settings);
    const legacyLayer = layers.find(([, layer]) => COMMAND_FIELDS.some(
      (field) => layer[field] !== undefined && layer[field] !== null,
    ));
    sources.steps = legacyLayer ? legacyLayer[0] : 'default';
  }

  if (!settings.start) {
    return {
      ok: false,
      error:
        'Nothing to start. Add a "start" command to ez.json, set one on the app, ' +
        'or give package.json a "start" script or a "main" file.',
      settings,
      sources,
      warnings: [...new Set([...settingsWarnings(settings), ...precedenceWarnings])],
    };
  }

  const runtime = runtimeValidation(settings, { assumeFork: true });
  const warnings = [...runtime.warnings];
  for (const warning of [...stepOrderWarnings(settings.steps), ...precedenceWarnings]) {
    if (!warnings.includes(warning)) warnings.push(warning);
  }
  if (runtime.errors.length > 0) {
    return { ok: false, error: runtime.errors.join(' '), settings, sources, warnings };
  }

  return { ok: true, error: null, settings, sources, warnings };
}

/**
 * Splits a start command into what PM2 needs.
 *
 * `node <file> [args]` is run by PM2 directly, so PM2 watches the real process.
 * Anything else — `npm start`, `python app.py`, `./server` — goes through the
 * launcher (core/deploy/launcher.js), because PM2 cannot run a command line,
 * and how to run one differs per platform.
 *
 * @param {string} start
 * @returns {{ kind: 'node', script: string, args: string[] } | { kind: 'command', command: string }}
 */
export function parseStartCommand(start) {
  const cmd = String(start ?? '').trim();
  // Only the simplest form is taken apart. Quotes, environment prefixes,
  // `&&`, pipes or node flags all mean "this is a command line": run it as one.
  const m = /^node\s+([A-Za-z0-9_@./\\-]+)((?:\s+[A-Za-z0-9_@./\\=:,-]+)*)\s*$/.exec(cmd);
  if (m && !m[1].startsWith('-')) {
    const args = m[2].trim() ? m[2].trim().split(/\s+/) : [];
    return { kind: 'node', script: m[1], args };
  }
  return { kind: 'command', command: cmd };
}
