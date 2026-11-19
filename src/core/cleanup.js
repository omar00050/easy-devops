/**
 * core/cleanup.js
 *
 * Finding reclaimable files, and removing only the ones the caller names.
 *
 * ── Dry run first, always ──────────────────────────────────────────────────
 *
 * `scan()` deletes nothing and `apply()` acts only on ids it is handed. That
 * split is the whole safety model: there is no "clean everything" entry point
 * to call by accident, and the CLI prints the inventory with sizes before any
 * confirmation. A disk-reclaiming command that acts first and reports after is
 * one nobody can run twice with confidence.
 *
 * ── What is never listed ───────────────────────────────────────────────────
 *
 * Not "never deleted" — never LISTED, so it cannot be selected either:
 *
 *   - the database and its -wal / -shm siblings, and the settings in it
 *   - anything under the configured sslDir: certificates, keys, accounts
 *   - active nginx .conf files (only `.bak` copies beside them are offered)
 *   - the PINNED runtime, and the Node version it points at
 *   - the version manager's default alias
 *   - any Node version a PM2 app is running
 *   - `daemon.stop` — a stop request is not litter. It is what keeps a stopped
 *     service stopped until the next logon, so removing it would silently
 *     restart something the user stopped on purpose.
 *   - a live `daemon.lock` — only one whose owner is provably gone
 *
 * ── Why Node versions are listed but not selected ──────────────────────────
 *
 * Disk-wise they are the biggest item by far, and "unused" is a guess: a
 * version can be in a shell alias, a CI script, another project's .nvmrc, or a
 * PM2 app's recorded exec path. The ones we can prove are in use are excluded
 * outright; the rest are offered with the evidence, and the user chooses. The
 * default selection is empty.
 */

import fs from 'fs';
import path from 'path';

import { run } from './shell.js';
import { getDataDir, isWindows, programDataDir, quoteExe } from './platform.js';
import { loadConfig } from './config.js';
import { inspect as inspectLock, lockPath } from './daemon/lock.js';
import { claimDir, CLAIM_TTL_MS } from './notifications/claim.js';
import { runtimeDir, runtimeNodePath, inspectLink } from './service/runtime.js';
import { recordedState } from './service/index.js';
import * as runner from './runner.js';

/** Default age before an Easy DevOps log counts as reclaimable. */
export const DEFAULT_LOG_DAYS = 14;

/** The groups, in the order a report should present them. */
export const GROUPS = Object.freeze([
  'runtime-backups',
  'logs',
  'temp',
  'nginx-bak',
  'pm2-logs',
  'node-versions',
]);

// ─── Small filesystem helpers ────────────────────────────────────────────────

function sizeOf(target) {
  let total = 0;
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.size;

  let entries = [];
  try {
    entries = fs.readdirSync(target);
  } catch {
    return 0;
  }
  for (const entry of entries) total += sizeOf(path.join(target, entry));
  return total;
}

function ageDays(target, now) {
  try {
    return (now - fs.statSync(target).mtimeMs) / 86_400_000;
  } catch {
    return 0;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Human-readable bytes. ASCII only: these lines reach a Windows console. */
export function humanBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

// ─── Scanners ────────────────────────────────────────────────────────────────

/**
 * Old runtime backups.
 *
 * `node.exe.prev` is what `ezz runtime update` keeps so it can roll back, and
 * `<dataDir>.backup-*` is what the Server-mode data migration keeps. The NEWEST
 * of each kind is held back: it is the one an undo would need.
 */
function scanRuntimeBackups({ dataDir, now }) {
  const items = [];
  const dir = runtimeDir(dataDir);

  const prev = `${runtimeNodePath(dataDir)}.prev`;
  if (fs.existsSync(prev)) {
    items.push({
      group: 'runtime-backups',
      path: prev,
      bytes: sizeOf(prev),
      why: 'the runtime the service used before the last `ezz runtime update`',
      removable: true,
      keep: false,
    });
  }

  // Smoke-test directories, if a crashed run left one behind.
  const smoke = path.join(dir, 'smoke');
  if (fs.existsSync(smoke)) {
    items.push({
      group: 'runtime-backups',
      path: smoke,
      bytes: sizeOf(smoke),
      why: 'a leftover runtime smoke-test directory',
      removable: true,
      keep: false,
    });
  }

  // Data-directory backups, newest kept.
  const parent = path.dirname(dataDir);
  const base = `${path.basename(dataDir)}.backup-`;
  const backups = listDir(parent)
    .filter((e) => e.name.startsWith(base))
    .map((e) => {
      const full = path.join(parent, e.name);
      return { full, mtime: (() => { try { return fs.statSync(full).mtimeMs; } catch { return 0; } })() };
    })
    .sort((a, b) => b.mtime - a.mtime);

  backups.forEach((backup, index) => {
    items.push({
      group: 'runtime-backups',
      path: backup.full,
      bytes: sizeOf(backup.full),
      why: index === 0
        ? 'the most recent data-directory backup - kept, so the last move can still be undone'
        : `a data-directory backup from ${new Date(backup.mtime).toISOString().slice(0, 10)}`,
      removable: index !== 0,
      keep: index === 0,
      ageDays: Math.round(ageDays(backup.full, now)),
    });
  });

  return items;
}

/** Easy DevOps' own logs, older than `days`. */
function scanLogs({ dataDir, days, now }) {
  const items = [];

  const dirs = [path.join(dataDir, 'logs')];
  // Windows Server mode writes the service's logs under ProgramData.
  if (isWindows) dirs.push(path.join(programDataDir(), 'logs'));

  for (const dir of dirs) {
    for (const entry of listDir(dir)) {
      if (entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      const age = ageDays(full, now);
      if (age < days) continue;
      items.push({
        group: 'logs',
        path: full,
        bytes: sizeOf(full),
        why: `${Math.round(age)} days old`,
        removable: true,
        ageDays: Math.round(age),
      });
    }
  }

  // The Personal-mode supervisor's log lives in the data directory root and
  // grows for as long as the machine runs.
  const supervisor = path.join(dataDir, 'daemon-supervisor.log');
  if (fs.existsSync(supervisor)) {
    const age = ageDays(supervisor, now);
    if (age >= days) {
      items.push({
        group: 'logs',
        path: supervisor,
        bytes: sizeOf(supervisor),
        why: `the logon supervisor's log, ${Math.round(age)} days old`,
        removable: true,
        ageDays: Math.round(age),
      });
    }
  }

  return items;
}

/**
 * Temporary files, stale claims and a dead lock.
 *
 * The lock is the careful one: a lock file whose owner is still alive, or
 * whose heartbeat is fresh, is NOT litter — removing it would let a second
 * daemon start alongside the first. Only one that `inspect()` already
 * considers dead is offered.
 */
function scanTemp({ dataDir, now }) {
  const items = [];

  for (const entry of listDir(dataDir)) {
    if (entry.isDirectory()) continue;
    const name = entry.name;
    const full = path.join(dataDir, name);

    // Never: a stop request is a deliberate state, not a leftover.
    if (name === 'daemon.stop') continue;

    if (/\.tmp$/i.test(name) || /^\.ez-write-probe-/.test(name) || /^ez-runtime-probe-/.test(name)) {
      items.push({
        group: 'temp',
        path: full,
        bytes: sizeOf(full),
        why: 'a temporary file left behind by an interrupted write',
        removable: true,
      });
    }
  }

  // Stale notification claims: past the TTL means the owner crashed between
  // claiming and committing, and dispatch already treats them as reclaimable.
  for (const entry of listDir(claimDir(dataDir))) {
    if (!entry.name.endsWith('.claim')) continue;
    const full = path.join(claimDir(dataDir), entry.name);
    const ageMs = now - (() => { try { return fs.statSync(full).mtimeMs; } catch { return now; } })();
    if (ageMs < CLAIM_TTL_MS) continue;
    items.push({
      group: 'temp',
      path: full,
      bytes: sizeOf(full),
      why: `a notification claim ${Math.round(ageMs / 1000)}s old, past the ${Math.round(CLAIM_TTL_MS / 1000)}s timeout`,
      removable: true,
    });
  }

  const lock = inspectLock({ dataDir, now });
  if (lock.lock && !lock.running) {
    items.push({
      group: 'temp',
      path: lockPath(dataDir),
      bytes: sizeOf(lockPath(dataDir)),
      why: `a dead daemon lock (${lock.reason})`,
      removable: true,
    });
  }

  return items;
}

/** `.bak` copies nginx-apply leaves beside a config it rewrote. */
function scanNginxBak({ config, now }) {
  const items = [];
  const dir = config.nginxDir;
  if (!dir) return items;

  // Only where configs actually live, and only `.bak` - never a `.conf`.
  const candidates = [dir, path.join(dir, 'conf.d'), path.join(dir, 'sites-available'), path.join(dir, 'sites-enabled')];

  for (const base of candidates) {
    for (const entry of listDir(base)) {
      if (entry.isDirectory()) continue;
      if (!entry.name.endsWith('.bak')) continue;
      const full = path.join(base, entry.name);
      items.push({
        group: 'nginx-bak',
        path: full,
        bytes: sizeOf(full),
        why: `a backup of ${entry.name.replace(/\.bak$/, '')}, ${Math.round(ageDays(full, now))} days old`,
        removable: true,
        ageDays: Math.round(ageDays(full, now)),
      });
    }
  }

  return items;
}

/**
 * PM2's own logs, which only PM2 can safely truncate.
 *
 * The action is `pm2 flush`, not a delete: PM2 holds the files open, and on
 * Windows removing an open log leaves it writing to a handle with no name.
 * Listed only when PM2 is actually present AND its daemon is running, because
 * every pm2 command starts that daemon and a cleanup scan must not be what
 * brings one to life on a machine that does not use PM2.
 */
async function scanPm2Logs({ deps = {} }) {
  const items = [];
  const detect = deps.runnerDetect ?? runner.detect;
  const daemonUp = (deps.isDaemonRunning ?? runner.isDaemonRunning)();

  const pm2 = await detect({ probeVersion: false });
  if (!pm2.installed) return items;

  const home = (deps.pm2HomeDir ?? runner.pm2HomeDir)();
  const logs = home ? path.join(home, 'logs') : null;
  const bytes = logs ? sizeOf(logs) : 0;

  items.push({
    group: 'pm2-logs',
    path: logs ?? '(pm2 log directory)',
    bytes,
    why: daemonUp
      ? 'PM2 log files, truncated with `pm2 flush`'
      : 'PM2 log files - its daemon is not running, so flushing would start it',
    removable: daemonUp,
    action: 'pm2-flush',
    pm2Path: pm2.path ?? 'pm2',
  });

  return items;
}

/**
 * Installed Node versions, with the evidence for whether each is in use.
 *
 * Listed only. `removable` here means "nothing proved it is in use", which is
 * weaker than the other groups and is why the CLI defaults the selection to
 * nothing and prints the reason beside each one.
 */
async function scanNodeVersions({ dataDir, deps = {} }) {
  const exec = deps.run ?? run;
  const items = [];

  const installed = await (deps.listInstalledNode ?? listInstalledNode)({ deps });
  if (installed.versions.length === 0) return items;

  // Everything we can prove is in use.
  const pinnedPath = isWindows ? runtimeNodePath(dataDir) : inspectLink(dataDir).target;
  const recorded = (deps.recordedState ?? recordedState)().nodeExe ?? null;

  const pinnedVersions = new Set();
  for (const candidate of [pinnedPath, recorded]) {
    const version = candidate ? versionFromPath(candidate) : null;
    if (version) pinnedVersions.add(version);
  }

  // A pinned path that carries no version in it (a copy under ProgramData) is
  // asked directly, so a copied runtime still protects its source version.
  if (pinnedPath && fs.existsSync(pinnedPath) && pinnedVersions.size === 0) {
    const probe = await exec(`${quoteExe(pinnedPath)} --version`, { timeout: 15_000 });
    if (probe.success) pinnedVersions.add(probe.stdout.trim().replace(/^v/, ''));
  }

  const pm2Versions = await (deps.pm2NodeVersions ?? pm2NodeVersions)({ deps });

  for (const entry of installed.versions) {
    const reasons = [];
    if (pinnedVersions.has(entry.version)) reasons.push('the service is pinned to it');
    if (entry.isDefault) reasons.push(`it is ${installed.manager}'s default`);
    if (entry.isCurrent) reasons.push('it is the version your shell uses now');
    if (pm2Versions.has(entry.version)) reasons.push('a PM2 app runs it');

    items.push({
      group: 'node-versions',
      path: entry.path ?? `v${entry.version}`,
      version: entry.version,
      bytes: entry.path ? sizeOf(entry.path) : 0,
      why: reasons.length ? `in use: ${reasons.join('; ')}` : 'nothing on this machine refers to it',
      removable: reasons.length === 0,
      keep: reasons.length > 0,
      action: 'node-uninstall',
      manager: installed.manager,
    });
  }

  return items;
}

/** `.../v20.11.1/bin/node` -> `20.11.1` */
function versionFromPath(target) {
  return String(target).match(/v?(\d+\.\d+\.\d+)/)?.[1] ?? null;
}

/**
 * The Node versions a version manager has installed.
 *
 * @returns {Promise<{ manager: string|null, versions: Array<Object> }>}
 */
export async function listInstalledNode({ deps = {} } = {}) {
  const exec = deps.run ?? run;

  if (isWindows) {
    const listed = await exec('nvm list', { timeout: 30_000 });
    if (!listed.success || !/\d+\.\d+\.\d+/.test(listed.stdout)) {
      return { manager: null, versions: [] };
    }

    const root = await exec('nvm root', { timeout: 15_000 });
    const base = root.success ? (root.stdout.match(/:\s*(.+)$/m)?.[1] ?? '').trim() : '';

    const versions = [];
    for (const line of listed.stdout.split('\n')) {
      const m = line.match(/(\*?)\s*(\d+\.\d+\.\d+)/);
      if (!m) continue;
      const version = m[2];
      versions.push({
        version,
        isCurrent: m[1] === '*',
        // nvm-windows has no alias system, so "default" does not apply.
        isDefault: false,
        path: base ? path.join(base, `v${version}`) : null,
      });
    }
    return { manager: 'nvm-windows', versions };
  }

  const script = 'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; ';
  const listed = await exec(`${script}nvm ls --no-colors`, { timeout: 30_000 });
  if (!listed.success || !/\d+\.\d+\.\d+/.test(listed.stdout)) {
    return { manager: null, versions: [] };
  }

  // `nvm alias default` prints what default resolves to, which is the only
  // reliable way to know it: the `ls` output marks it inconsistently.
  const aliased = await exec(`${script}nvm alias default`, { timeout: 15_000 });
  const defaultVersion = aliased.success ? versionFromPath(aliased.stdout) : null;

  const versions = [];
  for (const line of listed.stdout.split('\n')) {
    const m = line.match(/(->)?\s*v(\d+\.\d+\.\d+)/);
    if (!m) continue;
    const version = m[2];
    if (versions.some((v) => v.version === version)) continue;
    versions.push({
      version,
      isCurrent: Boolean(m[1]),
      isDefault: defaultVersion === version,
      path: path.join(process.env.HOME ?? '', '.nvm', 'versions', 'node', `v${version}`),
    });
  }
  return { manager: 'nvm', versions };
}

/** Node versions that PM2 apps are running, read from their exec paths. */
export async function pm2NodeVersions({ deps = {} } = {}) {
  const found = new Set();

  // Never start the daemon to answer this.
  if (!(deps.isDaemonRunning ?? runner.isDaemonRunning)()) return found;

  const pm2 = await (deps.runnerDetect ?? runner.detect)({ probeVersion: false });
  if (!pm2.installed) return found;

  const listed = await (deps.runnerList ?? runner.list)({ pm2Path: pm2.path ?? 'pm2' });
  if (!listed.ok) return found;

  for (const app of listed.apps ?? []) {
    const version = app.execPath ? versionFromPath(app.execPath) : null;
    if (version) found.add(version);
  }
  return found;
}

// ─── The scan ────────────────────────────────────────────────────────────────

/**
 * Everything reclaimable, grouped, with sizes. Deletes nothing.
 *
 * @param {Object} [opts]
 * @param {number} [opts.days] Log age threshold
 * @returns {Promise<{ items: Array<Object>, groups: Object, totalBytes: number, days: number }>}
 */
export async function scan({
  dataDir = getDataDir(),
  days = DEFAULT_LOG_DAYS,
  now = Date.now(),
  config = loadConfig(),
  deps = {},
} = {}) {
  const items = [
    ...scanRuntimeBackups({ dataDir, now }),
    ...scanLogs({ dataDir, days, now }),
    ...scanTemp({ dataDir, now }),
    ...scanNginxBak({ config, now }),
    ...(await scanPm2Logs({ deps })),
    ...(await scanNodeVersions({ dataDir, deps })),
  ];

  // Stable ids, so a caller can select by id without the paths travelling
  // through a prompt and coming back altered.
  items.forEach((item, index) => { item.id = `${item.group}:${index}`; });

  const groups = {};
  for (const group of GROUPS) {
    const inGroup = items.filter((i) => i.group === group);
    groups[group] = {
      items: inGroup,
      bytes: inGroup.filter((i) => i.removable).reduce((sum, i) => sum + i.bytes, 0),
      count: inGroup.length,
      removable: inGroup.filter((i) => i.removable).length,
    };
  }

  return {
    items,
    groups,
    days,
    dataDir,
    // Only what could actually be freed: a kept item's size is not a saving.
    totalBytes: items.filter((i) => i.removable).reduce((sum, i) => sum + i.bytes, 0),
  };
}

// ─── Applying ────────────────────────────────────────────────────────────────

/**
 * Normalised form of an absolute path, for comparisons only.
 *
 * Separators are unified so a Windows path cannot dodge a check by being
 * written with forward slashes, and case is ignored on Windows where the
 * filesystem is. Never used to touch the filesystem.
 *
 * @param {string} target
 * @returns {string}
 */
function normalizeForCompare(target) {
  const forward = path.resolve(target).replace(/\\/g, '/');
  return isWindows ? forward.toLowerCase() : forward;
}

/**
 * True when `target` is one of `roots` or lives inside one.
 *
 * Segments, never string prefixes: `/data-evil` starts with `/data` but is not
 * inside it, and a prefix check would delete it.
 *
 * @param {string} root Real path of the root
 * @param {string} target Already a real path
 * @returns {boolean}
 */
function isInsideOrEqual(root, target) {
  const base = normalizeForCompare(root).replace(/\/+$/, '');
  const real = normalizeForCompare(target);
  if (!base) return false;
  return real === base || real.startsWith(`${base}/`);
}

/**
 * True when `target` lives strictly INSIDE one of `roots`.
 *
 * Equality is refused on purpose: an item whose real path IS a root is the
 * data directory, the nginx directory or the PM2 home, and `rmSync` with
 * `recursive` on one of those removes everything in it — the database
 * included. Only a path below a root may be deleted.
 *
 * @param {string[]} roots Real paths, as allowedRoots() returns them
 * @param {string} target Already a real path
 * @returns {boolean}
 */
function isInsideAny(roots, target) {
  const real = normalizeForCompare(target);

  return roots.some((root) => {
    const base = normalizeForCompare(root).replace(/\/+$/, '');
    if (!base) return false;
    return real !== base && real.startsWith(`${base}/`);
  });
}

/**
 * The directories `apply()` may delete inside.
 *
 * Exactly the places the scan reached, so an item id from anywhere else — a
 * stale report, a hand-edited file, a crafted API payload — cannot become an
 * arbitrary delete. Paths are resolved to their real form here so a symlinked
 * root is compared the same way the item's own real path is.
 *
 * @param {Object} opts
 * @returns {string[]}
 */
function allowedRoots({ dataDir, config, deps }) {
  const roots = [dataDir];

  // Windows Server mode writes the service's logs under ProgramData.
  if (isWindows) roots.push(path.join(programDataDir(), 'logs'));

  if (typeof config?.nginxDir === 'string' && config.nginxDir.trim()) {
    roots.push(config.nginxDir.trim());
  }

  // PM2's own log directory, for the `pm2 flush` action.
  try {
    const pm2Home = (deps.pm2HomeDir ?? runner.pm2HomeDir)();
    if (pm2Home) roots.push(pm2Home);
  } catch { /* PM2 is not installed */ }

  return roots
    .filter((root) => typeof root === 'string' && root.length > 0)
    .map((root) => {
      try {
        return fs.realpathSync(root);
      } catch {
        // A root that does not exist cannot contain a file that does; the
        // resolved form keeps the comparison honest all the same.
        return path.resolve(root);
      }
    });
}

/**
 * Whether an item is one of the `<dataDir>.backup-*` directories the scan
 * offers, which sit BESIDE the data directory rather than inside it.
 *
 * Matched by the exact name shape the scanner produces and by an equal parent,
 * never by a parent-directory prefix: a prefix would also admit everything
 * else the user keeps next to the data directory.
 *
 * @param {string} target Already a real path
 * @param {string} dataDir
 * @returns {boolean}
 */
function isDataDirBackupSibling(target, dataDir) {
  const parent = normalizeForCompare(path.dirname(path.resolve(dataDir)));
  if (normalizeForCompare(path.dirname(target)) !== parent) return false;

  const prefix = `${path.basename(path.resolve(dataDir))}.backup-`;
  const name = path.basename(target);
  return isWindows ? name.toLowerCase().startsWith(prefix.toLowerCase()) : name.startsWith(prefix);
}

/**
 * Why a path must never be removed, or null when it may be.
 *
 * Being inside a root is not enough. These live inside the very directories
 * the scan reads, and removing any of them breaks the installation rather
 * than reclaiming disk:
 *
 *   - the SQLite database and its `-wal` / `-shm` / `.migrated` siblings —
 *     inside the data directory, and offered by nothing, but a crafted item id
 *     naming one would otherwise pass the containment check;
 *   - anything under the configured sslDir (certificates, private keys, the
 *     ACME account key), including sslDir itself. The scan never lists these;
 *     apply() must refuse them even if it is handed one;
 *   - an active nginx config: a `.conf` file anywhere, and from the nginx
 *     directory only `.bak` copies (which is the only thing the scan offers
 *     there).
 *
 * @param {string} real Already a real path
 * @param {{ dataDir: string, config: Object }} opts
 * @returns {string|null} The reason to refuse, or null
 */
function protectedReason(real, { dataDir, config }) {
  const name = path.basename(real);

  // core/db.js keeps its database at <dataDir>/easy-devops.sqlite; the name is
  // matched by prefix so -wal, -shm and .migrated are covered by the same rule.
  if (normalizeForCompare(path.dirname(real)) === normalizeForCompare(dataDir)
    && name.toLowerCase().startsWith('easy-devops.sqlite')) {
    return 'the database and its side files are never removed';
  }

  const sslDir = typeof config?.sslDir === 'string' ? config.sslDir.trim() : '';
  if (sslDir && isInsideOrEqual(sslDir, real)) {
    return 'certificates and keys under the SSL directory are never removed';
  }

  if (/\.conf$/i.test(name)) {
    return 'an active nginx config (.conf) is never removed; only .bak copies are';
  }

  const nginxDir = typeof config?.nginxDir === 'string' ? config.nginxDir.trim() : '';
  if (nginxDir && isInsideOrEqual(nginxDir, real) && !/\.bak$/i.test(name)) {
    return 'only .bak copies may be removed from the nginx directory';
  }

  return null;
}

/**
 * Removes the given items, and nothing else.
 *
 * Each item carries its own action, so a caller never has to know that PM2
 * logs are flushed rather than deleted, or that a Node version is uninstalled
 * by its manager.
 *
 * Before deleting anything by path, the item's REAL path is checked against
 * the directories this scan covers. Ids come from a previous scan, but they
 * travel through a prompt and possibly an HTTP request, so they are re-checked
 * where it matters: a path that is not STRICTLY inside one of those roots —
 * including a symlink inside one that points outside, and including a root
 * itself — is refused and reported, not removed. Strictly, because a root is
 * the data directory, the nginx directory or the PM2 home, and removing one
 * recursively takes everything in it, the database included.
 *
 * Inside a root, the protected set is refused as well: the database and its
 * side files, anything under sslDir, and active nginx configs.
 *
 * The two actions that delete nothing here are unaffected: `pm2 flush` asks
 * PM2, and a Node version is removed by its manager from a version number, so
 * there is no path of ours to confine. The PM2 home is still one of the roots,
 * because that is a directory the scan reads and a future path-based PM2
 * removal must stay inside.
 *
 * @param {Object} opts
 * @param {Array<Object>} opts.items From scan()
 * @param {string} [opts.dataDir]
 * @param {Object} [opts.config]
 * @returns {Promise<{ removed: Array<Object>, failed: Array<Object>, freedBytes: number }>}
 */
export async function apply({
  items = [],
  log = () => {},
  deps = {},
  dataDir = getDataDir(),
  config = loadConfig(),
} = {}) {
  const exec = deps.run ?? run;
  const removed = [];
  const failed = [];
  const roots = allowedRoots({ dataDir, config, deps });

  for (const item of items) {
    // Defence in depth: an item the scan marked as keep must not be removable
    // even if a caller passes it in.
    if (item.keep || !item.removable) {
      failed.push({ ...item, reason: 'this item is kept on purpose and was not removed' });
      continue;
    }

    if (item.action === 'pm2-flush') {
      const flushed = await exec(`${item.pm2Path ?? 'pm2'} flush`, { timeout: 60_000 });
      flushed.success
        ? removed.push(item)
        : failed.push({ ...item, reason: (flushed.stderr || flushed.stdout || 'pm2 flush failed').trim().slice(0, 200) });
      log(`pm2 flush: ${flushed.success ? 'done' : 'failed'}`);
      continue;
    }

    if (item.action === 'node-uninstall') {
      const command = item.manager === 'nvm-windows'
        ? `nvm uninstall ${item.version}`
        : `export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; nvm uninstall ${item.version}`;
      const gone = await exec(command, { timeout: 300_000 });
      gone.success
        ? removed.push(item)
        : failed.push({ ...item, reason: (gone.stderr || gone.stdout || 'uninstall failed').trim().slice(0, 200) });
      log(`Node v${item.version}: ${gone.success ? 'uninstalled' : 'could not be uninstalled'}`);
      continue;
    }

    // The containment check is on the REAL path: a symlink inside a root that
    // points outside it must not become a delete outside it.
    let real;
    try {
      real = fs.realpathSync(item.path);
    } catch (err) {
      failed.push({ ...item, reason: `could not verify the path (${err.code ?? err.message}); nothing was removed` });
      continue;
    }

    if (!isInsideAny(roots, real) && !isDataDirBackupSibling(real, dataDir)) {
      failed.push({
        ...item,
        reason: 'refused: the path is outside the directories this cleanup covers',
      });
      log(`Refused ${item.path}: outside the directories this cleanup covers`);
      continue;
    }

    // Inside a root is necessary, not sufficient: the database, the
    // certificate store and live nginx configs live there too.
    const protectedBy = protectedReason(real, { dataDir, config });
    if (protectedBy) {
      failed.push({ ...item, reason: `refused: ${protectedBy}` });
      log(`Refused ${item.path}: ${protectedBy}`);
      continue;
    }

    try {
      // Removed by its own path, not the resolved one: a symlink is unlinked,
      // never followed to its target.
      fs.rmSync(item.path, { recursive: true, force: true });
      removed.push(item);
      log(`Removed ${item.path}`);
    } catch (err) {
      failed.push({ ...item, reason: err.message });
    }
  }

  return {
    removed,
    failed,
    freedBytes: removed.reduce((sum, i) => sum + (i.bytes ?? 0), 0),
  };
}
