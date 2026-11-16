/**
 * core/deploy/hubCommands.js
 *
 * Deployment actions the Hub can request, and the CI trigger the Hub relays.
 *
 * Permission checking happens in core/hub/agent.js before any of this runs
 * (core/hubPermissions.js maps each action to its permission). These
 * functions assume they are allowed and concentrate on two things:
 *
 *   1. doing the work through the same core modules the dashboard uses, so a
 *      deployment started from the Hub is indistinguishable from one started
 *      locally;
 *   2. deciding what may LEAVE the server. Everything returned here uses
 *      publicApp(): environment variable names without values, and no
 *      credentials. The two exceptions are explicit actions with their own
 *      permissions — `getEnv` (deploy.env) and `issueToken` (deploy.manage) —
 *      where the value passes through the Hub once and is not stored there.
 */

import { loadConfig } from '../config.js';
import { getDomains } from '../domains-db.js';
import { getHubLink, getHubPermissions, resolveHubOrigin } from '../hubLink.js';

import {
  getApp, createApp, updateApp, publicApp, normalizeEnv, rotateHookToken, verifyHookToken, validateAppId,
} from './apps.js';
import { startDeployment, startRollback, removeApp, moveApp } from './engine.js';
import { linkDomain, unlinkDomain } from './domainLink.js';
import { findDomain } from '../domains-db.js';
import { describeGithubSetup } from './github.js';
import { hookSettings } from './hookServer.js';
import { describeApps, describeAppDetail } from './status.js';
import { isId, readLogTail, readRun } from './store.js';

/** An error whose message is safe to show the Hub user as-is. */
function refuse(message) {
  return Object.assign(new Error(message), { expected: true });
}

function requireApp(id) {
  const app = typeof id === 'string' ? getApp(id) : null;
  if (!app) throw refuse(`No app named "${id}".`);
  return app;
}

/** The Hub pairing, in the form github.js wants. */
function hubTarget() {
  const link = getHubLink();
  return {
    link: link ? { origin: resolveHubOrigin(link.hubUrl), serverId: link.serverId } : null,
    ciAllowed: getHubPermissions()['deploy.ci'] === true,
  };
}

/** The GitHub setup for an app, including the through-the-Hub URL. Shared with the dashboard. */
export function githubSetupFor(app, view) {
  return describeGithubSetup(view(app), hookSettings(loadConfig()), getDomains(), hubTarget());
}

/**
 * Fields a Hub user may set on an app through create/update.
 *
 * `env` is deliberately absent: environment values have their own permission
 * and their own action, so "may create an app" does not quietly include "may
 * read or replace its secrets".
 */
function appInputFromHub(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const key of ['repoUrl', 'branch', 'authType', 'token', 'settings', 'keepReleases', 'autoRollback', 'notifyChannelIds']) {
    if (src[key] !== undefined) out[key] = src[key];
  }
  return out;
}

/**
 * Handles a hub:manageDeploy command.
 *
 * @param {Object} payload { action, id?, ... }
 * @param {Object} [opts]
 * @param {(run: Object) => void} [opts.onFinished] Called when a deployment or rollback started here ends
 * @returns {Promise<Object>} The command's result data. Throws to refuse.
 */
export async function handleHubDeployCommand(payload, { onFinished = null } = {}) {
  const { action, id } = payload ?? {};
  const watch = (started) => {
    if (onFinished) started.done.then((run) => { try { onFinished(run); } catch { /* ignore */ } });
  };

  switch (action) {
    case 'list':
      return { apps: await describeApps({ view: publicApp }) };

    case 'detail': {
      const detail = await describeAppDetail(String(id ?? ''), { view: publicApp });
      if (!detail) throw refuse(`No app named "${id}".`);
      return detail;
    }

    case 'github': {
      const app = requireApp(id);
      return githubSetupFor(app, publicApp);
    }

    case 'run': {
      const app = requireApp(id);
      const run = isId(payload.runId) ? readRun(app.id, payload.runId) : null;
      if (!run) throw refuse('No such run.');
      // A smaller tail than the dashboard's: this travels over the agent
      // socket and through the Hub to a browser.
      const log = readLogTail(app.id, run.id, { maxBytes: 32 * 1024 });
      return { ...run, log: log.text, logTruncated: log.truncated };
    }

    case 'deploy': {
      const app = requireApp(id);
      const ref = typeof payload.ref === 'string' && payload.ref.trim() ? payload.ref.trim() : null;
      const started = startDeployment(app.id, { trigger: 'hub', ref, actor: payload.actor ? `hub: ${String(payload.actor).slice(0, 80)}` : 'hub' });
      if (!started.ok) throw refuse(started.error);
      watch(started);
      return { runId: started.runId, status: 'running' };
    }

    case 'rollback': {
      const app = requireApp(id);
      const releaseId = typeof payload.releaseId === 'string' && payload.releaseId ? payload.releaseId : null;
      if (releaseId !== null && !isId(releaseId)) throw refuse('Invalid release id.');
      const started = startRollback(app.id, { releaseId, actor: 'hub' });
      if (!started.ok) throw refuse(started.error);
      watch(started);
      return { runId: started.runId, status: 'running' };
    }

    case 'create': {
      const input = appInputFromHub(payload.app);
      const result = createApp({ ...input, id: String(payload.app?.id ?? '').trim() });
      if (!result.ok) throw refuse(result.errors[0]);
      return publicApp(result.app);
    }

    case 'update': {
      requireApp(id);
      const result = updateApp(id, appInputFromHub(payload.app));
      if (!result.ok) throw refuse(result.errors[0]);
      return publicApp(result.app);
    }

    case 'delete': {
      const app = requireApp(id);
      const deleteDomain = payload.deleteDomain === true && Boolean(app.domain);
      // Removing a domain is its own permission. Managing apps does not imply it.
      if (deleteDomain && getHubPermissions()['domains.delete'] !== true) {
        throw refuse("Deleting the linked domain needs 'domains.delete', which this server has switched off. Delete the app without its domain, or enable it in Settings → Hub.");
      }
      const result = await removeApp(id, { deleteDomain });
      if (!result.ok) throw refuse(result.error);
      return { deleted: id, domainDeleted: result.domainDeleted, warning: result.warning ?? null };
    }

    case 'linkDomain': {
      requireApp(id);
      const name = String(payload.domain ?? '').trim().toLowerCase();
      // Linking writes a domain's nginx config, so it also needs the domain
      // permission that action would need on its own.
      const needed = findDomain(name) ? 'domains.edit' : 'domains.create';
      if (getHubPermissions()[needed] !== true) {
        throw refuse(`Linking this domain needs '${needed}', which this server has switched off (Settings → Hub).`);
      }
      // No certificate request from here: `ssl.issue` is its own permission
      // and its own action, on the SSL section.
      const result = await linkDomain(id, { domain: name, ssl: false });
      if (!result.ok) throw refuse(result.error);
      return { domain: result.domain, created: result.created, port: result.port, nginxReloaded: result.nginxReloaded };
    }

    case 'unlinkDomain': {
      const result = unlinkDomain(id);
      if (!result.ok) throw refuse(result.error);
      return { unlinked: true };
    }

    case 'move': {
      requireApp(id);
      const result = await moveApp(id, payload.path);
      if (!result.ok) throw refuse(result.error);
      return { from: result.from, to: result.to, restarted: result.restarted, warning: result.warning ?? null };
    }

    case 'issueToken': {
      requireApp(id);
      const issued = rotateHookToken(id);
      // The one moment the token exists in clear. It passes through the Hub to
      // the person who asked for it; the Hub does not keep it.
      return { token: issued.token, tokenHint: issued.hint };
    }

    case 'getEnv': {
      const app = requireApp(id);
      return { env: app.env ?? {} };
    }

    case 'setEnv': {
      requireApp(id);
      const env = normalizeEnv(payload.env);
      if (!env.ok) throw refuse(env.error);
      const result = updateApp(id, { env: env.value });
      if (!result.ok) throw refuse(result.errors[0]);
      return { envKeys: Object.keys(env.value).sort() };
    }

    default:
      throw refuse(`Unknown deployment action: ${action}`);
  }
}

/**
 * Handles hub:deployHook — a CI job calling the Hub instead of this server.
 *
 * The Hub is a relay here, nothing more: it forwards the app id and the token
 * the CI job presented, and THIS function verifies the token, exactly as the
 * server's own deploy hook does. The Hub never learns whether a token is
 * valid except by the answer, and stores nothing.
 *
 * One answer for an unknown app, an app without a token and a wrong token —
 * `unauthorized: true`, which the Hub turns into a 401.
 *
 * @param {Object} payload { action: 'trigger'|'status', appId, token, ref?, runId? }
 * @returns {Promise<Object>}
 */
export async function handleHubDeployHook(payload, { onFinished = null } = {}) {
  const { action, appId, token } = payload ?? {};

  const app = typeof appId === 'string' && validateAppId(appId) === null ? getApp(appId) : null;
  if (!app || !verifyHookToken(app, typeof token === 'string' ? token : '')) {
    return { unauthorized: true };
  }

  if (action === 'trigger') {
    const ref = typeof payload.ref === 'string' && payload.ref.trim() ? payload.ref.trim() : null;
    const started = startDeployment(app.id, { trigger: 'webhook', ref, actor: 'deploy hook (via Hub)' });
    if (!started.ok) {
      return { started: false, status: started.status ?? 500, error: started.error, runId: started.runId ?? null };
    }
    if (onFinished) started.done.then((run) => { try { onFinished(run); } catch { /* ignore */ } });
    return { started: true, runId: started.runId };
  }

  if (action === 'status') {
    const run = isId(payload.runId) ? readRun(app.id, payload.runId) : null;
    if (!run) return { found: false };
    return {
      found: true,
      run: {
        runId: run.id,
        status: run.status,
        step: run.step,
        sha: run.sha,
        error: run.error,
        rolledBackTo: run.rolledBackTo ?? null,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      },
    };
  }

  throw refuse(`Unknown deploy hook action: ${action}`);
}
