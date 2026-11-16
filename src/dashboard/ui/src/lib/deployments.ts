/**
 * lib/deployments.ts — small pure helpers for the Deployments page.
 *
 * Kept out of the components so the rules that turn a form into a request
 * body are in one place and can be read without scrolling past JSX.
 */

import type { DeployCommands, DeployRun, DeployRunStatus, DeploySettings } from './types';
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
  start: string;
  port: string;
  healthPath: string;
  skipInstall: boolean;
  skipBuild: boolean;
}

export function toSettingsDraft(settings: DeploySettings): SettingsDraft {
  return {
    install: commandsToText(settings.install),
    build: commandsToText(settings.build),
    start: settings.start ?? '',
    port: settings.port ? String(settings.port) : '',
    healthPath: settings.healthPath ?? '',
    skipInstall: settings.install === false || (Array.isArray(settings.install) && settings.install.length === 0),
    skipBuild: settings.build === false || (Array.isArray(settings.build) && settings.build.length === 0),
  };
}

/** Builds the `settings` override object: empty fields override nothing. */
export function fromSettingsDraft(draft: SettingsDraft): DeploySettings {
  const settings: DeploySettings = {};
  if (draft.skipInstall) settings.install = false;
  else if (draft.install.trim()) settings.install = draft.install.trim();
  if (draft.skipBuild) settings.build = false;
  else if (draft.build.trim()) settings.build = draft.build.trim();
  if (draft.start.trim()) settings.start = draft.start.trim();
  if (draft.port.trim()) settings.port = Number(draft.port);
  if (draft.healthPath.trim()) settings.healthPath = draft.healthPath.trim();
  return settings;
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
  start: 'Starting',
  health: 'Health check',
  post: 'Post-deploy hook',
  finish: 'Finishing',
  done: 'Done',
};

export function stepLabel(step: string): string {
  return STEP_LABELS[step] ?? step;
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
  { name: 'start', meaning: 'The long-running process. One command, any language.', without: 'the "start" script, else node <main>' },
  { name: 'port', meaning: 'The port the app listens on. Passed to it as PORT and used for the health check.', without: 'no HTTP check; the process only has to stay up' },
  { name: 'health', meaning: 'A path that must answer before the deployment counts: "/healthz", or { "path": "/healthz", "timeout": 60 }.', without: '"/" with a 60-second limit' },
  { name: 'hooks.pre', meaning: 'Run before install — check the environment, fetch something.', without: 'nothing' },
  { name: 'hooks.post', meaning: 'Run once the new release is live — warm a cache, notify someone. A failure is a warning; the release stays.', without: 'nothing' },
];
