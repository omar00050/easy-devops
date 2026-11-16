/**
 * core/deploy/githubApi.js
 *
 * Does the GitHub side of the setup for the user: stores the two repository
 * secrets, commits the workflow file, and adds the deploy key. The manual
 * steps in the dashboard remain; this is the same result without the copying.
 *
 * ── The two dependencies ─────────────────────────────────────────────────────
 *
 * GitHub only accepts a secret encrypted to the repository's public key with
 * a libsodium "sealed box": X25519 + XSalsa20-Poly1305, with a nonce derived
 * by BLAKE2b. Node's crypto has neither XSalsa20 nor a BLAKE2b with a 24-byte
 * digest, so this is the one place the package depends on `tweetnacl` and
 * `blakejs` (an explicit decision, CLAUDE.md rule 7). Both are small, pure
 * JavaScript and have no dependencies of their own.
 *
 * ── The token ────────────────────────────────────────────────────────────────
 *
 * The GitHub token used here needs more than reading the repository: writing
 * Actions secrets, writing contents (and workflows), and — for a deploy key —
 * repository administration. It is used for these calls and, when it was typed
 * in for the occasion, is not stored.
 *
 * `fetch` is injectable, so every request and every error path is tested
 * without touching the network.
 */

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const nacl = require('tweetnacl');
const { blake2b } = require('blakejs');

const API = 'https://api.github.com';

/**
 * Encrypts a secret for GitHub: a libsodium sealed box.
 *
 *   ephemeral key pair (epk, esk)
 *   nonce = BLAKE2b-24(epk ‖ recipient public key)
 *   box   = crypto_box(message, nonce, recipient public key, esk)
 *   out   = epk ‖ box
 *
 * @param {string} value The secret
 * @param {string} publicKeyBase64 The repository's public key, as GitHub returns it
 * @returns {string} Base64 ciphertext for `encrypted_value`
 */
export function sealSecret(value, publicKeyBase64) {
  const recipient = new Uint8Array(Buffer.from(publicKeyBase64, 'base64'));
  if (recipient.length !== nacl.box.publicKeyLength) {
    throw new Error('The repository public key has an unexpected length.');
  }

  const ephemeral = nacl.box.keyPair();
  const nonceInput = new Uint8Array(ephemeral.publicKey.length + recipient.length);
  nonceInput.set(ephemeral.publicKey, 0);
  nonceInput.set(recipient, ephemeral.publicKey.length);
  const nonce = blake2b(nonceInput, undefined, nacl.box.nonceLength);

  const message = new Uint8Array(Buffer.from(String(value), 'utf8'));
  const box = nacl.box(message, nonce, recipient, ephemeral.secretKey);

  const out = new Uint8Array(ephemeral.publicKey.length + box.length);
  out.set(ephemeral.publicKey, 0);
  out.set(box, ephemeral.publicKey.length);
  return Buffer.from(out).toString('base64');
}

/**
 * Opens a sealed box. Not used in production — GitHub does the opening — but
 * it is what lets the test prove sealSecret() produces something a holder of
 * the private key can read.
 *
 * @returns {string|null} The plaintext, or null when it does not open
 */
export function openSealedSecret(sealedBase64, publicKey, secretKey) {
  const sealed = new Uint8Array(Buffer.from(sealedBase64, 'base64'));
  const epk = sealed.subarray(0, nacl.box.publicKeyLength);
  const box = sealed.subarray(nacl.box.publicKeyLength);

  const nonceInput = new Uint8Array(epk.length + publicKey.length);
  nonceInput.set(epk, 0);
  nonceInput.set(publicKey, epk.length);
  const nonce = blake2b(nonceInput, undefined, nacl.box.nonceLength);

  const opened = nacl.box.open(box, nonce, epk, secretKey);
  return opened ? Buffer.from(opened).toString('utf8') : null;
}

/**
 * Owner and repository from a github.com URL, in any of the forms an app may
 * be configured with.
 *
 * @returns {{ owner: string, repo: string }|null} null for any other host
 */
export function parseGithubRepo(repoUrl) {
  const url = String(repoUrl ?? '');
  const m =
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url) ||
    /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url) ||
    /^ssh:\/\/git@github\.com(?::22)?\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** A GitHub token, checked before it is put in a header. */
export function validateGithubToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_.-]{10,255}$/.test(token);
}

function makeClient(token, fetchImpl) {
  return async (method, path, body) => {
    let response;
    try {
      response = await fetchImpl(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'easy-devops',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      return { ok: false, status: 0, json: null, message: `Could not reach GitHub: ${err.message}` };
    }

    let json = null;
    try { json = await response.json(); } catch { /* 204, or not JSON */ }
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json,
      message: typeof json?.message === 'string' ? json.message : null,
    };
  };
}

/** Why a call failed, in words that say what to change on the token. */
function explain(result, needs) {
  if (result.status === 0) return result.message;
  if (result.status === 401) return 'GitHub rejected the token. It may be mistyped, expired or revoked.';
  if (result.status === 403 || result.status === 404) {
    return `GitHub refused (${result.status}${result.message ? `: ${result.message}` : ''}). The token needs ${needs} on this repository.`;
  }
  if (result.status === 422) return `GitHub did not accept the request${result.message ? `: ${result.message}` : '.'}`;
  return `GitHub answered ${result.status}${result.message ? `: ${result.message}` : ''}.`;
}

/**
 * Applies the setup to a repository.
 *
 * Each requested part is attempted independently and reported on its own, so
 * a token that may write secrets but not workflows still gets the secrets in
 * place, and the answer says exactly which manual step is left.
 *
 * @param {Object} opts
 * @param {string} opts.repoUrl
 * @param {string} opts.branch
 * @param {string} opts.token GitHub token
 * @param {Object<string, string>|null} [opts.secrets] name → value, or null to skip
 * @param {{ path: string, content: string }|null} [opts.workflow]
 * @param {{ title: string, key: string }|null} [opts.deployKey]
 * @param {Function} [opts.fetchImpl]
 * @returns {Promise<{ ok: boolean, repo: string|null, error: string|null,
 *   steps: Array<{ id: string, ok: boolean, detail: string }> }>}
 */
export async function applyGithubSetup({
  repoUrl, branch, token, secrets = null, workflow = null, deployKey = null, fetchImpl = globalThis.fetch,
}) {
  const repo = parseGithubRepo(repoUrl);
  if (!repo) {
    return { ok: false, repo: null, error: 'Automatic setup works with github.com repositories only.', steps: [] };
  }
  if (!validateGithubToken(token)) {
    return { ok: false, repo: `${repo.owner}/${repo.repo}`, error: 'A GitHub token is required.', steps: [] };
  }

  const gh = makeClient(token, fetchImpl);
  const base = `/repos/${repo.owner}/${repo.repo}`;
  const full = `${repo.owner}/${repo.repo}`;
  const steps = [];

  // Can the token see the repository at all? One clear answer here beats
  // three confusing ones below.
  const seen = await gh('GET', base);
  if (!seen.ok) {
    return { ok: false, repo: full, error: explain(seen, 'access'), steps };
  }

  // ── secrets ───────────────────────────────────────────────────────────────
  if (secrets) {
    const key = await gh('GET', `${base}/actions/secrets/public-key`);
    if (!key.ok || !key.json?.key || !key.json?.key_id) {
      steps.push({ id: 'secrets', ok: false, detail: explain(key, '“Secrets: read and write”') });
    } else {
      const failed = [];
      for (const [name, value] of Object.entries(secrets)) {
        let encrypted;
        try {
          encrypted = sealSecret(value, key.json.key);
        } catch (err) {
          failed.push(`${name}: ${err.message}`);
          continue;
        }
        const put = await gh('PUT', `${base}/actions/secrets/${name}`, {
          encrypted_value: encrypted,
          key_id: key.json.key_id,
        });
        if (!put.ok) failed.push(`${name}: ${explain(put, '“Secrets: read and write”')}`);
      }
      steps.push(failed.length === 0
        ? { id: 'secrets', ok: true, detail: `Stored ${Object.keys(secrets).join(' and ')}.` }
        : { id: 'secrets', ok: false, detail: failed.join(' ') });
    }
  }

  // ── workflow file ─────────────────────────────────────────────────────────
  if (workflow) {
    const filePath = workflow.path.split('/').map(encodeURIComponent).join('/');
    const existing = await gh('GET', `${base}/contents/${filePath}?ref=${encodeURIComponent(branch)}`);
    const wanted = Buffer.from(workflow.content, 'utf8').toString('base64');

    if (existing.ok && typeof existing.json?.content === 'string'
        && existing.json.content.replace(/\s/g, '') === wanted) {
      steps.push({ id: 'workflow', ok: true, detail: `${workflow.path} is already up to date.` });
    } else if (!existing.ok && existing.status !== 404) {
      steps.push({ id: 'workflow', ok: false, detail: explain(existing, '“Contents: read and write”') });
    } else {
      const put = await gh('PUT', `${base}/contents/${filePath}`, {
        message: existing.ok ? 'Update the Easy DevOps deploy workflow' : 'Add the Easy DevOps deploy workflow',
        content: wanted,
        branch,
        ...(existing.ok && existing.json?.sha ? { sha: existing.json.sha } : {}),
      });
      steps.push(put.ok
        ? { id: 'workflow', ok: true, detail: `Committed ${workflow.path} to ${branch}. That push starts the first deployment.` }
        : { id: 'workflow', ok: false, detail: explain(put, '“Contents: read and write” and “Workflows: read and write”') });
    }
  }

  // ── deploy key ────────────────────────────────────────────────────────────
  if (deployKey) {
    // Compare the key material only: GitHub drops the trailing comment.
    const material = deployKey.key.split(/\s+/).slice(0, 2).join(' ');
    const list = await gh('GET', `${base}/keys?per_page=100`);
    if (!list.ok) {
      steps.push({ id: 'deployKey', ok: false, detail: explain(list, '“Administration: read and write”') });
    } else if (Array.isArray(list.json) && list.json.some((k) => String(k.key ?? '').trim() === material)) {
      steps.push({ id: 'deployKey', ok: true, detail: 'The deploy key is already on the repository.' });
    } else {
      const add = await gh('POST', `${base}/keys`, { title: deployKey.title, key: deployKey.key, read_only: true });
      steps.push(add.ok
        ? { id: 'deployKey', ok: true, detail: 'Added the deploy key, read-only.' }
        : { id: 'deployKey', ok: false, detail: explain(add, '“Administration: read and write”') });
    }
  }

  return { ok: steps.length > 0 && steps.every((s) => s.ok), repo: full, error: null, steps };
}
