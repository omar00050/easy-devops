/**
 * lib/mock/deployments.ts — the Deployments API for `npm run dev:mock`.
 *
 * Mirrors docs/api-contract.md §2.8 closely enough to exercise every state the
 * page has: an app that is live, one whose last deployment was rolled back,
 * one that has never been deployed, and a deployment that actually progresses
 * through its steps while it is being watched.
 *
 * State is in memory and not persisted: unlike the rest of the mock it is
 * driven by the clock (a run finishes a few seconds after it starts), and a
 * half-finished run restored from sessionStorage would only be confusing.
 */

import { ApiError } from '../errors';
import type {
  DeployApp,
  DeployAppDetail,
  DeployHook,
  DeployRelease,
  DeployRun,
  DeploymentsResponse,
} from '../types';
import type { HttpMethod } from '../api';

interface MockApp extends DeployApp {
  runs: Array<DeployRun & { log: string }>;
  releases: DeployRelease[];
}

const STEPS = ['fetch', 'settings', 'install', 'build', 'start', 'health', 'finish'] as const;
const STEP_MS = 1100;

const STEP_OUTPUT: Record<string, string> = {
  fetch: '$ git fetch --depth 1 origin main\n          From github.com:acme/project\n',
  settings: 'no ez.json — using package.json defaults\n  install    npm ci   [package.json]\n  build      npm run build   [package.json]\n  start      npm start   [package.json]\n',
  install: '$ npm ci\n          added 412 packages in 9s\n',
  build: '$ npm run build\n          vite v6.3.5 building for production...\n          ✓ built in 4.31s\n',
  start: '$ pm2 delete ez-app; pm2 start ez.pm2.json\n',
  health: 'GET / on port 3000 answered 200.\n',
  finish: 'Deployment succeeded.\n',
};

function id(offsetMs = 0): string {
  const d = new Date(Date.now() - offsetMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return `${stamp}-${Math.random().toString(16).slice(2, 8).padEnd(6, '0')}`;
}

function sha(): string {
  return Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

function finishedRun(appId: string, ageMs: number, status: DeployRun['status'], extra: Partial<DeployRun> = {}): DeployRun & { log: string } {
  const runId = id(ageMs);
  const startedAt = Date.now() - ageMs;
  return {
    id: runId,
    appId,
    trigger: 'webhook',
    actor: 'deploy hook',
    ref: 'main',
    sha: sha(),
    releaseId: runId,
    status,
    step: status === 'success' ? 'done' : 'health',
    startedAt,
    finishedAt: startedAt + 42_000,
    error: null,
    warnings: [],
    rolledBackTo: null,
    log: STEPS.map((s) => `── ${s}\n${STEP_OUTPUT[s]}`).join('\n'),
    ...extra,
  };
}

function baseApp(appId: string, overrides: Partial<MockApp>): MockApp {
  return {
    id: appId,
    pm2Name: `ez-${appId}`,
    repoUrl: `https://github.com/acme/${appId}.git`,
    branch: 'main',
    authType: 'none',
    hasToken: false,
    deployKey: null,
    settings: {},
    env: {},
    keepReleases: 5,
    autoRollback: true,
    notifyChannelIds: [],
    dir: `/home/ops/.config/easy-devops/ez_deploys/${appId}`,
    sharedDir: `/home/ops/.config/easy-devops/ez_deploys/${appId}/shared`,
    hasSharedData: false,
    domain: null,
    hook: { hasToken: false, tokenHint: null, createdAt: null },
    createdAt: new Date(Date.now() - 20 * 86_400_000).toISOString(),
    updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
    runs: [],
    releases: [],
    ...overrides,
  };
}

function seed(): { apps: MockApp[]; hook: DeployHook } {
  const apiRuns = [
    finishedRun('storefront-api', 3 * 3_600_000, 'success'),
    finishedRun('storefront-api', 2 * 86_400_000, 'success', { trigger: 'manual', actor: 'dashboard' }),
    finishedRun('storefront-api', 5 * 86_400_000, 'failed', {
      step: 'build',
      error: 'Build failed: "npm run build" — exit code 1',
    }),
  ];
  const workerRuns = [
    finishedRun('mail-worker', 40 * 60_000, 'rolled_back', {
      error: 'No healthy response from GET /healthz on port 4100 within 60s (no answer (ECONNREFUSED)).',
    }),
    finishedRun('mail-worker', 6 * 86_400_000, 'success'),
  ];
  workerRuns[0].rolledBackTo = workerRuns[1].releaseId;

  return {
    hook: { enabled: true, port: 6445, bind: '127.0.0.1', domain: 'app.example.com', listening: true, path: '/.ez-deploy/' },
    apps: [
      baseApp('storefront-api', {
        repoUrl: 'git@github.com:acme/storefront-api.git',
        authType: 'deployKey',
        deployKey: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQC7mockmockmockmockmockmockmockmock easy-devops-deploy-storefront-api',
        settings: { port: 3000, healthPath: '/healthz', persist: ['uploads', 'data'] },
        hasSharedData: true,
        domain: 'api.example.com',
        env: { DATABASE_URL: 'postgres://app:secret@127.0.0.1:5432/store', NODE_ENV: 'production' },
        hook: { hasToken: true, tokenHint: 'x9Qz', createdAt: new Date(Date.now() - 12 * 86_400_000).toISOString() },
        runs: apiRuns,
        releases: [
          { id: apiRuns[0].releaseId, sha: apiRuns[0].sha, ref: 'main', startable: true, current: true, previous: false },
          { id: apiRuns[1].releaseId, sha: apiRuns[1].sha, ref: 'main', startable: true, current: false, previous: true },
          { id: apiRuns[2].releaseId, sha: apiRuns[2].sha, ref: 'main', startable: false, current: false, previous: false },
        ],
      }),
      baseApp('mail-worker', {
        authType: 'token',
        hasToken: true,
        settings: { port: 4100, healthPath: '/healthz', start: 'python worker.py' },
        runs: workerRuns,
        releases: [
          { id: workerRuns[1].releaseId, sha: workerRuns[1].sha, ref: 'main', startable: true, current: true, previous: false },
        ],
      }),
      baseApp('landing', { branch: 'production' }),
    ],
  };
}

let state: { apps: MockApp[]; hook: DeployHook } | null = null;

function getState() {
  if (!state) state = seed();
  return state;
}

function fail(status: number, error: string, extra: Record<string, unknown> = {}): never {
  throw new ApiError(status, { error, ...extra });
}

/** Advances a running deployment according to the clock. */
function tick(app: MockApp): void {
  const run = app.runs[0];
  if (!run || run.status !== 'running') return;

  const index = Math.floor((Date.now() - run.startedAt) / STEP_MS);
  const reached = Math.min(index, STEPS.length - 1);
  run.step = STEPS[reached];
  run.log = STEPS.slice(0, reached + 1).map((s) => `── ${s}\n${STEP_OUTPUT[s]}`).join('\n');

  if (index >= STEPS.length) {
    run.status = 'success';
    run.step = 'done';
    run.finishedAt = Date.now();
    if (run.trigger !== 'rollback') {
      app.releases = [
        { id: run.releaseId, sha: run.sha, ref: run.ref, startable: true, current: true, previous: false },
        ...app.releases.map((r) => ({ ...r, previous: r.current, current: false })),
      ].slice(0, app.keepReleases);
    } else {
      const wasCurrent = app.releases.find((r) => r.current)?.id;
      app.releases = app.releases.map((r) => ({
        ...r, current: r.id === run.releaseId, previous: r.id === wasCurrent,
      }));
    }
  }
}

function listView(app: MockApp): DeployApp {
  tick(app);
  const { runs, releases, ...rest } = app;
  const last = runs[0] ?? null;
  const current = releases.find((r) => r.current) ?? null;
  const { log: _log, ...lastRun } = last ?? ({} as DeployRun & { log: string });
  return {
    ...rest,
    currentRelease: current?.id ?? null,
    previousRelease: releases.find((r) => r.previous)?.id ?? null,
    deploying: last?.status === 'running',
    activeRunId: last?.status === 'running' ? last.id : null,
    lastRun: last ? (lastRun as DeployRun) : null,
    process: current
      ? { status: 'online', pid: 4000 + app.id.length, cpu: 0.4, memoryBytes: 78_000_000 + app.id.length * 1_000_000, uptimeMs: Date.now() - (last?.finishedAt ?? Date.now()), restarts: 0 }
      : null,
  };
}

function hookView(hook: DeployHook): DeployHook {
  const secure = hook.domain !== null;
  return {
    ...hook,
    listening: hook.enabled,
    urlExample: !hook.enabled
      ? null
      : hook.domain
        ? `https://${hook.domain}/.ez-deploy/your-app`
        : hook.bind === '0.0.0.0'
          ? `http://YOUR_SERVER_ADDRESS:${hook.port}/.ez-deploy/your-app`
          : null,
    mode: !hook.enabled ? 'none' : hook.domain ? 'domain' : hook.bind === '0.0.0.0' ? 'direct' : 'none',
    secure: hook.enabled && secure,
    note: !hook.enabled
      ? 'The deploy hook is switched off.'
      : hook.domain
        ? `Reached through ${hook.domain} over HTTPS.`
        : hook.bind === '0.0.0.0'
          ? `Listening directly on port ${hook.port}, over plain HTTP — the deploy token is sent unencrypted.`
          : 'The deploy hook only listens on this machine. Expose it through a domain, or let it listen on all interfaces.',
  };
}

function workflow(app: MockApp): string {
  return [
    `# Deploys "${app.id}" with Easy DevOps on every push to ${app.branch}.`,
    `name: Deploy ${app.id}`,
    '',
    'on:',
    '  push:',
    `    branches: ["${app.branch}"]`,
    '  workflow_dispatch:',
    '',
    'jobs:',
    '  deploy:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: Deploy',
    '        env:',
    '          EZ_DEPLOY_URL: ${{ secrets.EZ_DEPLOY_URL }}',
    '          EZ_DEPLOY_TOKEN: ${{ secrets.EZ_DEPLOY_TOKEN }}',
    '        run: |',
    '          # (the real file polls the server until the deployment finishes)',
    '          curl --fail-with-body -X POST "$EZ_DEPLOY_URL" \\',
    '            -H "Authorization: Bearer $EZ_DEPLOY_TOKEN" \\',
    '            -d "{\\"ref\\":\\"$GITHUB_SHA\\"}"',
    '',
  ].join('\n');
}

function startRun(app: MockApp, trigger: DeployRun['trigger'], releaseId?: string): DeployRun {
  tick(app);
  if (app.runs[0]?.status === 'running') {
    fail(409, 'A deployment of this app is already running.', { runId: app.runs[0].id });
  }
  const runId = id();
  const target = releaseId ? app.releases.find((r) => r.id === releaseId) : null;
  const run: DeployRun & { log: string } = {
    id: runId,
    appId: app.id,
    trigger,
    actor: 'dashboard',
    ref: target?.ref ?? app.branch,
    sha: target?.sha ?? sha(),
    releaseId: releaseId ?? runId,
    status: 'running',
    step: 'fetch',
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    warnings: [],
    rolledBackTo: null,
    log: '',
  };
  app.runs.unshift(run);
  return run;
}

export function handleDeployments(method: HttpMethod, path: string, body: Record<string, unknown>): unknown {
  const s = getState();
  const rest = path.slice('/deployments'.length);

  if (rest === '' && method === 'GET') {
    const response: DeploymentsResponse = {
      apps: s.apps.map(listView),
      hook: hookView(s.hook),
      requirements: { git: true, gitVersion: '2.45.1', pm2: true },
      limits: { keepReleasesDefault: 5, keepReleasesMin: 2, keepReleasesMax: 20 },
      ezFileLocations: ['ez.json', 'deploy/ez.json', '.deploy/ez.json'],
      deployDir: '/home/ops/.config/easy-devops/ez_deploys',
      channels: [
        { id: 'ch-discord', name: 'Ops Discord', type: 'discord' },
        { id: 'ch-telegram', name: 'On-call', type: 'telegram' },
      ],
      domains: [
        { name: 'app.example.com', enabled: true, ssl: true },
        { name: 'api.example.com', enabled: true, ssl: true },
        { name: 'legacy.example.com', enabled: true, ssl: false },
      ],
    };
    return response;
  }

  if (rest === '' && method === 'POST') {
    const appId = String(body.id ?? '').trim();
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(appId)) fail(400, 'The name must be 1–40 characters: lower-case letters, digits and dashes.');
    if (s.apps.some((a) => a.id === appId)) fail(409, `An app named "${appId}" already exists.`);
    if (!String(body.repoUrl ?? '').trim()) fail(400, 'A repository URL is required.');
    const app = baseApp(appId, {
      repoUrl: String(body.repoUrl),
      branch: String(body.branch ?? 'main') || 'main',
      authType: (body.authType as DeployApp['authType']) ?? 'none',
      hasToken: Boolean(body.token),
      settings: (body.settings as DeployApp['settings']) ?? {},
      env: (body.env as Record<string, string>) ?? {},
      keepReleases: Number(body.keepReleases ?? 5),
      autoRollback: body.autoRollback !== false,
      notifyChannelIds: (body.notifyChannelIds as string[]) ?? [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    s.apps.push(app);
    return listView(app);
  }

  if (rest === '/hook' && method === 'GET') return hookView(s.hook);

  if (rest === '/hook' && method === 'PUT') {
    if (body.enabled !== undefined) s.hook.enabled = Boolean(body.enabled);
    if (body.port !== undefined) s.hook.port = Number(body.port);
    if (body.bind !== undefined) s.hook.bind = String(body.bind);
    if (body.domain !== undefined) s.hook.domain = body.domain ? String(body.domain) : null;
    return { ...hookView(s.hook), nginxReloaded: s.hook.domain ? true : null, appliesWithinSeconds: 10 };
  }

  const match = /^\/([^/]+)(?:\/(.+))?$/.exec(rest);
  if (!match) fail(404, `Not found: ${method} ${path}`);
  const app = s.apps.find((a) => a.id === decodeURIComponent(match[1]));
  if (!app) fail(404, `No app named "${match[1]}".`);
  const sub = match[2] ?? '';

  if (sub === '' && method === 'GET') {
    tick(app);
    const detail: DeployAppDetail = {
      ...listView(app),
      runs: app.runs.map(({ log: _log, ...run }) => run),
      releases: app.releases,
    };
    return detail;
  }

  if (sub === '' && method === 'PUT') {
    if (body.repoUrl !== undefined) app.repoUrl = String(body.repoUrl);
    if (body.branch !== undefined) app.branch = String(body.branch) || 'main';
    if (body.authType !== undefined) app.authType = body.authType as DeployApp['authType'];
    if (body.token) app.hasToken = true;
    if (body.settings !== undefined) app.settings = body.settings as DeployApp['settings'];
    if (body.env !== undefined) app.env = body.env as Record<string, string>;
    if (body.keepReleases !== undefined) app.keepReleases = Number(body.keepReleases);
    if (body.autoRollback !== undefined) app.autoRollback = Boolean(body.autoRollback);
    if (body.notifyChannelIds !== undefined) app.notifyChannelIds = body.notifyChannelIds as string[];
    app.updatedAt = new Date().toISOString();
    return listView(app);
  }

  if (sub === '' && method === 'DELETE') {
    const kept = Boolean(
      app.hasSharedData ||
        (Array.isArray(app.settings.persist)
          ? app.settings.persist.length > 0
          : app.settings.persist)
    );
    s.apps = s.apps.filter((a) => a.id !== app.id);
    return {
      deleted: app.id,
      domainDeleted: false,
      warning: null,
      sharedKept: kept,
      sharedPath: kept ? app.sharedDir : undefined,
    };
  }

  if (sub === 'domain' && method === 'PUT') {
    const name = String(body.domain ?? '').trim().toLowerCase();
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name)) fail(400, 'Invalid domain name format');
    if (!app.settings.port) fail(409, 'This app has no port yet. Set its port (or put "port" in ez.json and deploy once), then link the domain.');
    app.domain = name;
    return {
      domain: name,
      created: !['app.example.com', 'api.example.com', 'legacy.example.com'].includes(name),
      port: app.settings.port,
      nginxReloaded: true,
      ssl: body.ssl ? { ok: false, detail: 'DNS problem: NXDOMAIN looking up A for the domain. The domain works over HTTP; issue the certificate from the SSL page once its DNS points here.' } : null,
    };
  }

  if (sub === 'domain' && method === 'DELETE') {
    app.domain = null;
    return { unlinked: true };
  }

  if (sub === 'move' && method === 'POST') {
    const target = String(body.path ?? '').trim();
    if (!/^(\/|[A-Za-z]:[\\/])/.test(target)) fail(400, 'Use an absolute path, such as /srv/ez_deploys or D:\\ez_deploys.');
    const from = app.dir ?? '';
    app.dir = `${target.replace(/[\\/]+$/, '')}/${app.id}`;
    return { from, to: app.dir, restarted: app.releases.some((r) => r.current), warning: null };
  }

  if (sub === 'deploy' && method === 'POST') {
    const run = startRun(app, 'manual');
    return { runId: run.id, status: 'running' };
  }

  if (sub === 'rollback' && method === 'POST') {
    const releaseId = body.releaseId ? String(body.releaseId) : app.releases.find((r) => r.previous)?.id;
    if (!releaseId) fail(409, 'There is no earlier release to roll back to.');
    const run = startRun(app, 'rollback', releaseId);
    return { runId: run.id, status: 'running' };
  }

  const releaseMatch = /^releases\/(.+)$/.exec(sub);
  if (releaseMatch && method === 'DELETE') {
    const releaseId = decodeURIComponent(releaseMatch[1]);
    const release = app.releases.find((r) => r.id === releaseId);
    if (!release) fail(404, 'No such release.');
    if (release.current) fail(409, 'That release is live. Roll back to another release before deleting it.');
    if (release.previous) fail(409, 'That release is the one an automatic rollback would return to. Delete it after the next deployment.');
    app.releases = app.releases.filter((r) => r.id !== releaseId);
    return { deleted: releaseId };
  }

  const runMatch = /^runs\/(.+)$/.exec(sub);
  if (runMatch && method === 'GET') {
    tick(app);
    const run = app.runs.find((r) => r.id === decodeURIComponent(runMatch[1]));
    if (!run) fail(404, 'No such run.');
    return { ...run, logTruncated: false };
  }

  if (sub === 'hook-token' && method === 'POST') {
    const token = `ezd_${Array.from({ length: 43 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'[Math.floor(Math.random() * 56)]).join('')}`;
    app.hook = { hasToken: true, tokenHint: token.slice(-4), createdAt: new Date().toISOString() };
    return { token, tokenHint: token.slice(-4) };
  }

  if (sub === 'hook-token' && method === 'DELETE') {
    app.hook = { hasToken: false, tokenHint: null, createdAt: null };
    return { revoked: true };
  }

  if (sub === 'deploy-key' && method === 'POST') {
    app.deployKey = `ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQD${Math.random().toString(36).slice(2).repeat(6)} easy-devops-deploy-${app.id}`;
    return { publicKey: app.deployKey };
  }

  if (sub === 'github' && method === 'GET') {
    const hook = hookView(s.hook);
    const url = hook.urlExample ? hook.urlExample.replace('your-app', app.id) : null;
    return {
      hookUrl: url,
      hookMode: hook.mode,
      hookSecure: hook.secure,
      hookNote: hook.note,
      hasToken: app.hook.hasToken,
      tokenHint: app.hook.tokenHint,
      workflowPath: `.github/workflows/ez-deploy-${app.id}.yml`,
      workflow: workflow(app),
      secrets: [
        { name: 'EZ_DEPLOY_URL', value: url },
        { name: 'EZ_DEPLOY_TOKEN', value: null },
      ],
      deployKey: app.authType === 'deployKey' ? app.deployKey : null,
      targets: [
        { id: 'hook', label: 'This server’s deploy hook', url, secure: Boolean(hook.secure), note: hook.note ?? '' },
        {
          id: 'hub',
          label: 'Through the Hub',
          url: `https://hub.example.com/api/v1/hooks/deploy/3f6c0d1e-mock/${app.id}`,
          secure: true,
          note: 'Goes through the Hub over HTTPS. This server needs no inbound port.',
          ready: true,
        },
      ],
    };
  }

  if (sub === 'github/apply' && method === 'POST') {
    if (!/github\.com[:/]/.test(app.repoUrl)) fail(400, 'Automatic setup works with github.com repositories only. Use the manual steps.');
    const typed = String(body.token ?? '');
    if (!typed && !(app.authType === 'token' && app.hasToken)) fail(400, 'A GitHub token with write access to the repository is required.');
    app.hook = { hasToken: true, tokenHint: 'a7Kd', createdAt: new Date().toISOString() };
    // A token starting with "ro" plays the part of one that cannot write workflows.
    const readOnly = typed.startsWith('ro');
    const steps = [
      { id: 'secrets', ok: true, detail: 'Stored EZ_DEPLOY_URL and EZ_DEPLOY_TOKEN.' },
      readOnly
        ? { id: 'workflow', ok: false, detail: 'GitHub refused (403: Resource not accessible by personal access token). The token needs “Contents: read and write” and “Workflows: read and write” on this repository.' }
        : { id: 'workflow', ok: true, detail: `Committed .github/workflows/ez-deploy-${app.id}.yml to ${app.branch}. That push starts the first deployment.` },
      ...(app.authType === 'deployKey' ? [{ id: 'deployKey', ok: true, detail: 'Added the deploy key, read-only.' }] : []),
    ];
    return {
      ok: steps.every((s) => s.ok),
      repo: app.repoUrl.replace(/^.*github\.com[:/]/, '').replace(/\.git$/, ''),
      error: null,
      target: body.target === 'hub' ? 'hub' : 'hook',
      deployUrl: `https://app.example.com/.ez-deploy/${app.id}`,
      steps,
    };
  }

  return fail(404, `Not found: ${method} ${path}`);
}
