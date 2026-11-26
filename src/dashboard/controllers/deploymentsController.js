/**
 * dashboard/controllers/deploymentsController.js
 *
 * The Deployments page: the app registry, starting and rolling back
 * deployments, reading their logs, and the deploy hook's settings.
 *
 * A thin layer. Every rule lives in core/deploy/ — validation in apps.js, the
 * pipeline in engine.js — so the Hub command path and the deploy hook reach
 * exactly the same behaviour without going through HTTP.
 *
 * Two things this controller is careful about:
 *
 *   1. It never starts a PM2 daemon just to draw a list. Process status is
 *      read only when PM2's daemon is already running.
 *   2. A deployment is started and answered with 202. The request does not
 *      wait for a build; the page polls the run.
 */

import http from 'http';

import { loadConfig, saveConfig, BIND_ALL, BIND_LOOPBACK } from '../../core/config.js';
import { validatePort } from '../../core/validators.js';
import * as runner from '../../core/runner.js';
import { run as shellRun } from '../../core/shell.js';
import { getDomains, findDomain } from '../../core/domains-db.js';
import { writeConfWithTest } from '../../core/nginx-apply.js';
import { reloadNginx } from '../../core/ssl-issuer.js';
import { DEPLOY_HOOK_PATH } from '../../core/nginx-conf-generator.js';
import { loadChannels } from '../../core/notifier.js';

import {
  getApp, createApp, updateApp, dashboardApp,
  rotateHookToken, revokeHookToken,
  DEFAULT_KEEP_RELEASES, MIN_KEEP_RELEASES, MAX_KEEP_RELEASES,
} from '../../core/deploy/apps.js';
import { startDeployment, startRollback, removeRelease, removeApp, moveApp } from '../../core/deploy/engine.js';
import { readRun, readLogTail, isId, deployRoot } from '../../core/deploy/store.js';
import { isRedactedDeployRun } from '../../core/deploy/logSecurity.js';
import { linkDomain, unlinkDomain } from '../../core/deploy/domainLink.js';
import { resolveOpId, createSslProgress } from '../../core/ssl/progress.js';
import { publish } from '../../core/jobs/bus.js';
import { describeApps, describeAppDetail } from '../../core/deploy/status.js';
import { hookSettings } from '../../core/deploy/hookServer.js';
import { hookUrl } from '../../core/deploy/github.js';
import {
  githubSetupFor, generateKeyForApp, wantsGeneratedKey, regenerateAppDeployKey, addAppDeployKeyToGithub,
  pm2StateForNewApp,
} from '../../core/deploy/hubCommands.js';
import { testDeployKey } from '../../core/deploy/deployKey.js';
import { applyGithubSetup, parseGithubRepo, validateGithubToken } from '../../core/deploy/githubApi.js';
import { EZ_FILE_LOCATIONS } from '../../core/deploy/ezfile.js';

/** Asks the hook listener whether it is up. It may live in another process. */
function probeHook(port) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: `${DEPLOY_HOOK_PATH}health`, method: 'GET', timeout: 1500 },
      (res) => { res.resume(); resolve(res.statusCode === 200); },
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function hookStatus() {
  const settings = hookSettings();
  return {
    ...settings,
    listening: settings.enabled ? await probeHook(settings.port) : false,
    path: DEPLOY_HOOK_PATH,
  };
}

function errorBody(result) {
  return { error: result.errors?.[0] ?? result.error ?? 'Request failed', errors: result.errors ?? undefined };
}

class DeploymentsController {
  /**
   * @param {{ pm2State?: Function }} [deps] Injected by tests. The default is
   *   the shared PM2-state helper, so the dashboard and the Hub answer with the
   *   same object.
   */
  constructor({ pm2State = pm2StateForNewApp } = {}) {
    this.pm2State = pm2State;
  }

  /** GET /api/deployments */
  async list(req, res, next) {
    try {
      const [git, pm2] = await Promise.all([
        shellRun('git --version', { timeout: 10000 }),
        runner.detect({ probeVersion: false }),
      ]);

      res.json({
        apps: await describeApps(),
        hook: await hookStatus(),
        requirements: {
          git: git.success,
          gitVersion: git.success ? git.stdout.replace(/^git version\s*/i, '').trim() : null,
          pm2: pm2.installed,
        },
        limits: {
          keepReleasesDefault: DEFAULT_KEEP_RELEASES,
          keepReleasesMin: MIN_KEEP_RELEASES,
          keepReleasesMax: MAX_KEEP_RELEASES,
        },
        ezFileLocations: EZ_FILE_LOCATIONS,
        // Where a NEW app would be created. Existing apps report their own `dir`.
        deployDir: deployRoot(),
        // Offered in the form so a deployment's outcome can be sent somewhere.
        channels: loadChannels().map((ch) => ({ id: ch.id, name: ch.name, type: ch.type })),
        // Offered as the domain to expose the hook through.
        domains: getDomains().map((d) => ({
          name: d.name, enabled: d.enabled !== false, ssl: Boolean(d.ssl?.enabled),
        })),
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/deployments
   *
   * Answers with the new app plus `pm2` — its state, and, when PM2 is not
   * installed, the one command and the route that installs it. Creating the
   * app never fails because PM2 is missing; the offer is what the UI shows.
   * The endpoint is this server's own install route, registered in
   * routes/processes.js (POST /api/pm2/install).
   */
  async create(req, res, next) {
    try {
      const body = req.body ?? {};
      const result = createApp(body);
      if (!result.ok) return res.status(result.status).json(errorBody(result));
      // Creating an app never starts a deployment. The key, when asked for, is
      // generated in this same request; a failure still leaves a usable app.
      const extra = wantsGeneratedKey(body) ? generateKeyForApp(result.app.id) : {};
      const app = getApp(result.app.id) ?? result.app;
      // A PM2 probe that throws is reported inside the object, never thrown at
      // the create: the app exists either way.
      const pm2 = await this.pm2State({ installEndpoint: 'POST /api/pm2/install' });
      return res.status(201).json({ ...dashboardApp(app), ...extra, pm2 });
    } catch (error) {
      return next(error);
    }
  }

  /** GET /api/deployments/:id */
  async get(req, res, next) {
    try {
      const detail = await describeAppDetail(req.params.id);
      if (!detail) return res.status(404).json({ error: `No app named "${req.params.id}".` });
      return res.json(detail);
    } catch (error) {
      return next(error);
    }
  }

  /** PUT /api/deployments/:id */
  update(req, res, next) {
    try {
      const result = updateApp(req.params.id, req.body ?? {});
      if (!result.ok) return res.status(result.status).json(errorBody(result));
      return res.json(dashboardApp(result.app));
    } catch (error) {
      return next(error);
    }
  }

  /** DELETE /api/deployments/:id */
  async remove(req, res, next) {
    try {
      const deleteDomain = req.query?.deleteDomain === '1' || req.query?.deleteDomain === 'true'
        || req.body?.deleteDomain === true;
      const purgeData = req.query?.purgeData === '1' || req.query?.purgeData === 'true'
        || req.body?.purgeData === true;
      const result = await removeApp(req.params.id, { deleteDomain, purgeData });
      if (!result.ok) return res.status(result.status).json({ error: result.error });
      return res.json({
        deleted: req.params.id,
        domainDeleted: result.domainDeleted,
        warning: result.warning ?? null,
        sharedKept: result.sharedKept,
        sharedPath: result.sharedPath,
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * PUT /api/deployments/:id/domain — link the app to a domain.
   *
   * The domain is created when it does not exist, and re-pointed at the app's
   * port when it does. It is an ordinary domain afterwards: it appears on the
   * Domains page and can be edited there.
   */
  async linkDomain(req, res, next) {
    try {
      const { opId, error } = resolveOpId(req.body?.opId);
      if (error) return res.status(400).json({ error: 'invalid_opId', detail: error });

      const domainName = String(req.body?.domain ?? '').trim().toLowerCase();
      const progress = createSslProgress({
        opId,
        domain: domainName,
        onEvent: (event) => publish('ssl:progress', event),
      });

      // Issuing is synchronous here, exactly like POST /api/ssl/create, but the
      // same stage feed reaches the dialog through ssl:progress while it runs.
      const result = await linkDomain(req.params.id, {
        domain: req.body?.domain,
        www: req.body?.www,
        ssl: req.body?.ssl,
        redirect: req.body?.redirect,
        behindCloudflare: req.body?.behindCloudflare,
      }, {
        onProgress: (stage, status, detail) => progress.report(stage, status, detail),
      });
      if (!result.ok) return res.status(result.status).json({ error: result.error, opId });
      return res.json({
        ok: result.ok,
        opId,
        domain: result.domain,
        created: result.created,
        port: result.port,
        www: result.www,
        behindCloudflare: result.behindCloudflare,
        ssl: result.ssl,
        redirect: result.redirect,
        nginxReloaded: result.nginxReloaded,
      });
    } catch (error) {
      return next(error);
    }
  }

  /** DELETE /api/deployments/:id/domain — forget the link; the domain itself is untouched. */
  unlinkDomain(req, res, next) {
    try {
      const result = unlinkDomain(req.params.id);
      if (!result.ok) return res.status(result.status).json({ error: result.error });
      return res.json({ unlinked: true });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * POST /api/deployments/:id/move — move the app's folder.
   *
   * Body `{ path }` is the PARENT folder; the app ends up in `<path>/<id>`.
   * The request waits for the move: a rename is instant, a move to another
   * disk copies every release.
   */
  async move(req, res, next) {
    try {
      const result = await moveApp(req.params.id, req.body?.path);
      if (!result.ok) return res.status(result.status).json({ error: result.error });
      return res.json({ from: result.from, to: result.to, restarted: result.restarted, warning: result.warning ?? null });
    } catch (error) {
      return next(error);
    }
  }

  /** POST /api/deployments/:id/deploy */
  deploy(req, res, next) {
    try {
      const ref = typeof req.body?.ref === 'string' && req.body.ref.trim() ? req.body.ref.trim() : null;
      const started = startDeployment(req.params.id, { trigger: 'manual', ref, actor: 'dashboard' });
      if (!started.ok) return res.status(started.status).json({ error: started.error, runId: started.runId ?? null });
      return res.status(202).json({ runId: started.runId, status: 'running' });
    } catch (error) {
      return next(error);
    }
  }

  /** POST /api/deployments/:id/rollback */
  rollback(req, res, next) {
    try {
      const releaseId = typeof req.body?.releaseId === 'string' && req.body.releaseId ? req.body.releaseId : null;
      if (releaseId !== null && !isId(releaseId)) return res.status(400).json({ error: 'Invalid release id.' });

      const started = startRollback(req.params.id, { releaseId, actor: 'dashboard' });
      if (!started.ok) return res.status(started.status).json({ error: started.error, runId: started.runId ?? null });
      return res.status(202).json({ runId: started.runId, status: 'running' });
    } catch (error) {
      return next(error);
    }
  }

  /** DELETE /api/deployments/:id/releases/:releaseId — delete an old release's files. */
  removeRelease(req, res, next) {
    try {
      const result = removeRelease(req.params.id, req.params.releaseId);
      if (!result.ok) return res.status(result.status).json({ error: result.error });
      return res.json({ deleted: result.deleted });
    } catch (error) {
      return next(error);
    }
  }

  /** GET /api/deployments/:id/runs/:runId */
  run(req, res, next) {
    try {
      const app = getApp(req.params.id);
      if (!app) return res.status(404).json({ error: `No app named "${req.params.id}".` });

      const run = isId(req.params.runId) ? readRun(app.id, req.params.runId) : null;
      if (!run) return res.status(404).json({ error: 'No such run.' });

      const available = isRedactedDeployRun(run);
      const log = available ? readLogTail(app.id, run.id) : { text: '', truncated: false };
      return res.json({
        ...run,
        // Unmarked runs have no proof that free-form fields were written by
        // the redacting writer. Suppress them on every local surface too.
        error: available ? run.error : null,
        reason: available ? run.reason : null,
        warnings: available && Array.isArray(run.warnings) ? run.warnings : [],
        logTail: available && Array.isArray(run.logTail) ? run.logTail : [],
        log: log.text,
        logTruncated: log.truncated,
        logUnavailable: available ? undefined : 'legacy-format',
      });
    } catch (error) {
      return next(error);
    }
  }

  /** POST /api/deployments/:id/hook-token — issue (or replace) the deploy token. */
  hookToken(req, res, next) {
    try {
      const issued = rotateHookToken(req.params.id);
      if (!issued) return res.status(404).json({ error: `No app named "${req.params.id}".` });
      // The only response that ever contains it.
      return res.json({ token: issued.token, tokenHint: issued.hint });
    } catch (error) {
      return next(error);
    }
  }

  /** DELETE /api/deployments/:id/hook-token — the hook stops accepting this app. */
  revokeHookToken(req, res, next) {
    try {
      if (!revokeHookToken(req.params.id)) return res.status(404).json({ error: `No app named "${req.params.id}".` });
      return res.json({ revoked: true });
    } catch (error) {
      return next(error);
    }
  }

  /** POST /api/deployments/:id/deploy-key — generate (or replace) the SSH deploy key. */
  deployKey(req, res, next) {
    try {
      const result = regenerateAppDeployKey(req.params.id);
      if (!result.ok) return res.status(result.status).json({ error: result.error });
      return res.json(result.value);
    } catch (error) {
      return next(error);
    }
  }

  /**
   * POST /api/deployments/:id/deploy-key/test — git ls-remote with the app's
   * key. A completed test is 200 even when it says the key does not work; the
   * earlier 404/400/409/500 statuses are passed through.
   */
  async deployKeyTest(req, res, next) {
    try {
      const result = await testDeployKey(req.params.id);
      return res.status(result.status ?? 200).json(result);
    } catch (error) {
      return next(error);
    }
  }

  /**
   * POST /api/deployments/:id/deploy-key/github — add the public key to GitHub
   * read-only. The token is typed for this request, used once and forgotten;
   * when omitted the app's own token is tried, exactly as githubApply does.
   */
  async deployKeyGithub(req, res, next) {
    try {
      const result = await addAppDeployKeyToGithub(req.params.id, req.body?.token);
      const { status, ...body } = result;
      if (!result.ok) return res.status(status ?? 422).json(body);
      return res.json(body);
    } catch (error) {
      return next(error);
    }
  }

  /** GET /api/deployments/:id/github — the workflow, the secrets and the URL. */
  github(req, res, next) {
    try {
      const app = getApp(req.params.id);
      if (!app) return res.status(404).json({ error: `No app named "${req.params.id}".` });
      return res.json(githubSetupFor(app, dashboardApp));
    } catch (error) {
      return next(error);
    }
  }

  /**
   * POST /api/deployments/:id/github/apply
   *
   * Does the GitHub steps for the user. The deploy token is issued here and
   * goes straight into the repository's secrets: it is never returned, and
   * the previous one stops working — which is the point of asking for a new
   * setup.
   */
  async githubApply(req, res, next) {
    try {
      const app = getApp(req.params.id);
      if (!app) return res.status(404).json({ error: `No app named "${req.params.id}".` });

      const body = req.body ?? {};
      if (!parseGithubRepo(app.repoUrl)) {
        return res.status(400).json({ error: 'Automatic setup works with github.com repositories only. Use the manual steps.' });
      }

      // A token typed in for this is used and forgotten. Otherwise the one the
      // app already clones with is tried — it often lacks write access, and
      // the answer will say so.
      const typed = typeof body.token === 'string' ? body.token.trim() : '';
      const token = typed || (app.auth?.type === 'token' ? app.auth.token : '');
      if (!validateGithubToken(token)) {
        return res.status(400).json({ error: 'A GitHub token with write access to the repository is required.' });
      }

      const want = {
        secrets: body.secrets !== false,
        workflow: body.workflow !== false,
        deployKey: body.deployKey !== false && app.auth?.type === 'deployKey',
      };

      const setup = githubSetupFor(app, dashboardApp);
      const target = setup.targets.find((t) => t.id === (body.target === 'hub' ? 'hub' : 'hook'));
      if (want.secrets && !target?.url) {
        return res.status(409).json({
          error: target?.note ?? 'There is no URL GitHub could call yet.',
          reason: 'no_deploy_url',
        });
      }
      if (want.deployKey && !setup.deployKey) {
        return res.status(409).json({ error: 'Generate the deploy key first.', reason: 'no_deploy_key' });
      }

      let secrets = null;
      if (want.secrets) {
        const issued = rotateHookToken(app.id);
        secrets = { EZ_DEPLOY_URL: target.url, EZ_DEPLOY_TOKEN: issued.token };
      }

      const result = await applyGithubSetup({
        repoUrl: app.repoUrl,
        branch: app.branch,
        token,
        secrets,
        workflow: want.workflow ? { path: setup.workflowPath, content: setup.workflow } : null,
        deployKey: want.deployKey ? { title: `Easy DevOps — ${app.id}`, key: setup.deployKey } : null,
      });

      // If the token secret did not reach GitHub, the token just issued is
      // known to nobody. Revoking it leaves the app with no token rather than
      // an unusable one that the UI would report as "exists".
      const secretsStep = result.steps.find((s) => s.id === 'secrets');
      if (want.secrets && !secretsStep?.ok) revokeHookToken(app.id);

      return res.status(result.error ? 502 : 200).json({
        ...result,
        target: target?.id ?? null,
        deployUrl: want.secrets ? target.url : null,
      });
    } catch (error) {
      return next(error);
    }
  }

  /** GET /api/deployments/hook */
  async hook(req, res, next) {
    try {
      const status = await hookStatus();
      const preview = hookUrl('your-app', status, getDomains());
      res.json({ ...status, urlExample: preview.url, mode: preview.mode, secure: preview.secure, note: preview.note });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PUT /api/deployments/hook
   *
   * Changing which domain exposes the hook rewrites that domain's nginx config
   * (and the one it is moving away from). The setting is saved first because
   * the config generator reads it; if nginx then rejects the result, the
   * setting is put back and the previous config is already restored by
   * writeConfWithTest().
   */
  async updateHook(req, res, next) {
    try {
      const body = req.body ?? {};
      const config = loadConfig();
      const current = hookSettings(config);
      const wanted = { ...current };

      if (body.enabled !== undefined) {
        if (typeof body.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' });
        wanted.enabled = body.enabled;
      }
      if (body.port !== undefined) {
        const port = parseInt(body.port, 10);
        const portError = validatePort(port);
        if (portError) return res.status(400).json({ error: portError });
        if (port === Number(config.dashboardPort)) {
          return res.status(400).json({ error: 'The deploy hook cannot use the dashboard\'s port.' });
        }
        wanted.port = port;
      }
      if (body.bind !== undefined) {
        if (![BIND_ALL, BIND_LOOPBACK].includes(body.bind)) {
          return res.status(400).json({ error: `bind must be ${BIND_LOOPBACK} or ${BIND_ALL}` });
        }
        wanted.bind = body.bind;
      }
      if (body.domain !== undefined) {
        if (body.domain === null || body.domain === '') {
          wanted.domain = null;
        } else {
          const record = findDomain(String(body.domain));
          if (!record) return res.status(400).json({ error: `No domain named "${body.domain}".` });
          wanted.domain = record.name;
        }
      }

      saveConfig({ ...config, deployHook: wanted });

      // Which domain configs now differ from what is on disk.
      const before = current.enabled ? current.domain : null;
      const after = wanted.enabled ? wanted.domain : null;
      const portMoved = current.port !== wanted.port;
      const touched = [...new Set([
        ...(before !== after ? [before, after] : []),
        ...(portMoved && after ? [after] : []),
      ].filter(Boolean))];

      const applied = [];
      for (const name of touched) {
        const record = findDomain(name);
        // A disabled domain has no live config to rewrite; it picks the
        // location up when it is enabled again.
        if (!record || record.enabled === false) continue;

        const result = await writeConfWithTest(record);
        if (!result.ok) {
          saveConfig({ ...loadConfig(), deployHook: current });
          // Put back any config already rewritten for the new setting.
          for (const done of applied) {
            const again = findDomain(done);
            if (again) await writeConfWithTest(again);
          }
          return res.status(500).json({
            error: `nginx rejected the configuration for ${name}, so the deploy hook setting was not changed.`,
            detail: result.error,
          });
        }
        applied.push(name);
      }

      let nginxReloaded = null;
      if (applied.length > 0) {
        const reloaded = await reloadNginx();
        nginxReloaded = reloaded.ok;
      }

      const status = await hookStatus();
      const preview = hookUrl('your-app', status, getDomains());
      return res.json({
        ...status,
        urlExample: preview.url, mode: preview.mode, secure: preview.secure, note: preview.note,
        nginxReloaded,
        // The listener re-reads the setting on a timer, in another process.
        appliesWithinSeconds: 10,
      });
    } catch (error) {
      return next(error);
    }
  }
}

export default DeploymentsController;
