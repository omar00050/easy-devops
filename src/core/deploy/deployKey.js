/**
 * core/deploy/deployKey.js
 *
 * The SSH deploy key an app fetches its repository with: generating it,
 * replacing it, and proving it works.
 *
 * Three rules hold everywhere in this file:
 *
 *   1. The private key goes to exactly one place, `<app dir>/id_deploy`, with
 *      owner-only permissions. No function returns it, logs it or puts it in
 *      the registry; callers only ever see the public key and its fingerprint.
 *   2. GitHub's host keys are PINNED. The connection test (and every fetch from
 *      github.com, see sshCommand()) checks the server against the keys GitHub
 *      publishes, with StrictHostKeyChecking=yes. Never accept-new: trusting
 *      whatever answers first is exactly when an interception would succeed.
 *   3. Nothing here prompts. ssh runs with BatchMode, git with
 *      GIT_TERMINAL_PROMPT=0, so a missing key is an error, never a hang.
 *
 * The key is ed25519, written in the openssh-key-v1 format by hand: Node can
 * generate the pair, but only exports PKCS#8 for ed25519, which OpenSSH builds
 * do not all read. Generating in-process also means no dependency on
 * `ssh-keygen` being installed.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { run as shellRun } from '../shell.js';
import { getApp, isSshUrl, setDeployKeyRecord } from './apps.js';
import { appPaths, ensureAppDirs } from './store.js';

// ─── GitHub's host keys ───────────────────────────────────────────────────────

/**
 * GitHub's SSH host keys, as published at https://api.github.com/meta
 * (`ssh_keys`) and in GitHub's docs, "GitHub's SSH key fingerprints".
 * Checked 2026-11-18. If GitHub rotates a key, update it here; the e2e suite
 * checks each key against the fingerprint GitHub publishes for it.
 */
export const GITHUB_HOST_KEYS = Object.freeze([
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl',
  'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=',
  'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=',
]);

/** The fingerprints GitHub publishes for the keys above (`ssh_key_fingerprints`). */
export const GITHUB_HOST_FINGERPRINTS = Object.freeze({
  'ssh-ed25519': 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU',
  'ecdsa-sha2-nistp256': 'SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM',
  'ssh-rsa': 'SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s',
});

/** The known_hosts lines for github.com, built from GITHUB_HOST_KEYS. */
export function githubKnownHosts() {
  return GITHUB_HOST_KEYS.map((key) => `github.com ${key}`).join('\n') + '\n';
}

// ─── Encoding ─────────────────────────────────────────────────────────────────

/** SSH wire encoding of a length-prefixed byte string. */
function sshString(buf) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length);
  return Buffer.concat([len, buf]);
}

function uint32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}

/**
 * The OpenSSH fingerprint of a public key line or blob: `SHA256:` and the
 * unpadded base64 of the blob's SHA-256, as `ssh-keygen -lf` prints it.
 *
 * @param {string|Buffer} key "type base64 [comment]" or the raw blob
 */
export function fingerprintOf(key) {
  const blob = Buffer.isBuffer(key) ? key : Buffer.from(String(key).trim().split(/\s+/)[1] ?? '', 'base64');
  return `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

/**
 * A new ed25519 pair: the public key line and the openssh-key-v1 private key.
 * Exported for the test suite, which checks the format; nothing else should
 * need the private half outside this module.
 *
 * @param {string} comment
 * @returns {{ publicKey: string, fingerprint: string, privateKey: Buffer }}
 */
export function createEd25519Pair(comment) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url');

  const type = Buffer.from('ssh-ed25519');
  const pubBlob = Buffer.concat([sshString(type), sshString(pub)]);

  // The private section: two equal check integers, the key, the comment, then
  // padding 1, 2, 3, … up to a multiple of the cipher block size (8 for none).
  const check = crypto.randomBytes(4);
  let section = Buffer.concat([
    check, check,
    sshString(type),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(Buffer.from(comment)),
  ]);
  const pad = (8 - (section.length % 8)) % 8;
  section = Buffer.concat([section, Buffer.from(Array.from({ length: pad }, (_, i) => i + 1))]);

  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0'),
    sshString(Buffer.from('none')), // cipher
    sshString(Buffer.from('none')), // kdf
    sshString(Buffer.alloc(0)),     // kdf options
    uint32(1),                      // one key
    sshString(pubBlob),
    sshString(section),
  ]);
  const b64 = body.toString('base64').replace(/.{1,70}/g, '$&\n');
  const pem = Buffer.from(`-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}-----END OPENSSH PRIVATE KEY-----\n`);

  seed.fill(0);
  section.fill(0);
  body.fill(0);

  return {
    publicKey: `ssh-ed25519 ${pubBlob.toString('base64')} ${comment}`,
    fingerprint: fingerprintOf(pubBlob),
    privateKey: pem,
  };
}

// ─── Generating and replacing ─────────────────────────────────────────────────

/**
 * Generates the app's deploy key, replacing any previous one.
 *
 * The private key is written to a temporary file with mode 600 and renamed
 * over `id_deploy`, so a deployment reading the key never sees half a file.
 * Replacing it is what invalidates the old key on this server: the old private
 * half is gone. GitHub still lists the old PUBLIC key until someone removes it,
 * which is why the previous fingerprint is returned — the UI says so.
 *
 * @param {string} id
 * @param {{ now?: () => Date }} [opts]
 * @returns {{ publicKey: string, fingerprint: string, createdAt: string,
 *   previousFingerprint: string|null } | null} null when the app does not exist
 */
export function generateDeployKey(id, { now = () => new Date() } = {}) {
  const app = getApp(id);
  if (!app) return null;

  const previousFingerprint = app.auth?.keyFingerprint
    ?? (app.auth?.publicKey ? fingerprintOf(app.auth.publicKey) : null);

  const pair = createEd25519Pair(`easy-devops-deploy-${id}`);
  const p = ensureAppDirs(id);
  const tmp = `${p.deployKey}.${process.pid}.tmp`;
  try {
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(tmp, pair.privateKey, { mode: 0o600, flag: 'wx' });
    try { fs.chmodSync(tmp, 0o600); } catch { /* no POSIX modes on Windows; the data dir's ACL applies */ }
    fs.renameSync(tmp, p.deployKey);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`Could not write the deploy key in ${p.root}: ${err.code ?? err.message}. Check that this folder is writable by the user Easy DevOps runs as.`);
  } finally {
    pair.privateKey.fill(0);
  }

  const createdAt = now().toISOString();
  setDeployKeyRecord(id, { publicKey: pair.publicKey, fingerprint: pair.fingerprint, createdAt });
  return { publicKey: pair.publicKey, fingerprint: pair.fingerprint, createdAt, previousFingerprint };
}

/**
 * What may be shown about an app's key: never the private half.
 * @returns {{ publicKey: string|null, fingerprint: string|null, createdAt: string|null, onDisk: boolean }}
 */
export function describeDeployKey(app) {
  const publicKey = app?.auth?.publicKey ?? null;
  let onDisk = false;
  try { onDisk = Boolean(app) && fs.statSync(appPaths(app.id).deployKey).isFile(); } catch { /* none */ }
  return {
    publicKey,
    fingerprint: app?.auth?.keyFingerprint ?? (publicKey ? fingerprintOf(publicKey) : null),
    createdAt: app?.auth?.keyCreatedAt ?? null,
    onDisk,
  };
}

// ─── Using the key ────────────────────────────────────────────────────────────

/** github.com over SSH, in either URL form. Strict on purpose: the result is put in a command line. */
const GITHUB_SSH_URL =
  /^(?:ssh:\/\/[A-Za-z0-9._-]+@github\.com(?::22)?\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|[A-Za-z0-9._-]+@github\.com:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/i;

/**
 * How long the connection test waits. Below the Hub's 15-second quick-command
 * window, so a slow GitHub is reported as itself, not as an agent timeout.
 */
const LS_REMOTE_TIMEOUT_MS = 12000;

/** True when the URL reaches github.com over SSH, so its host keys can be pinned. */
export function isGithubSshUrl(url) {
  return GITHUB_SSH_URL.test(String(url ?? ''));
}

/** Characters that could end a quoted path inside GIT_SSH_COMMAND, which git runs through sh. */
const UNSAFE_PATH = /["`$\\\n\r]/;

/**
 * The GIT_SSH_COMMAND for an app's key, or null when the key is missing.
 *
 * For github.com the host keys are pinned (StrictHostKeyChecking=yes against a
 * known_hosts file this module writes). Other hosts keep the engine's earlier
 * behaviour, accept-new, because there are no published keys to pin to; the
 * connection test refuses them instead of pretending to verify them.
 *
 * @param {string} id
 * @param {string} repoUrl
 * @returns {string|null}
 */
export function sshCommand(id, repoUrl) {
  const p = appPaths(id);
  if (!fs.existsSync(p.deployKey)) return null;
  // Forward slashes: git runs this through its own sh, where a backslash in a
  // Windows path would be read as an escape.
  const keyArg = p.deployKey.replace(/\\/g, '/');
  if (UNSAFE_PATH.test(keyArg)) {
    throw new Error(`The app folder path contains a character ssh cannot be given safely: ${p.root}. Move the app to a plain path.`);
  }
  const base = `ssh -i "${keyArg}" -o IdentitiesOnly=yes -o BatchMode=yes`;
  if (!isGithubSshUrl(repoUrl)) return `${base} -o StrictHostKeyChecking=accept-new`;

  const knownHosts = path.join(p.root, 'known_hosts');
  fs.writeFileSync(knownHosts, githubKnownHosts(), { mode: 0o644 });
  const hostsArg = knownHosts.replace(/\\/g, '/');
  return `${base} -o StrictHostKeyChecking=yes -o CheckHostIP=no -o UserKnownHostsFile="${hostsArg}"`;
}

/**
 * Turns ssh/git's stderr into the reason and the next step, in that order.
 * Unknown output falls through to its own last lines.
 */
export function explainLsRemoteFailure(stderr, timedOut) {
  const text = String(stderr ?? '');
  if (timedOut) {
    return 'GitHub did not answer within 12 seconds. Check that this server can reach github.com on port 22 (a firewall may block outgoing SSH), then test again.';
  }
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|host key .* (?:mismatch|differs)/i.test(text)) {
    return 'The server answering as github.com did not present GitHub\'s published host key, so the connection was refused. Something between this server and GitHub may be intercepting SSH; do not deploy until this is explained.';
  }
  if (/Permission denied \(publickey/i.test(text)) {
    return 'GitHub rejected the key. Add the public key to the repository as a deploy key (Settings → Deploy keys → Add deploy key, read access is enough), then test again.';
  }
  if (/Repository not found|does not appear to be a git repository|Could not read from remote repository/i.test(text)) {
    return 'GitHub accepted the connection but this key cannot read that repository. Check the repository URL, and that the key was added to THIS repository (deploy keys belong to one repository).';
  }
  if (/Could not resolve hostname|Name or service not known|Temporary failure in name resolution/i.test(text)) {
    return 'This server could not resolve github.com. Check its DNS settings, then test again.';
  }
  if (/Connection (?:refused|timed out)|Network is unreachable|No route to host/i.test(text)) {
    return 'This server could not open a connection to github.com on port 22. Allow outgoing SSH in the firewall, then test again.';
  }
  if (/(?:ssh|git)[^\n]*(?:not found|not recognized|No such file)/i.test(text)) {
    return 'git or ssh is not installed or not on PATH for the user Easy DevOps runs as. Install Git (it includes ssh), then test again.';
  }
  const tail = text.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 400);
  return tail ? `git ls-remote failed: ${tail}` : 'git ls-remote failed without saying why.';
}

/**
 * "Test connection": `git ls-remote` with the app's key against its repository,
 * with GitHub's host keys pinned.
 *
 * @param {string} id
 * @param {{ run?: typeof shellRun }} [deps] Injected runner (testing only)
 * @returns {Promise<{ ok: boolean, status: number, error: string|null,
 *   detail?: string, branchFound?: boolean|null, fingerprint?: string|null }>}
 */
export async function testDeployKey(id, { run = shellRun } = {}) {
  const app = getApp(id);
  if (!app) return { ok: false, status: 404, error: `No app named "${id}".` };

  if (!isSshUrl(app.repoUrl)) {
    return { ok: false, status: 400, error: 'A deploy key needs an SSH repository URL (git@github.com:owner/repo.git).' };
  }
  if (!isGithubSshUrl(app.repoUrl)) {
    return {
      ok: false,
      status: 400,
      error: 'The connection test pins GitHub\'s published host keys, so it only tests github.com repositories. For another host, deploy once and read the fetch step.',
    };
  }

  let sshCmd;
  try {
    sshCmd = sshCommand(id, app.repoUrl);
  } catch (err) {
    return { ok: false, status: 500, error: err.message };
  }
  if (!sshCmd) return { ok: false, status: 409, error: 'This app has no deploy key yet. Generate one first.' };

  const result = await run(`git ls-remote --heads "${app.repoUrl}"`, {
    timeout: LS_REMOTE_TIMEOUT_MS,
    env: { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: sshCmd },
  });
  const fingerprint = describeDeployKey(app).fingerprint;

  if (!result.success) {
    return {
      ok: false,
      status: 200,
      error: explainLsRemoteFailure(result.stderr, result.exitCode === null),
      fingerprint,
    };
  }

  const heads = String(result.stdout ?? '').split(/\r?\n/).filter((l) => /\trefs\/heads\//.test(l));
  const branch = app.branch ? `refs/heads/${app.branch}` : null;
  const branchFound = branch ? heads.some((l) => l.endsWith(`\t${branch}`)) : null;
  const detail = branchFound === false
    ? `Connected. The key can read the repository, but it has no branch "${app.branch}". Check the branch name before deploying.`
    : `Connected. The key can read the repository${branch ? ` and its branch "${app.branch}"` : ''}.`;
  return { ok: true, status: 200, error: null, detail, branchFound, fingerprint };
}
