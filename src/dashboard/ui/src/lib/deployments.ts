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
  DeploySettings,
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

/** A command override as the single line the form edits. */
export function commandsToText(value: DeployCommands | undefined): string {
  if (value === undefined || value === false) return '';
  return Array.isArray(value) ? value.join(' && ') : value;
}

export interface SettingsDraft {
  install: string;
  build: string;
  migrate: string;
  start: string;
  port: string;
  healthPath: string;
  persist: string[];
  skipInstall: boolean;
  skipBuild: boolean;
  execMode: DeployExecMode;
  instances: string;
  /** True when the value is saved as an override; false leaves ez.json in charge. */
  migrateOverride: boolean;
  migrateOff: boolean;
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
    install: commandsToText(settings.install),
    build: commandsToText(settings.build),
    migrate: commandsToText(settings.migrate),
    start: settings.start ?? '',
    port: settings.port ? String(settings.port) : '',
    healthPath: settings.healthPath ?? '',
    persist: Array.isArray(settings.persist)
      ? [...settings.persist]
      : settings.persist
        ? [settings.persist]
        : [],
    skipInstall: settings.install === false || (Array.isArray(settings.install) && settings.install.length === 0),
    skipBuild: settings.build === false || (Array.isArray(settings.build) && settings.build.length === 0),
    execMode: settings.execMode ?? effective?.execMode ?? 'fork',
    instances: settings.instances !== undefined
      ? String(settings.instances)
      : effective?.instances !== undefined
        ? String(effective.instances)
        : '',
    migrateOverride: settings.migrate !== undefined,
    migrateOff: settings.migrate === false,
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
  if (draft.skipInstall) settings.install = false;
  else if (draft.install.trim()) settings.install = draft.install.trim();
  if (draft.skipBuild) settings.build = false;
  else if (draft.build.trim()) settings.build = draft.build.trim();
  if (draft.migrateOverride) {
    if (draft.migrateOff) settings.migrate = false;
    else if (draft.migrate.trim()) settings.migrate = draft.migrate.trim();
  }
  if (draft.start.trim()) settings.start = draft.start.trim();
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

const STEP_LABELS: Record<string, string> = {
  fetch: 'Fetching the code',
  settings: 'Reading project settings',
  pre: 'Pre-deploy hook',
  install: 'Installing',
  build: 'Building',
  migrate: 'Running migrations',
  start: 'Starting',
  health: 'Health check',
  post: 'Post-deploy hook',
  finish: 'Finishing',
  done: 'Done',
};

export function stepLabel(step: string): string {
  return STEP_LABELS[step] ?? step;
}

/** The run's step chain, in order (contract §2.8). */
export const RUN_STEPS = [
  'fetch',
  'settings',
  'pre',
  'install',
  'build',
  'migrate',
  'start',
  'health',
  'post',
  'finish',
] as const;

export type RunStepState = 'done' | 'active' | 'failed' | 'pending';

/** Each step's state for a run: before it done, after it pending. */
export function runStepStates(run: DeployRun): Array<{ step: string; state: RunStepState }> {
  const finished = run.status === 'success' || run.step === 'done';
  const failed = run.status === 'failed' || run.status === 'rolled_back';
  const current = RUN_STEPS.indexOf(run.step as (typeof RUN_STEPS)[number]);
  const reached = finished ? RUN_STEPS.length : current === -1 ? 0 : current;

  return RUN_STEPS.map((step, index) => {
    if (finished || index < reached) return { step, state: 'done' as const };
    if (index > reached) return { step, state: 'pending' as const };
    return { step, state: failed ? ('failed' as const) : ('active' as const) };
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

  const file: Record<string, unknown> = {
    install: one(settings.install, 'npm ci'),
    build: one(settings.build, 'npm run build'),
    start: settings.start?.trim() || 'npm start',
    port: settings.port ?? 3000,
    health: settings.healthPath?.trim() || '/',
  };

  const persist = Array.isArray(settings.persist)
    ? settings.persist
    : settings.persist?.trim()
      ? [settings.persist.trim()]
      : [];
  if (persist.length > 0) file.persist = persist;

  const migrate = one(settings.migrate, '');
  if (migrate && migrate !== '') file.migrate = migrate;
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
  { name: 'install', meaning: 'Run first, in a fresh checkout. A command, a list of commands, or false to skip.', without: 'npm ci (yarn and pnpm are detected from the lockfile)' },
  { name: 'build', meaning: 'Run after install. Same forms.', without: 'the "build" script, if package.json has one' },
  { name: 'migrate', meaning: 'Run after build, before the new release starts. Same forms. Forward-only: a rollback does not undo a migration.', without: 'nothing is run' },
  { name: 'start', meaning: 'The long-running process. One command, any language.', without: 'the "start" script, else node <main>' },
  { name: 'execMode', meaning: '"fork" (one process) or "cluster" (one worker per instance). Cluster needs a start command of the form node <file>.', without: '"fork"' },
  { name: 'instances', meaning: 'How many copies to run: a whole number up to the CPU count, or "max".', without: '1' },
  { name: 'port', meaning: 'The port the app listens on. Passed to it as PORT and used for the health check.', without: 'no HTTP check; the process only has to stay up' },
  { name: 'health', meaning: 'A path that must answer before the deployment counts: "/healthz", or { "path": "/healthz", "timeout": 60 }.', without: '"/" with a 60-second limit' },
  { name: 'persist', meaning: 'Folders or single files your app writes to and you need to keep: uploads, SQLite data, logs. A folder is usually the right unit — SQLite creates -wal and -shm files next to its database; list a file only when that file is all there is.', without: 'nothing is kept; each deployment starts from the repository' },
  { name: 'hooks.pre', meaning: 'Run before install — check the environment, fetch something.', without: 'nothing' },
  { name: 'hooks.post', meaning: 'Run once the new release is live — warm a cache, notify someone. A failure is a warning; the release stays.', without: 'nothing' },
];
