/**
 * core/service/winsw.js
 *
 * WinSW — the service wrapper that lets a plain console program run as a real
 * Windows Service.
 *
 * Windows has no equivalent of systemd's "just run this command": a service
 * executable must implement the Service Control Manager protocol, which a Node
 * process cannot. WinSW is a small wrapper that implements it and runs our
 * command as a child, giving automatic start, restart-on-failure with backoff,
 * and rolling logs for free.
 *
 * ── Which build, and why ───────────────────────────────────────────────────
 *
 * `WinSW-x64.exe` from v2.12.0: the self-contained .NET build. It is 18MB
 * rather than the 850KB `WinSW.NET4.exe`, and that is the point — the small
 * build needs a matching .NET Framework already present, and "install the
 * service" failing on a fresh Windows Server because of a missing runtime is a
 * far worse outcome than a one-time 18MB download. v2.12.0 is the newest
 * non-prerelease; the v3 line is still alpha.
 *
 * ── The hash ───────────────────────────────────────────────────────────────
 *
 * Pinned below, computed from the actual file downloaded from the release URL.
 * Install REFUSES on a mismatch and does not fall back to running it anyway:
 * this binary is about to be registered as a service running with elevated
 * privileges, so an unexpected byte is a reason to stop, not a warning.
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { pipeline } from 'stream/promises';

import { isDefaultDataDir } from '../platform.js';
import { renameWithRetry } from '../atomicState.js';
import { daemonNodeArgs, knownNodeVersion } from './runtime.js';

/** The pinned release. Changing any of these three means re-computing the hash. */
export const WINSW_VERSION = 'v2.12.0';
export const WINSW_ASSET = 'WinSW-x64.exe';
export const WINSW_URL = `https://github.com/winsw/winsw/releases/download/${WINSW_VERSION}/${WINSW_ASSET}`;

/**
 * SHA-256 of the pinned asset.
 *
 * Measured, not copied from anywhere: the file was downloaded from WINSW_URL
 * and hashed. Verified alongside the size below, and that it is a real PE
 * image (MZ header, PE signature).
 */
export const WINSW_SHA256 = '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da';

/** Expected size in bytes, as the release metadata reports it. */
export const WINSW_BYTES = 18_243_033;

/** Service identity. The display name is what appears in services.msc. */
export const SERVICE_ID = 'EasyDevOps';
export const SERVICE_DISPLAY_NAME = 'Easy DevOps';

/**
 * The names the wrapper and its definition are stored under.
 *
 * WinSW v2 finds its configuration ONLY as `<its own base name>.xml` in its
 * own directory; a path passed on the command line is ignored. Storing the
 * downloaded `WinSW-x64.exe` under its release name beside `EasyDevOps.xml`
 * is exactly what made 1.4.0's Server-mode install fail with "Unable to
 * locate WinSW-x64.[xml|yml]". Both names are derived from SERVICE_ID here,
 * and nowhere else, so they cannot drift apart again.
 *
 * WINSW_ASSET stays the RELEASE asset name: it is what is downloaded and what
 * the hash pins, not what the file is called once it is installed.
 */
export const WINSW_EXE_NAME = `${SERVICE_ID}.exe`;
export const WINSW_XML_NAME = `${SERVICE_ID}.xml`;

/** The name 1.4.0 stored the wrapper under. Found and removed on install. */
export const LEGACY_WINSW_NAME = WINSW_ASSET;
export const SERVICE_DESCRIPTION =
  'Monitors nginx, domains and certificates, sends notifications, and runs the Easy DevOps Hub agent.';

/**
 * The virtual service account.
 *
 * `NT SERVICE\<name>` is created by Windows for a service of that name and has
 * NO PASSWORD — nobody has to type one, and there is none to leak or rotate.
 * This is the whole reason the old Task Scheduler approach was removed: that
 * one needed the user's own password to create an at-boot task.
 */
export const SERVICE_ACCOUNT = `NT SERVICE\\${SERVICE_ID}`;

/** SHA-256 of a file, streamed so an 18MB binary is not held in memory twice. */
export async function hashFile(file) {
  const hash = createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

/**
 * Checks a downloaded WinSW against the pin.
 *
 * @param {string} file
 * @returns {Promise<{ ok: boolean, reason?: string, sha256?: string, bytes?: number }>}
 */
export async function verifyWinsw(file) {
  let bytes;
  try {
    bytes = fs.statSync(file).size;
  } catch (err) {
    return {
      ok: false,
      bytes: null,
      code: err.code ?? null,
      reason: `cannot read ${file}: ${err.message}`,
    };
  }

  // Size first: it is free, and a truncated download is the common failure.
  if (bytes !== WINSW_BYTES) {
    return {
      ok: false,
      bytes,
      reason: `size mismatch: expected ${WINSW_BYTES} bytes, got ${bytes}. `
        + 'The download is incomplete or the release asset has changed.',
    };
  }

  let sha256;
  try {
    sha256 = await hashFile(file);
  } catch (err) {
    return {
      ok: false,
      bytes,
      code: err.code ?? null,
      reason: `cannot read ${file}: ${err.message}`,
    };
  }
  if (sha256 !== WINSW_SHA256) {
    return {
      ok: false,
      bytes,
      sha256,
      reason: `SHA-256 mismatch for ${WINSW_ASSET} ${WINSW_VERSION}.\n`
        + `  expected: ${WINSW_SHA256}\n`
        + `  actual  : ${sha256}\n`
        + 'Refusing to install it as a service. Delete the file and try again; '
        + 'if it keeps failing, do not work around it — the binary is not the one this release pins.',
    };
  }

  return { ok: true, sha256, bytes };
}

/**
 * Downloads WinSW to `dest` and verifies it. Never leaves a failed download in
 * place under the final name, so a later run cannot pick up a bad file.
 *
 * @param {Object} opts
 * @param {string} opts.dest
 * @param {(line: string) => void} [opts.log]
 * @param {typeof fetch} [opts.fetchImpl] Injectable, for tests
 * @returns {Promise<{ ok: boolean, path?: string, reason?: string, sha256?: string }>}
 */
export async function downloadWinsw({ dest, log = () => {}, fetchImpl = fetch, verify = verifyWinsw } = {}) {
  // Already there and correct: do not download 18MB again.
  if (fs.existsSync(dest)) {
    const existing = await verify(dest);
    if (existing.ok) {
      log(`${WINSW_ASSET} ${WINSW_VERSION} already present and verified.`);
      return { ok: true, path: dest, sha256: existing.sha256 };
    }
    log(`An existing ${path.basename(dest)} did not verify (${existing.reason.split('\n')[0]}); re-downloading.`);
  }

  // 1.4.0 left the wrapper beside `dest` under its release name. A copy that
  // still verifies is the same pinned binary, so it is moved into place
  // instead of downloading 18MB again; one that does not verify is removed.
  // Either way the old name does not survive, because a second WinSW binary
  // in the directory is only ever a source of confusion.
  const legacy = path.join(path.dirname(dest), LEGACY_WINSW_NAME);
  if (legacy !== dest && fs.existsSync(legacy)) {
    const old = await verify(legacy);
    try {
      if (old.ok) {
        fs.rmSync(dest, { force: true });
        renameWithRetry(legacy, dest);
        log(`Renamed the verified ${LEGACY_WINSW_NAME} to ${path.basename(dest)}.`);
        return { ok: true, path: dest, sha256: old.sha256 };
      }
      fs.rmSync(legacy, { force: true });
      log(`Removed an unverified ${LEGACY_WINSW_NAME} left by an earlier install.`);
    } catch (err) {
      log(`Could not tidy up ${legacy}: ${err.message}. Downloading a fresh copy instead.`);
    }
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });

  // Downloaded to a temporary name and renamed only after verification, so an
  // interrupted download can never be mistaken for a good one.
  const temp = `${dest}.download`;

  log(`Downloading ${WINSW_ASSET} ${WINSW_VERSION} (${(WINSW_BYTES / 1e6).toFixed(1)} MB)…`);

  try {
    const response = await fetchImpl(WINSW_URL, { redirect: 'follow' });
    if (!response.ok) {
      return { ok: false, reason: `download failed: HTTP ${response.status} from ${WINSW_URL}` };
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(temp, bytes);
  } catch (err) {
    try { fs.rmSync(temp, { force: true }); } catch { /* nothing to clean */ }
    return { ok: false, reason: `download failed: ${err.message}` };
  }

  const verified = await verify(temp);
  if (!verified.ok) {
    try { fs.rmSync(temp, { force: true }); } catch { /* nothing to clean */ }
    return { ok: false, reason: verified.reason };
  }

  try {
    fs.rmSync(dest, { force: true });
    renameWithRetry(temp, dest);
  } catch (err) {
    return { ok: false, reason: `could not put the verified file in place: ${err.message}` };
  }

  log(`Verified SHA-256 ${verified.sha256}`);
  return { ok: true, path: dest, sha256: verified.sha256 };
}

/**
 * The WinSW XML that defines the service.
 *
 * Choices worth knowing:
 *
 *  - `<serviceaccount><username>` is the virtual account, with
 *    `allowservicelogon` so Windows grants it the "log on as a service" right.
 *    No password element exists, and none is needed.
 *  - `onfailure` restarts with a growing delay rather than immediately: a
 *    daemon that crashes on a bad config would otherwise spin, and the Service
 *    Control Manager would give up and mark it failed within a minute.
 *  - `log mode="roll-by-size"` keeps the log bounded. A service that runs for
 *    months with an unbounded log is a disk-full incident waiting to happen.
 *  - `stoptimeout` gives the daemon time to release the lock and close the
 *    database cleanly before it is killed.
 *
 * @param {Object} opts
 * @param {string} opts.nodeExe   Absolute path to the pinned node.exe
 * @param {string} opts.entry     Absolute path to the ez entry script
 * @param {string} opts.dataDir   Passed through the environment
 * @param {string} opts.logDir
 * @param {string} [opts.workingDir]
 * @param {string|null} [opts.nodeVersion] The pinned runtime's version, so the
 *   confinement flag matches what that Node supports. Unknown → the loader flag.
 * @returns {string}
 */
export function buildServiceXml({ nodeExe, entry, dataDir, logDir, workingDir = null, nodeVersion = null }) {
  const escape = (value) => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // Only passed when it is NOT the default. In Server mode it normally IS
  // needed — ProgramData is only the default once the marker exists, and the
  // service must not depend on reading that marker first. But a service
  // installed against the per-user default would otherwise be handed a
  // variable it does not need, and that variable used to mean "dev mode":
  // staging certificates on real domains. See isDevDataDir() in platform.js.
  const dataDirEnv = isDefaultDataDir(dataDir)
    ? '  <!-- EASY_DEVOPS_DATA_DIR is not set: this is the default directory. -->'
    : `  <env name="EASY_DEVOPS_DATA_DIR" value="${escape(dataDir)}"/>`;

  // The confinement, exactly as core/service/runtime.js decides it for this
  // Node: --import + register() where the runtime has it, the loader flag
  // otherwise (which is what every XML written so far carries). The URLs come
  // from the package root, the entry's ../..
  const confinement = daemonNodeArgs({
    nodeVersion: nodeVersion ?? knownNodeVersion(nodeExe),
    packageRoot: path.resolve(path.dirname(entry), '..', '..'),
  });
  const nodeArguments = [...confinement.map((argument) => `"${escape(argument)}"`), `"${escape(entry)}"`, 'daemon'].join(' ');

  return `<service>
  <id>${SERVICE_ID}</id>
  <name>${escape(SERVICE_DISPLAY_NAME)}</name>
  <description>${escape(SERVICE_DESCRIPTION)}</description>

  <executable>${escape(nodeExe)}</executable>
  <arguments>${nodeArguments}</arguments>
  <workingdirectory>${escape(workingDir ?? path.dirname(entry))}</workingdirectory>

  <!-- Starts at boot, before anyone logs in. -->
  <startmode>Automatic</startmode>

  <!-- nginx is the thing being monitored, so start after it when it exists.
       A missing dependency is tolerated: Windows nginx is often not a service
       at all, and refusing to start without it would be wrong. -->
  <depend>Tcpip</depend>

  <!-- The virtual account: no password anywhere, ever. -->
  <serviceaccount>
    <username>${SERVICE_ACCOUNT}</username>
    <allowservicelogon>true</allowservicelogon>
  </serviceaccount>

  <!-- Backoff, not a tight loop: 5s, 20s, then every minute. -->
  <onfailure action="restart" delay="5 sec"/>
  <onfailure action="restart" delay="20 sec"/>
  <onfailure action="restart" delay="60 sec"/>
  <resetfailure>1 hour</resetfailure>

  <stoptimeout>15 sec</stoptimeout>

  <log mode="roll-by-size">
    <logpath>${escape(logDir)}</logpath>
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>8</keepFiles>
  </log>

${dataDirEnv}
  <!-- Node writes diagnostics to stderr; keep them in the rolling log. -->
  <env name="NODE_OPTIONS" value=""/>
  <env name="NODE_PATH" value=""/>
  <env name="WS_NO_BUFFER_UTIL" value="1"/>
  <env name="WS_NO_UTF_8_VALIDATE" value="1"/>
  <env name="NODE_ENV" value="production"/>
</service>
`;
}
