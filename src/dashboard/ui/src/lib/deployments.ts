/**
 * lib/deployments.ts — small pure helpers for the Deployments page.
 *
 * Kept out of the components so the rules that turn a form into a request
 * body are in one place and can be read without scrolling past JSX.
 */

import type {
  DeployCommands,
  DeployExecMode,
  DeployInstances,
  DeployRun,
  DeployRunStatus,
  DeployRuntime,
  DeploySettings,
  DeployStep,
  DeployStepKind,
} from './types';
import type { Tone } from '../components/ui/Badge';

/** App ids: the same rule the server enforces (core/deploy/apps.js). */
export function validateAppId(id: string): string | null {
  if (!id) return 'A name is required.';
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id) || id.endsWith('-')) {
    return 'Lower-case letters, digits and dashes, up to 40 characters.';
  }
  return null;
}

/** True for a URL git reaches over SSH. */
export function isSshUrl(url: string): boolean {
  return /^ssh:\/\//.test(url) || /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:/.test(url);
}

/**
 * GitHub's "add deploy key" page for a repository URL, or null for any other
 * host. Mirrors `parseGithubRepo` in core/deploy/githubApi.js, so a key panel
 * rebuilt from the app's own fields links to the same page as the server.
 */
export function deployKeyAddUrl(repoUrl: string | null | undefined): string | null {
  if (!repoUrl) return null;
  const https = /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/i.exec(repoUrl.trim());
  const scp = /^[A-Za-z0-9._-]+@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i.exec(repoUrl.trim());
  const ssh = /^ssh:\/\/(?:[A-Za-z0-9._-]+@)?github\.com(?::\d+)?\/([^/]+)\/(.+?)(?:\.git)?$/i.exec(
    repoUrl.trim()
  );
  const match = https ?? scp ?? ssh;
  if (!match) return null;
  return `https://github.com/${match[1]}/${match[2]}/settings/keys/new`;
}

/**
 * Parses the environment editor: one `NAME=value` per line. Blank lines and
 * lines starting with `#` are ignored, so a pasted .env file works as it is.
 */
export function parseEnvText(text: string): { env: Record<string, string>; error: string | null } {
  const env: Record<string, string> = {};
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) return { env, error: `Line ${i + 1}: expected NAME=value.` };

    const name = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      return { env, error: `Line ${i + 1}: "${name}" is not a valid variable name.` };
    }

    let value = line.slice(eq + 1).trim();
    // Matching quotes around the whole value are a .env convention, not part of it.
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    env[name] = value;
  }

  return { env, error: null };
}

export function envToText(env: Record<string, string>): string {
  return Object.keys(env)
    .sort()
    .map((name) => `${name}=${env[name]}`)
    .join('\n');
}

/** A step in the form: the API shape plus a stable key for React and focus. */
export interface StepDraft extends DeployStep {
  key: string;
}

let stepKeySeq = 0;
function nextStepKey(): string {
  stepKeySeq += 1;
  return `step-${stepKeySeq}`;
}

export function toStepDrafts(steps: DeployStep[]): StepDraft[] {
  return steps.map((step) => ({
    key: nextStepKey(),
    run: step.run,
    kind: step.kind,
    enabled: step.enabled !== false,
  }));
}

/** The API shape, with empty rows dropped (the form validates them first). */
export function stepsFromDraft(steps: StepDraft[]): DeployStep[] {
  return steps
    .filter((step) => step.run.trim())
    .map((step) => ({
      run: step.run.trim(),
      kind: step.kind,
      enabled: step.enabled !== false,
    }));
}

/**
 * The steps an app stores: the new list, or the equivalent list from the old
 * install/build/migrate fields. Absent means "read from ez.json".
 */
export function stepsFromSettings(settings: DeploySettings): DeployStep[] {
  if (Array.isArray(settings.steps)) {
    return settings.steps.map((step) => ({
      run: step.run,
      kind: step.kind,
      enabled: step.enabled !== false,
    }));
  }

  const steps: DeployStep[] = [];
  for (const kind of ['install', 'build', 'migrate'] as const) {
    const value = settings[kind];
    if (typeof value === 'string' && value.trim()) {
      steps.push({ run: value.trim(), kind, enabled: true });
      continue;
    }
    for (const run of Array.isArray(value) ? value : []) {
      if (run.trim()) steps.push({ run, kind, enabled: true });
    }
  }
  return steps;
}

/** Whether the app stores any command override, in either format. */
export function hasCommandOverride(settings: DeploySettings): boolean {
  return (
    settings.steps !== undefined ||
    settings.install !== undefined ||
    settings.build !== undefined ||
    settings.migrate !== undefined
  );
}

export const MAX_DEPLOY_STEPS = 5;

export const STEP_KINDS: Array<{ value: DeployStepKind; label: string }> = [
  { value: 'install', label: 'Install' },
  { value: 'build', label: 'Build' },
  { value: 'migrate', label: 'Migrate' },
  { value: 'custom', label: 'Custom' },
];

/**
 * The same advisory checks as `stepOrderWarnings()` on the server
 * (core/deploy/ezfile.js), word for word, so the form can answer before a save.
 * Disabled steps do not count.
 */
export function stepOrderWarnings(steps: Array<{ kind: DeployStepKind; enabled?: boolean }>): string[] {
  const first: Partial<Record<DeployStepKind, number>> = {};
  steps.forEach((step, index) => {
    if (step.enabled === false) return;
    if (first[step.kind] === undefined) first[step.kind] = index;
  });

  const warnings: string[] = [];
  const before = (a: DeployStepKind, b: DeployStepKind, advice: string) => {
    const aAt = first[a];
    const bAt = first[b];
    if (aAt !== undefined && bAt !== undefined && aAt < bAt) warnings.push(advice);
  };

  before(
    'migrate',
    'install',
    'The "migrate" step is listed before "install", but dependencies are not installed yet. Put "install" before "migrate".'
  );
  before(
    'build',
    'install',
    'The "build" step is listed before "install", but dependencies are not installed yet. Put "install" before "build".'
  );
  before(
    'migrate',
    'build',
    'The "migrate" step is listed before "build". Build first, then migrate, so the migration runs against the release that is about to start.'
  );
  return warnings;
}

/** True for a warning that is about the order of the steps. */
export function isStepOrderWarning(warning: string): boolean {
  return warning.startsWith('The "');
}

/** A ready-made command set for a known kind of Node project. */
export interface DeployPreset {
  id: string;
  label: string;
  description: string;
  start: string;
  steps: DeployStep[];
}

export const DEPLOY_PRESETS: DeployPreset[] = [
  {
    id: 'node',
    label: 'Default Node app',
    description: 'npm ci, then npm start',
    start: 'npm start',
    steps: [{ run: 'npm ci', kind: 'install', enabled: true }],
  },
  {
    id: 'next',
    label: 'Next.js',
    description: 'npm ci and npm run build, then npm start',
    start: 'npm start',
    steps: [
      { run: 'npm ci', kind: 'install', enabled: true },
      { run: 'npm run build', kind: 'build', enabled: true },
    ],
  },
  {
    id: 'nest',
    label: 'NestJS',
    description: 'npm ci and npm run build, then node dist/main.js',
    start: 'node dist/main.js',
    steps: [
      { run: 'npm ci', kind: 'install', enabled: true },
      { run: 'npm run build', kind: 'build', enabled: true },
    ],
  },
  {
    id: 'express',
    label: 'Express / Fastify',
    description: 'npm ci, then node server.js',
    start: 'node server.js',
    steps: [{ run: 'npm ci', kind: 'install', enabled: true }],
  },
  {
    id: 'nuxt',
    label: 'Nuxt',
    description: 'npm ci and npm run build, then the Node server',
    start: 'node .output/server/index.mjs',
    steps: [
      { run: 'npm ci', kind: 'install', enabled: true },
      { run: 'npm run build', kind: 'build', enabled: true },
    ],
  },
];

/**
 * A preset's steps, plus the optional ones it offers switched OFF: they appear
 * in the list so they are easy to enable, and the server skips them until then.
 */
export function presetSteps(preset: DeployPreset): DeployStep[] {
  return [
    ...preset.steps,
    { run: 'npm run lint', kind: 'custom', enabled: false },
    { run: 'npx prisma migrate deploy', kind: 'migrate', enabled: false },
  ];
}

export interface SettingsDraft {
  steps: StepDraft[];
  start: string;
  runtime: DeployRuntime;
  port: string;
  healthPath: string;
  persist: string[];
  execMode: DeployExecMode;
  instances: string;
  /** True when the value is saved as an override; false leaves ez.json in charge. */
  stepsOverride: boolean;
  startOverride: boolean;
  runtimeOverride: boolean;
  execModeOverride: boolean;
  instancesOverride: boolean;
}

/**
 * `effective` is what the server reports for a live app (execMode/instances are
 * resolved from the live release, then the settings, then the defaults). It is
 * shown in the form, but only an override that already exists — or a control
 * the user changes — is written back.
 */
export function toSettingsDraft(
  settings: DeploySettings,
  effective?: { execMode?: DeployExecMode; instances?: DeployInstances }
): SettingsDraft {
  return {
    steps: toStepDrafts(stepsFromSettings(settings)),
    start: settings.start ?? '',
    runtime: settings.runtime ?? 'node',
    port: settings.port ? String(settings.port) : '',
    healthPath: settings.healthPath ?? '',
    persist: Array.isArray(settings.persist)
      ? [...settings.persist]
      : settings.persist
        ? [settings.persist]
        : [],
    execMode: settings.execMode ?? effective?.execMode ?? 'fork',
    instances: settings.instances !== undefined
      ? String(settings.instances)
      : effective?.instances !== undefined
        ? String(effective.instances)
        : '',
    stepsOverride: hasCommandOverride(settings),
    startOverride: settings.start !== undefined,
    runtimeOverride: settings.runtime !== undefined,
    execModeOverride: settings.execMode !== undefined,
    instancesOverride: settings.instances !== undefined,
  };
}

/**
 * One persistent path, normalised and checked.
 *
 * The same rules the server enforces (core/deploy/ezfile.js), checked here so
 * a typo is answered before the form is sent: a folder or one file, inside the
 * project.
 */
export function normalizePersistPath(raw: string): { path: string | null; error: string | null } {
  const trimmed = raw.trim();
  const p = trimmed.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (!p) return { path: null, error: 'Enter a folder or file path.' };
  if (p.length > 200) return { path: null, error: `"${trimmed}" is longer than 200 characters.` };
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) {
    return { path: null, error: `"${trimmed}" must be relative to the project folder.` };
  }
  const parts = p.split('/');
  if (parts.some((s) => s === '' || s === '.' || s === '..')) {
    return { path: null, error: `"${trimmed}" must be a relative path without "." or "..".` };
  }
  if (parts.includes('.git')) return { path: null, error: `"${trimmed}" cannot be ".git".` };
  if (parts.includes('node_modules')) return { path: null, error: `"${trimmed}" cannot include node_modules.` };
  if (/[<>:"|?*]/.test(p)) return { path: null, error: `"${trimmed}" contains characters that are not allowed.` };
  return { path: p, error: null };
}

/** Checks one path as it is added to the list: duplicate, count and overlaps. */
export function checkPersistAddition(raw: string, current: string[]): { path: string | null; error: string | null } {
  const normalized = normalizePersistPath(raw);
  if (normalized.error || !normalized.path) return normalized;
  const path = normalized.path;

  if (current.includes(path)) return { path: null, error: `"${path}" is already listed.` };
  if (current.length >= 20) return { path: null, error: 'Use at most 20 paths.' };

  const lower = path.toLowerCase();
  for (const other of current) {
    const otherLower = other.toLowerCase();
    if (otherLower.startsWith(`${lower}/`)) {
      return { path: null, error: `"${path}" contains "${other}" — keep only "${path}".` };
    }
    if (lower.startsWith(`${otherLower}/`)) {
      return { path: null, error: `"${path}" is inside "${other}" — keep only "${other}".` };
    }
  }
  return { path, error: null };
}

/** Builds the `settings` override object: an untouched inherited value is omitted. */
export function fromSettingsDraft(draft: SettingsDraft): DeploySettings {
  const settings: DeploySettings = {};
  if (draft.stepsOverride) settings.steps = stepsFromDraft(draft.steps);
  if (draft.startOverride && draft.start.trim()) settings.start = draft.start.trim();
  if (draft.runtimeOverride) settings.runtime = draft.runtime;
  if (draft.port.trim()) settings.port = Number(draft.port);
  if (draft.healthPath.trim()) settings.healthPath = draft.healthPath.trim();
  if (draft.persist.length > 0) settings.persist = [...draft.persist];
  if (draft.execModeOverride) settings.execMode = draft.execMode;
  if (draft.instancesOverride) {
    const instances = draft.instances.trim();
    if (instances === 'max') settings.instances = 'max';
    else if (instances && Number.isInteger(Number(instances)) && Number(instances) >= 1) {
      settings.instances = Number(instances);
    }
  }
  return settings;
}

/** The stateless warning the server attaches in cluster mode (contract 2.11.0). */
export const CLUSTER_STATELESS_WARNING =
  'Cluster mode runs several copies of the app; it must be stateless (no in-memory sessions, sockets, caches or schedulers that assume one process).';

/**
 * Whether cluster mode can be used with this start command. The server is the
 * authority; this is only the hint that lets the form disable the option.
 * `null` means the start command is not set here and may come from ez.json.
 */
export function isClusterCapable(start: string): boolean | null {
  const value = start.trim();
  if (!value) return null;
  return /^node\s+(?!-)\S+$/.test(value);
}

/** `Cluster · 3/4 online`, or null for a server too old to report the mode. */
export function modeSummary(app: {
  execMode?: DeployExecMode;
  instances?: DeployInstances;
  instancesOnline?: number;
}): string | null {
  if (!app.execMode) return null;
  const mode = app.execMode === 'cluster' ? 'Cluster' : 'Fork';
  const online = app.instancesOnline ?? 0;
  if (app.instances === 'max') return `${mode} · ${online} online (max)`;
  const configured = app.instances ?? 1;
  return `${mode} · ${online}/${configured} online`;
}

export const RUN_STATUS: Record<DeployRunStatus, { label: string; tone: Tone }> = {
  running: { label: 'Deploying', tone: 'info' },
  success: { label: 'Succeeded', tone: 'ok' },
  failed: { label: 'Failed', tone: 'bad' },
  rolled_back: { label: 'Rolled back', tone: 'warn' },
};

/** The done marker is a label, not one of the stages drawn in the bar. */
const DONE_LABEL = 'Done';

export interface RunStage {
  /** The canonical id the agent sends as `stage` (and older agents as `step`). */
  id: string;
  /** The short name in the stage bar: "Install". */
  short: string;
  /** The sentence used wherever the run is labelled: "Installing". */
  label: string;
}

/**
 * The run's stage chain, in order (contract §2.8). The one definition in this
 * app: the Hub keeps the same ids, short names and long labels in
 * `hub_frontend/src/components/servers/deploy/types.ts`.
 */
export const RUN_STAGES: readonly RunStage[] = [
  { id: 'fetch', short: 'Fetch', label: 'Fetching the code' },
  { id: 'settings', short: 'Settings', label: 'Reading project settings' },
  { id: 'pre', short: 'Pre', label: 'Pre-deploy hook' },
  { id: 'install', short: 'Install', label: 'Installing' },
  { id: 'build', short: 'Build', label: 'Building' },
  { id: 'migrate', short: 'Migrate', label: 'Running migrations' },
  { id: 'start', short: 'Start', label: 'Starting' },
  { id: 'health', short: 'Health', label: 'Health check' },
  { id: 'post', short: 'Post', label: 'Post-deploy hook' },
  { id: 'finish', short: 'Finish', label: 'Finishing' },
];

export const RUN_STEPS: string[] = RUN_STAGES.map((stage) => stage.id);

const STAGE_BY_ID = new Map(RUN_STAGES.map((stage) => [stage.id, stage]));

export function stepLabel(step: string): string {
  if (step === 'done') return DONE_LABEL;
  return STAGE_BY_ID.get(step)?.label ?? step;
}

/** The short name shown inside the stage bar. */
export function stageShortName(step: string): string {
  return STAGE_BY_ID.get(step)?.short ?? stepLabel(step);
}

/**
 * The stage a run record points at. New agents send `stage`; older ones only
 * `step`, and a custom step is "step N" there. A record has no history, so an
 * unreadable step keeps the bar at build (where a custom step runs) instead of
 * resetting it to Fetch.
 */
function runStage(run: Pick<DeployRun, 'stage' | 'step'>): string {
  if (run.stage && (STAGE_BY_ID.has(run.stage) || run.stage === 'done')) return run.stage;
  if (run.step === 'done') return 'done';
  if (STAGE_BY_ID.has(run.step)) return run.step;
  return 'build';
}

/** The real stage of a run, for a badge or the line above the stage bar. */
export function runStageLabel(run: Pick<DeployRun, 'stage' | 'step'>): string {
  if (run.stage === 'done') return DONE_LABEL;
  const stage = run.stage ? STAGE_BY_ID.get(run.stage) : undefined;
  if (stage) return stage.label;
  if (run.step === 'done') return DONE_LABEL;
  const custom = /^step\s+(\d+)$/i.exec(run.step.trim());
  if (custom) return `Running step ${custom[1]}`;
  return stepLabel(run.step);
}

export type RunStepState = 'done' | 'active' | 'failed' | 'pending' | 'skipped';

/**
 * Each stage's state for a run. Before the current stage is done, after it is
 * pending; a failed run stops at the current stage. A stage named in
 * `skippedStages` is skipped wherever it sits, and success marks every
 * non-skipped stage done.
 */
export function runStepStates(run: DeployRun): Array<{ step: string; state: RunStepState }> {
  const target = runStage(run);
  const finished = run.status === 'success' || target === 'done';
  const failed = run.status === 'failed' || run.status === 'rolled_back';
  const index = RUN_STEPS.indexOf(target);
  const reached = finished ? RUN_STEPS.length : index === -1 ? RUN_STEPS.indexOf('build') : index;
  const skipped = new Set(run.skippedStages ?? []);

  return RUN_STEPS.map((step, at) => {
    let state: RunStepState;
    if (skipped.has(step)) state = 'skipped';
    else if (finished || at < reached) state = 'done';
    else if (at > reached) state = 'pending';
    else state = failed ? 'failed' : 'active';
    return { step, state };
  });
}

/** One sentence for the automatic-rollback outcome, tri-state as the server sends it. */
export function rollbackOutcome(
  value: boolean | null | undefined
): { tone: 'ok' | 'bad' | 'neutral'; text: string } {
  if (value === true) {
    return {
      tone: 'ok',
      text: 'The new release crashed at boot. The previous release was started again and is serving.',
    };
  }
  if (value === false) {
    return {
      tone: 'bad',
      text: 'The automatic rollback could not verify the previous release. The app may be down — check it on the server.',
    };
  }
  return {
    tone: 'neutral',
    text: 'No automatic rollback was attempted: this was the first release, or automatic rollback is switched off. The failed release was stopped.',
  };
}

export const TRIGGER_LABELS: Record<string, string> = {
  manual: 'Dashboard',
  webhook: 'GitHub Actions',
  hub: 'Hub',
  rollback: 'Rollback',
};

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '—';
}

export function runDuration(run: DeployRun): string {
  const end = run.finishedAt ?? Date.now();
  const seconds = Math.max(0, Math.round((end - run.startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Tone for a PM2 process status. */
export function processTone(status: string | undefined | null): Tone {
  if (status === 'online') return 'ok';
  if (status === 'errored') return 'bad';
  if (status === 'stopped' || status === 'stopping') return 'warn';
  return 'neutral';
}

/**
 * An ez.json for this app, written out from what is set on it.
 *
 * Whatever the app already has is used as-is; the rest is filled with the
 * usual Node commands so the file is a working starting point, not a list of
 * placeholders. It is what the app would deploy with today, moved into the
 * repository.
 */
export function buildEzJson(settings: DeploySettings): string {
  const one = (value: DeployCommands | undefined, fallback: string): string | string[] | false => {
    if (value === false) return false;
    if (Array.isArray(value)) return value.length === 0 ? false : value.length === 1 ? value[0] : value;
    return value && value.trim() ? value : fallback;
  };

  const file: Record<string, unknown> = {};
  if (settings.steps !== undefined) {
    // The new list is one field: write it instead of the old install/build/migrate.
    file.steps = settings.steps.map((step) => ({
      run: step.run,
      kind: step.kind,
      ...(step.enabled === false ? { enabled: false } : {}),
    }));
  } else {
    file.install = one(settings.install, 'npm ci');
    file.build = one(settings.build, 'npm run build');
    const migrate = one(settings.migrate, '');
    if (migrate && migrate !== '') file.migrate = migrate;
  }
  file.start = settings.start?.trim() || 'npm start';
  file.runtime = settings.runtime ?? 'node';
  file.port = settings.port ?? 3000;
  file.health = settings.healthPath?.trim() || '/';

  const persist = Array.isArray(settings.persist)
    ? settings.persist
    : settings.persist?.trim()
      ? [settings.persist.trim()]
      : [];
  if (persist.length > 0) file.persist = persist;

  if (settings.execMode) file.execMode = settings.execMode;
  if (settings.instances !== undefined) file.instances = settings.instances;

  const pre = one(settings.pre, '');
  const post = one(settings.post, '');
  if ((pre && pre !== '') || (post && post !== '')) {
    file.hooks = {
      ...(pre && pre !== '' ? { pre } : {}),
      ...(post && post !== '' ? { post } : {}),
    };
  }

  return `${JSON.stringify(file, null, 2)}\n`;
}

/** A complete example for a project that is not Node, to show the commands are free-form. */
export const EZ_JSON_PYTHON = `${JSON.stringify(
  {
    install: 'pip install -r requirements.txt',
    build: false,
    start: 'python app.py',
    port: 8000,
    health: '/health',
  },
  null,
  2
)}\n`;

export const EZ_JSON_FIELDS: Array<{ name: string; meaning: string; without: string }> = [
  { name: 'steps', meaning: 'An ordered list of at most 5 steps, each { run, kind, enabled? }, where kind is install, build, migrate or custom. One field: it replaces the list below, and [] clears it. Disabled steps are skipped.', without: 'the equivalent install/build/migrate list below' },
  { name: 'runtime', meaning: 'The runtime. "node" is the only one today; cluster mode is Node-only.', without: '"node"' },
  { name: 'install', meaning: 'Old format: a command, a list of commands, or false to skip. Read as an install step.', without: 'npm ci (yarn and pnpm are detected from the lockfile)' },
  { name: 'build', meaning: 'Old format: run after install. Same forms. Read as a build step.', without: 'the "build" script, if package.json has one' },
  { name: 'migrate', meaning: 'Old format: run after build, before the new release starts. Same forms. Forward-only: a rollback does not undo a migration.', without: 'nothing is run' },
  { name: 'start', meaning: 'The long-running process. One command, any language.', without: 'the "start" script, else node <main>' },
  { name: 'execMode', meaning: '"fork" (one process) or "cluster" (one worker per instance). Cluster needs a start command of the form node <file>.', without: '"fork"' },
  { name: 'instances', meaning: 'How many copies to run: a whole number up to the CPU count, or "max".', without: '1' },
  { name: 'port', meaning: 'The port the app listens on. Passed to it as PORT and used for the health check.', without: 'no HTTP check; the process only has to stay up' },
  { name: 'health', meaning: 'A path that must answer before the deployment counts: "/healthz", or { "path": "/healthz", "timeout": 60 }.', without: '"/" with a 60-second limit' },
  { name: 'persist', meaning: 'Folders or single files your app writes to and you need to keep: uploads, SQLite data, logs. A folder is usually the right unit — SQLite creates -wal and -shm files next to its database; list a file only when that file is all there is.', without: 'nothing is kept; each deployment starts from the repository' },
  { name: 'hooks.pre', meaning: 'Run before install — check the environment, fetch something.', without: 'nothing' },
  { name: 'hooks.post', meaning: 'Run once the new release is live — warm a cache, notify someone. A failure is a warning; the release stays.', without: 'nothing' },
];
