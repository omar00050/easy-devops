/**
 * core/deploy/apps.js
 *
 * The registry of deployed apps: what to fetch, how to authenticate, what to
 * override, which environment to run with, and how a deployment may be
 * triggered.
 *
 * Stored under the `deployApps` key in the database, like domains. It holds
 * secrets — environment values, a GitHub token — because the server is the
 * one place they have to exist. They never leave it in a Hub telemetry push
 * (see publicApp()), and the deploy-hook token is not stored at all: only its
 * SHA-256, since it is 256 bits of randomness and needs no slow hash.
 *
 * Everything that becomes part of a shell command or a path is validated HERE,
 * once, on the way in: the id, the repository URL and the branch. The engine
 * can then build commands from an app record without re-checking it.
 */

import crypto from 'crypto';
import fs from 'fs';

import { dbGet, dbSet } from '../db.js';
import { normalizeOverrides, settingsWarnings } from './ezfile.js';
import path from 'path';
import { describeDeployKey } from './deployKey.js';
import { appPaths, deployRoot, ensureAppDirs, removeAppFiles } from './store.js';
import { EZ_APP_NAMES } from '../runner.js';

const STORE_KEY = 'deployApps';

export const AUTH_TYPES = Object.freeze({ NONE: 'none', DEPLOY_KEY: 'deployKey', TOKEN: 'token' });

export const DEFAULT_KEEP_RELEASES = 5;
export const MIN_KEEP_RELEASES = 2;
export const MAX_KEEP_RELEASES = 20;

const MAX_ENV_VARS = 200;
const MAX_ENV_VALUE = 16 * 1024;

/** PM2 names every deployed app gets, so they are recognisable as ours. */
export const PM2_PREFIX = 'ez-';

/** @returns {string} The PM2 process name for an app id */
export function pm2Name(appId) {
  return `${PM2_PREFIX}${appId}`;
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * An app id: lower-case letters, digits and dashes, 1–40 characters.
 * It becomes a directory name, a PM2 name and a URL segment.
 *
 * @returns {string|null} An error message, or null when the id is acceptable
 */
export function validateAppId(id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) {
    return 'The name must be 1–40 characters: lower-case letters, digits and dashes, starting with a letter or digit.';
  }
  if (id.endsWith('-')) return 'The name cannot end with a dash.';
  // `ez-dashboard` is Easy DevOps' own PM2 app; an app called "dashboard"
  // would take its name and be stopped by `ezz service` commands.
  if (EZ_APP_NAMES.includes(pm2Name(id))) return `"${id}" is reserved.`;
  if (id === 'hook') return '"hook" is reserved.';
  return null;
}

/**
 * A repository URL git can fetch from: https, ssh://, or the scp-like
 * `git@host:owner/repo.git`.
 *
 * The character set is deliberately narrow. This string is interpolated into
 * a shell command, so quotes, spaces, `$`, backticks, `;`, `&`, `|` and the
 * rest are refused outright rather than escaped — nothing a real repository
 * URL needs is lost, and there is no quoting to get wrong per shell.
 * Credentials embedded in the URL are refused too: they would be written to
 * the deployment log.
 *
 * @returns {string|null} An error message, or null
 */
export function validateRepoUrl(url) {
  if (typeof url !== 'string' || url.length === 0 || url.length > 500) return 'A repository URL is required.';
  if (!/^[A-Za-z0-9@:/._~+-]+$/.test(url)) return 'The repository URL contains characters that are not allowed.';
  if (url.startsWith('-')) return 'The repository URL is not valid.';

  if (/^https:\/\//.test(url)) {
    if (/^https:\/\/[^/]*@/.test(url)) return 'Do not put credentials in the URL — use a token or a deploy key instead.';
    if (!/^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?\/[A-Za-z0-9._~+/-]+$/.test(url)) return 'The repository URL is not valid.';
    return null;
  }
  if (/^ssh:\/\//.test(url)) {
    if (!/^ssh:\/\/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+(:[0-9]+)?\/[A-Za-z0-9._~+/-]+$/.test(url)) return 'The repository URL is not valid.';
    return null;
  }
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~+/-]+$/.test(url)) return null;

  return 'Use an https:// URL, an ssh:// URL, or the git@host:owner/repo.git form.';
}

/** True for a URL git reaches over SSH. */
export function isSshUrl(url) {
  return /^ssh:\/\//.test(String(url)) || /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:/.test(String(url));
}

/**
 * A branch name, tag or commit SHA.
 * @returns {string|null} An error message, or null
 */
export function validateRef(ref) {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 200) return 'A branch is required.';
  if (!/^[A-Za-z0-9._/-]+$/.test(ref) || ref.startsWith('-') || ref.includes('..')) {
    return 'The branch name contains characters that are not allowed.';
  }
  return null;
}

/**
 * Environment variables: `{ NAME: "value" }`.
 * @returns {{ ok: boolean, value: Object<string,string>, error: string|null }}
 */
export function normalizeEnv(input) {
  if (input === undefined || input === null) return { ok: true, value: {}, error: null };
  if (typeof input !== 'object' || Array.isArray(input)) return { ok: false, value: {}, error: 'env must be an object of NAME: value pairs' };

  const entries = Object.entries(input);
  if (entries.length > MAX_ENV_VARS) return { ok: false, value: {}, error: `At most ${MAX_ENV_VARS} environment variables are allowed.` };

  const value = {};
  for (const [name, raw] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      return { ok: false, value: {}, error: `"${name}" is not a valid variable name (letters, digits and underscores, not starting with a digit).` };
    }
    if (raw === null || raw === undefined) continue;
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
      return { ok: false, value: {}, error: `The value of ${name} must be text.` };
    }
    const text = String(raw);
    if (text.length > MAX_ENV_VALUE) return { ok: false, value: {}, error: `The value of ${name} is too long.` };
    if (text.includes('\0')) return { ok: false, value: {}, error: `The value of ${name} contains a NUL character.` };
    value[name] = text;
  }
  return { ok: true, value, error: null };
}

function normalizeKeep(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_KEEP_RELEASES;
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_KEEP_RELEASES || n > MAX_KEEP_RELEASES) return null;
  return n;
}

// ─── Storage ──────────────────────────────────────────────────────────────────

/** @returns {Array<Object>} */
export function listApps() {
  const raw = dbGet(STORE_KEY);
  return Array.isArray(raw) ? raw : [];
}

function saveApps(apps) {
  dbSet(STORE_KEY, apps);
}

/** @returns {Object|null} */
export function getApp(id) {
  return listApps().find((a) => a.id === id) ?? null;
}

/**
 * Validates the editable fields of an app.
 *
 * `existing` makes it an update: fields that are absent keep their current
 * value, and the token is kept unless a new one is supplied — so the UI never
 * has to round-trip a secret just to change the branch.
 *
 * @returns {{ ok: boolean, value: Object|null, errors: string[], warnings: string[] }}
 */
export function normalizeAppInput(input, existing = null) {
  const errors = [];
  const warnings = [];
  const src = input && typeof input === 'object' ? input : {};
  const has = (k) => src[k] !== undefined;

  const repoUrl = has('repoUrl') ? String(src.repoUrl ?? '').trim() : existing?.repoUrl;
  const repoError = validateRepoUrl(repoUrl);
  if (repoError) errors.push(repoError);

  const branch = has('branch') ? String(src.branch ?? '').trim() || 'main' : (existing?.branch ?? 'main');
  const refError = validateRef(branch);
  if (refError) errors.push(refError);

  // ── how the server authenticates to the repository
  const authType = has('authType') ? src.authType : (existing?.auth?.type ?? AUTH_TYPES.NONE);
  if (!Object.values(AUTH_TYPES).includes(authType)) errors.push('authType must be none, deployKey or token.');

  let token = existing?.auth?.token ?? null;
  if (has('token') && src.token !== null && src.token !== '') {
    const t = String(src.token).trim();
    // The token goes into an HTTP header on the git command line.
    if (!/^[A-Za-z0-9_.-]{10,255}$/.test(t)) errors.push('The token contains characters that are not allowed.');
    else token = t;
  }
  if (authType === AUTH_TYPES.TOKEN) {
    if (!token) errors.push('A token is required for token authentication.');
    if (repoUrl && isSshUrl(repoUrl)) errors.push('Token authentication needs an https:// repository URL.');
  }
  if (authType === AUTH_TYPES.DEPLOY_KEY && repoUrl && !isSshUrl(repoUrl)) {
    errors.push('A deploy key needs an SSH repository URL (git@github.com:owner/repo.git).');
  }

  const overrides = has('settings') ? normalizeOverrides(src.settings) : { ok: true, value: existing?.settings ?? {}, errors: [], warnings: [] };
  for (const e of overrides.errors) errors.push(e);
  for (const w of overrides.warnings ?? []) warnings.push(w);
  for (const w of settingsWarnings(overrides.value)) {
    if (!warnings.includes(w)) warnings.push(w);
  }

  const env = has('env') ? normalizeEnv(src.env) : { ok: true, value: existing?.env ?? {}, error: null };
  if (env.error) errors.push(env.error);

  const keepReleases = has('keepReleases') ? normalizeKeep(src.keepReleases) : (existing?.keepReleases ?? DEFAULT_KEEP_RELEASES);
  if (keepReleases === null) errors.push(`keepReleases must be a whole number from ${MIN_KEEP_RELEASES} to ${MAX_KEEP_RELEASES}.`);

  const autoRollback = has('autoRollback') ? src.autoRollback : (existing?.autoRollback ?? true);
  if (typeof autoRollback !== 'boolean') errors.push('autoRollback must be true or false.');

  let notifyChannelIds = existing?.notifyChannelIds ?? [];
  if (has('notifyChannelIds')) {
    if (!Array.isArray(src.notifyChannelIds) || src.notifyChannelIds.some((c) => typeof c !== 'string')) {
      errors.push('notifyChannelIds must be a list of channel ids.');
    } else {
      notifyChannelIds = [...new Set(src.notifyChannelIds)];
    }
  }

  if (errors.length > 0) return { ok: false, value: null, errors, warnings };

  return {
    ok: true,
    errors,
    warnings,
    value: {
      repoUrl,
      branch,
      auth: {
        type: authType,
        // Kept even when another type is selected, so switching back does not
        // need the secret entered again. Only used when the type says so.
        token,
        publicKey: existing?.auth?.publicKey ?? null,
        keyFingerprint: existing?.auth?.keyFingerprint ?? null,
        keyCreatedAt: existing?.auth?.keyCreatedAt ?? null,
      },
      settings: overrides.value,
      env: env.value,
      keepReleases,
      autoRollback,
      notifyChannelIds,
    },
  };
}

/**
 * Creates an app.
 * @returns {{ ok: true, app: Object } | { ok: false, errors: string[], status: number }}
 */
export function createApp(input) {
  const id = String(input?.id ?? '').trim();
  const idError = validateAppId(id);
  if (idError) return { ok: false, errors: [idError], status: 400 };

  const apps = listApps();
  if (apps.some((a) => a.id === id)) return { ok: false, errors: [`An app named "${id}" already exists.`], status: 409 };

  const normalized = normalizeAppInput(input);
  if (!normalized.ok) return { ok: false, errors: normalized.errors, warnings: normalized.warnings, status: 400 };

  const now = new Date().toISOString();
  const app = {
    id,
    ...normalized.value,
    // Recorded once, here: the app keeps living in this folder even if the
    // deployments-folder setting changes later. Only a move changes it.
    dir: path.join(deployRoot(), id),
    // The domain that proxies to this app, when one is linked (domainLink.js).
    domain: null,
    hook: { tokenHash: null, tokenHint: null, createdAt: null },
    createdAt: now,
    updatedAt: now,
  };

  // Saved first: store.js resolves an app's folder from its record.
  saveApps([...apps, app]);
  try {
    ensureAppDirs(id);
  } catch (err) {
    saveApps(apps);
    return { ok: false, errors: [`Could not create ${app.dir}: ${err.message}`], status: 500 };
  }
  return { ok: true, app, warnings: normalized.warnings };
}

/**
 * Updates an app's editable fields.
 * @returns {{ ok: true, app: Object } | { ok: false, errors: string[], status: number }}
 */
export function updateApp(id, input) {
  const apps = listApps();
  const index = apps.findIndex((a) => a.id === id);
  if (index === -1) return { ok: false, errors: [`No app named "${id}".`], status: 404 };

  const normalized = normalizeAppInput(input, apps[index]);
  if (!normalized.ok) return { ok: false, errors: normalized.errors, warnings: normalized.warnings, status: 400 };

  const app = { ...apps[index], ...normalized.value, updatedAt: new Date().toISOString() };
  apps[index] = app;
  saveApps(apps);
  return { ok: true, app, warnings: normalized.warnings };
}

/** Records a new folder for an app after it has been moved. */
export function setAppDir(id, dir) {
  return patchApp(id, { dir });
}

/** Records (or clears) the domain linked to an app. */
export function setAppDomain(id, domain) {
  return patchApp(id, { domain: domain ?? null });
}

/**
 * Records the PUBLIC half of a freshly written deploy key. The private key is
 * never stored in the registry; core/deploy/deployKey.js writes it to disk.
 */
export function setDeployKeyRecord(id, { publicKey, fingerprint, createdAt }) {
  const app = getApp(id);
  if (!app) return null;
  return patchApp(id, {
    auth: { ...(app.auth ?? {}), publicKey, keyFingerprint: fingerprint, keyCreatedAt: createdAt },
  });
}

/** Low-level patch for fields this module owns (hook token, deploy key, folder, domain). */
function patchApp(id, patch) {
  const apps = listApps();
  const index = apps.findIndex((a) => a.id === id);
  if (index === -1) return null;
  apps[index] = { ...apps[index], ...patch, updatedAt: new Date().toISOString() };
  saveApps(apps);
  return apps[index];
}

/**
 * Removes an app from the registry and deletes its files.
 * Stopping its PM2 process is the caller's job (core/deploy/engine.js).
 *
 * Persistent data is kept unless `purgeData` says otherwise: a delete removes
 * a deployment, not the database and uploads it was serving.
 *
 * @returns {{ keptShared: boolean, sharedPath: string } | null} null when there was no such app
 */
export function deleteApp(id, { purgeData = false } = {}) {
  const apps = listApps();
  if (!apps.some((a) => a.id === id)) return null;
  // Files first: once the record is gone, nothing remembers which folder was its.
  let files = { keptShared: false, sharedPath: appPaths(id).shared };
  try { files = removeAppFiles(id, { keepShared: !purgeData }); } catch { /* files in use: the registry entry is removed regardless */ }
  saveApps(apps.filter((a) => a.id !== id));
  return files;
}

// ─── The deploy-hook token ────────────────────────────────────────────────────

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

/**
 * Issues a new deploy-hook token for an app, replacing any earlier one.
 *
 * The cleartext is returned ONCE, to be shown to the user and pasted into the
 * repository's secrets. Only its hash is stored, so a copy of the database is
 * not a set of working deploy credentials.
 *
 * @returns {{ token: string, hint: string } | null} null when the app does not exist
 */
export function rotateHookToken(id) {
  const token = `ezd_${crypto.randomBytes(32).toString('base64url')}`;
  const hint = token.slice(-4);
  const app = patchApp(id, {
    hook: { tokenHash: sha256(token), tokenHint: hint, createdAt: new Date().toISOString() },
  });
  return app ? { token, hint } : null;
}

/** Removes the token, which disables the hook for this app. */
export function revokeHookToken(id) {
  return Boolean(patchApp(id, { hook: { tokenHash: null, tokenHint: null, createdAt: null } }));
}

/**
 * Constant-time check of a presented token against an app's stored hash.
 * @returns {boolean}
 */
export function verifyHookToken(app, presented) {
  const stored = app?.hook?.tokenHash;
  if (!stored || typeof presented !== 'string' || presented.length === 0 || presented.length > 512) return false;
  const a = Buffer.from(sha256(presented), 'hex');
  const b = Buffer.from(stored, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ─── The deploy key ───────────────────────────────────────────────────────────

/** Path of an app's private deploy key, or null when it has none on disk. */
export function deployKeyPath(id) {
  const file = appPaths(id).deployKey;
  return fs.existsSync(file) ? file : null;
}

// ─── What may be shown ────────────────────────────────────────────────────────

/**
 * The app as the local dashboard may see it: everything except the secrets
 * that have no reason to be read back. Environment values ARE included — the
 * dashboard is where they are edited, behind its own login.
 */
export function dashboardApp(app) {
  if (!app) return null;
  const paths = appPaths(app.id);
  const key = describeDeployKey(app);
  let hasSharedData = false;
  try { hasSharedData = fs.readdirSync(paths.shared).length > 0; } catch { /* nothing persistent */ }
  return {
    id: app.id,
    pm2Name: pm2Name(app.id),
    repoUrl: app.repoUrl,
    branch: app.branch,
    authType: app.auth?.type ?? AUTH_TYPES.NONE,
    hasToken: Boolean(app.auth?.token),
    deployKey: key.publicKey,
    deployKeyFingerprint: key.fingerprint,
    deployKeyCreatedAt: key.createdAt,
    deployKeyOnDisk: key.onDisk,
    settings: app.settings ?? {},
    /** Advisory notes the UI shows beside the settings (cluster mode's stateless warning). */
    warnings: settingsWarnings(app.settings ?? {}),
    env: app.env ?? {},
    keepReleases: app.keepReleases ?? DEFAULT_KEEP_RELEASES,
    autoRollback: app.autoRollback !== false,
    notifyChannelIds: app.notifyChannelIds ?? [],
    dir: paths.root,
    /** Where the folders listed in `settings.persist` live. */
    sharedDir: paths.shared,
    hasSharedData,
    domain: app.domain ?? null,
    hook: {
      hasToken: Boolean(app.hook?.tokenHash),
      tokenHint: app.hook?.tokenHint ?? null,
      createdAt: app.hook?.createdAt ?? null,
    },
    createdAt: app.createdAt ?? null,
    updatedAt: app.updatedAt ?? null,
  };
}

/**
 * The app as it may leave the server (Hub telemetry): no environment VALUES,
 * only their names, and no credentials of any kind.
 */
export function publicApp(app) {
  const d = dashboardApp(app);
  if (!d) return null;
  const { env, ...rest } = d;
  return { ...rest, envKeys: Object.keys(env).sort() };
}
