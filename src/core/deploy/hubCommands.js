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
  getApp, createApp, updateApp, publicApp, normalizeEnv, rotateHookToken, verifyHookToken, validateAppId, isSshUrl,
} from './apps.js';
import { startDeployment, startRollback, removeRelease, removeApp, moveApp } from './engine.js';
import { linkDomain, unlinkDomain } from './domainLink.js';
import { describeGithubSetup } from './github.js';
import { addDeployKey, deployKeyAddUrl, validateGithubToken } from './githubApi.js';
import { generateDeployKey, testDeployKey } from './deployKey.js';
import { hookSettings } from './hookServer.js';
import { describeApps, describeAppDetail } from './status.js';
import { isId, lockHolder, readLogTail, readRun } from './store.js';
import { safeLogText } from '../hub/deployProgress.js';

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
  for (const key of ['repoUrl', 'branch', 'authType', 'token', 'generateKey', 'settings', 'keepReleases', 'autoRollback', 'notifyChannelIds']) {
    if (src[key] !== undefined) out[key] = src[key];
  }
  return out;
}

/**
 * True when a create request asks for the key in the same step. Ignored for
 * every auth type except deployKey; absent means yes for deployKey.
 */
export function wantsGeneratedKey(input) {
  return input?.authType === 'deployKey' && input?.generateKey !== false;
}

/**
 * Generates a new app's key and shapes the create response's `deployKey`
 * object. A failure is returned as `deployKeyError`: the app exists either way,
 * and the UI can offer "Regenerate key".
 */
export function generateKeyForApp(id) {
  try {
    const key = generateDeployKey(id);
    if (!key) return { deployKeyError: `No app named "${id}".` };
    return {
      deployKey: {
        publicKey: key.publicKey,
        fingerprint: key.fingerprint,
        createdAt: key.createdAt,
        addUrl: deployKeyAddUrl(getApp(id)?.repoUrl),
      },
    };
  } catch (err) {
    return { deployKeyError: err.message };
  }
}

/**
 * Regenerates an app's deploy key. Shared by the dashboard route and the Hub
 * command so both enforce the same auth, URL and deploy-lock rules.
 *
 * @returns {{ ok: true, value: Object } | { ok: false, status: number, error: string }}
 */
export function regenerateAppDeployKey(id) {
  const app = typeof id === 'string' ? getApp(id) : null;
  if (!app) return { ok: false, status: 404, error: `No app named "${id}".` };
  if (app.auth?.type !== 'deployKey' || !isSshUrl(app.repoUrl)) {
    return {
      ok: false,
      status: 400,
      error: 'A deploy key needs an app with deployKey authentication and an SSH repository URL.',
    };
  }
  if (lockHolder(app.id)) {
    return {
      ok: false,
      status: 409,
      error: 'A deployment is running; regenerate the key after it finishes.',
    };
  }

  try {
    const key = generateDeployKey(app.id);
    if (!key) return { ok: false, status: 404, error: `No app named "${id}".` };
    return {
      ok: true,
      value: {
        publicKey: key.publicKey,
        fingerprint: key.fingerprint,
        createdAt: key.createdAt,
        previousFingerprint: key.previousFingerprint,
        addUrl: deployKeyAddUrl(app.repoUrl),
      },
    };
  } catch (err) {
    return { ok: false, status: 500, error: err.message };
  }
}

/**
 * Adds an app's public key to GitHub. `token` is a typed token used once; when
 * it is absent the app's own token is tried, exactly as githubApply does.
 */
export async function addAppDeployKeyToGithub(id, token, { fetchImpl } = {}) {
  const app = typeof id === 'string' ? getApp(id) : null;
  if (!app) return { ok: false, status: 404, error: `No app named "${id}".` };

  const typed = typeof token === 'string' ? token.trim() : '';
  const effective = typed || (app.auth?.type === 'token' ? app.auth.token : '');
  const key = app.auth?.publicKey ?? null;
  if (!key) return { ok: false, status: 409, error: 'Generate the deploy key first.' };
  if (!validateGithubToken(effective)) {
    return { ok: false, status: 400, error: 'A GitHub token with write access to the repository is required.' };
  }

  const result = await addDeployKey({
    repoUrl: app.repoUrl,
    token: effective,
    title: `Easy DevOps — ${app.id}`,
    key,
    fetchImpl,
  });
  if (result.error) return { ok: false, status: 400, ...result };
  const failed = result.steps.find((s) => !s.ok);
  if (failed) return { ok: false, status: 422, ...result, error: failed.detail };
  return { ok: true, status: 200, ...result };
}

/**
 * Handles a hub:manageDeploy command.
 *
 * @param {Object} payload { action, id?, ... }
 * @param {Object} [opts]
 * @param {(run: Object) => void} [opts.onFinished] Called when a deployment or rollback started here ends
 * @returns {Promise<Object>} The command's result data. Throws to refuse.
 */
export async function handleHubDeployCommand(payload, { onFinished = null, onProgress = null } = {}) {
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
      // The log on disk is the raw build output. What leaves the server gets
      // the same treatment as live progress: secrets redacted, keys dropped.
      return { ...run, log: safeLogText(log.text, app), logTruncated: log.truncated };
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

    case 'deleteRelease': {
      const app = requireApp(id);
      if (!isId(payload.releaseId)) throw refuse('Invalid release id.');
      const result = removeRelease(app.id, payload.releaseId);
      if (!result.ok) throw refuse(result.error);
      return { deleted: result.deleted };
    }

    case 'create': {
      const input = appInputFromHub(payload.app);
      const result = createApp({ ...input, id: String(payload.app?.id ?? '').trim() });
      if (!result.ok) throw refuse(result.errors[0]);
      // Creating an app never starts a deployment. The key, when asked for, is
      // generated in this same command.
      const extra = wantsGeneratedKey(input) ? generateKeyForApp(result.app.id) : {};
      return { ...publicApp(getApp(result.app.id) ?? result.app), ...extra };
    }

    case 'regenerateKey': {
      const result = regenerateAppDeployKey(id);
      if (!result.ok) throw refuse(result.error);
      return result.value;
    }

    case 'testKey': {
      requireApp(id);
      return testDeployKey(String(id));
    }

    case 'addKeyToGithub': {
      const result = await addAppDeployKeyToGithub(id, payload.token);
      // A missing app or key is a refusal; a GitHub failure is a result the
      // caller reads (ok:false, steps, error), exactly like the dashboard.
      if (!result.ok && result.steps === undefined) throw refuse(result.error);
      const { status: _status, ...data } = result;
      return data;
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
      // Persistent data is kept unless asked for, exactly as on the dashboard.
      const result = await removeApp(id, { deleteDomain, purgeData: payload.purgeData === true });
      if (!result.ok) throw refuse(result.error);
      return {
        deleted: id, domainDeleted: result.domainDeleted, warning: result.warning ?? null,
        sharedKept: result.sharedKept, sharedPath: result.sharedPath,
      };
    }

    case 'linkDomain': {
      requireApp(id);
      // Permissions are checked in core/hub/agent.js before this runs: the map
      // there requires deploy.manage + domains.create, plus ssl.issue when the
      // link asks for a new certificate.
      const result = await linkDomain(id, {
        domain: payload.domain,
        www: payload.www,
        ssl: payload.ssl,
        redirect: payload.redirect,
        behindCloudflare: payload.behindCloudflare,
      }, { onProgress });
      if (!result.ok) throw refuse(result.error);
      return {
        domain: result.domain,
        created: result.created,
        port: result.port,
        www: result.www,
        behindCloudflare: result.behindCloudflare,
        ssl: result.ssl,
        redirect: result.redirect,
        nginxReloaded: result.nginxReloaded,
      };
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
        reason: run.reason ?? null,
        logTail: Array.isArray(run.logTail) ? run.logTail : [],
        rollbackSucceeded: run.rollbackSucceeded ?? null,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      },
    };
  }

  throw refuse(`Unknown deploy hook action: ${action}`);
}
