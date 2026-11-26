/**
 * core/service/systemd.js
 *
 * The Linux service: a systemd unit that runs `ezz daemon`.
 *
 * ── Why the unit runs as the invoking user, not root ───────────────────────
 *
 * The daemon writes to `~/.config/easy-devops` and reads the user's nginx
 * configuration. Running it as root would put root-owned files in the user's
 * data directory, which then breaks every subsequent `ezz` command run
 * normally — a failure that looks like corruption rather than a permission
 * problem. `User=` is the invoking user for that reason, and it is also the
 * least privilege that works: nginx control already goes through `sudo -n`
 * with specific sudoers rules, so the daemon does not need to be root to
 * reload nginx.
 *
 * ── Why the unit is GENERATED, never edited ────────────────────────────────
 *
 * The unit is built from the data in `unitSections()` and serialized by
 * `serializeUnit()`, in one place, every time. Nothing inserts a line into an
 * existing file. 1.4.4-1.4.6 did insert: they searched for the literal text
 * `[Service]`, found it inside an explanatory comment in `[Unit]`, and wrote
 * `Environment=` assignments into that comment —
 *
 *   Environment=WS_NO_BUFFER_UTIL=1: systemd moved them in v229 and still
 *
 * which systemd treats as a comment, so the protections were silently not
 * applied. A repair that added them again added a duplicate every time. A
 * template cannot make that mistake: comments are whole lines, a comment may
 * not contain a `Key=value` pattern, and the serializer refuses to emit one
 * that does.
 *
 * ── Why sudo is asked for by sudo ──────────────────────────────────────────
 *
 * Writing to `/etc/systemd/system` needs root. A normal user's command goes out
 * as `sudo install …` / `sudo systemctl …` with argv (never a shell string for
 * the privileged part), so sudo prompts on the user's own terminal and the
 * password never passes through this process. Nothing here ever reads, stores,
 * or asks for a password itself.
 *
 * **A root install is not wrapped at all.** uid 0 already has the privilege,
 * and a minimal server may have no sudo installed — `sudo systemctl` there
 * fails with ENOENT and `ezz update` could never stop or start the service.
 * Every privileged call goes through `serviceAccess()`, which is the one place
 * that decides: root runs it directly, everyone else through sudo.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { run, runFile, runInteractive } from '../shell.js';
import { getDataDir, isDefaultDataDir } from '../platform.js';
import { renameWithRetry } from '../atomicState.js';
import { clearStopRequest, readStopRequest, stopRequestPath } from '../daemon/stopRequest.js';
import { daemonNodeArgs, linkRuntime, readNodeVersion, runtimeNodePath } from './runtime.js';

/** Unit name and path. One unit, one name, no per-user variants. */
export const UNIT_NAME = 'easy-devops.service';
export const UNIT_PATH = `/etc/systemd/system/${UNIT_NAME}`;

/** How long to wait for the daemon's heartbeat after starting the service. */
export const STARTUP_GRACE_MS = 10_000;

/**
 * How long a recovery waits for the heartbeat.
 *
 * Longer than a plain status wait: recovery is the command someone runs when
 * the service is already broken, and the first start of a freshly pinned
 * runtime is routinely slow. Giving up at ten seconds would report failure for
 * a daemon that reports in at twelve.
 */
export const RECOVER_STARTUP_GRACE_MS = 45_000;

/**
 * The `ezz` entry script, resolved from this file rather than from `cwd`.
 *
 * A unit records an absolute path, so it has to be the installed package's own
 * location — `process.argv[1]` would be whatever shim the user invoked.
 */
const ENTRY_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'index.js');

/**
 * The package root for an entry script, used as the unit's WorkingDirectory.
 *
 * The entry is `<root>/src/cli/index.js`, so the directory containing it is
 * two levels below the root. Using `dirname(entry)` would set the working
 * directory to `src/cli`, where a relative path such as `package.json` does
 * not resolve.
 *
 * @param {string} entry
 * @returns {string}
 */
export function packageRootFor(entry) {
  // `path.posix`, not `path`: every path in a systemd unit is a Linux path,
  // and the platform-sensitive `path` would rewrite one with a drive letter
  // when this runs anywhere else — which is exactly what made this testable
  // only on Linux before. It also means no `path.resolve`, which consults the
  // host's cwd.
  const dir = path.posix.dirname(entry);

  // Only climb when the layout is the one we ship. Anything else is left alone
  // rather than guessed at.
  if (path.posix.basename(dir) === 'cli' && path.posix.basename(path.posix.dirname(dir)) === 'src') {
    return path.posix.dirname(path.posix.dirname(dir));
  }
  return dir;
}

/** Whether this machine has systemd at all. */
export async function hasSystemd({ runner = run } = {}) {
  // The directory is the cheapest reliable signal; `systemctl --version` also
  // exists on machines where systemd is installed but not the init system,
  // which is exactly the case that must not be treated as supported.
  if (!fs.existsSync('/run/systemd/system')) return false;

  // A version query asks the manager nothing privileged, so it never elevates.
  const probe = await serviceAccess({ runner }).read('systemctl --version', { timeout: 10_000 });
  return probe.success;
}

// ─── The unit, as data ───────────────────────────────────────────────────────

/**
 * Escapes one value for a systemd assignment.
 *
 * systemd expands `%` specifiers and `$` variables in most values, so both are
 * doubled. Anything outside the conservative safe set is quoted, which is the
 * form systemd parses as a single argument.
 *
 * @param {string} value
 * @returns {string}
 */
function unitArg(value) {
  if (/[\r\n\0]/.test(value)) throw new Error('Invalid systemd argument');
  const escaped = String(value).replaceAll('%', '%%').replaceAll('$', '$$');
  return /^[=a-zA-Z0-9_./:-]+$/.test(escaped) ? escaped : JSON.stringify(escaped);
}

/** Keys systemd accepts more than once in one section. */
const REPEATABLE_KEYS = new Set([
  'Environment', 'EnvironmentFile', 'ExecStartPre', 'ExecStartPost', 'ExecStart', 'ExecStop',
  'ExecReload', 'After', 'Before', 'Wants', 'Requires', 'Documentation', 'ReadWritePaths',
]);

/** systemd directive names are a letter followed by letters and digits. */
const UNIT_KEY_RE = /^[A-Za-z][A-Za-z0-9]*$/;

/** A `Key=value` pattern, which must never appear in a comment line. */
const KEY_VALUE_RE = /(^|[^A-Za-z0-9_])[A-Za-z][A-Za-z0-9]*=/;

/**
 * Resource and scheduling settings an operator may have tuned by hand.
 *
 * Only these are carried over from an installed unit, and only from its
 * `[Service]` section: they are the knobs a deployment with many domains
 * raises (open files, tasks, memory, scheduling), and a repair that silently
 * reset one of them would break a working server.
 */
const TUNING_KEY_RE = /^(Limit[A-Z]+|Nice|OOMScoreAdjust|TasksMax|Memory[A-Za-z]+|CPU[A-Za-z]+|IO[A-Za-z]+)$/;

/**
 * What a carried-over value may contain.
 *
 * No line breaks, and no comment marker, quote, backtick, dollar sign or
 * backslash: each of those would need real quoting, start a comment, or be
 * expanded by systemd. A value failing this is dropped rather than guessed at.
 */
const TUNING_VALUE_RE = /^[^\r\n#;"'`$\\]+$/;

/**
 * The tuning directives to keep, read from the OLD unit — structurally.
 *
 * Section headers are recognised only on their own line, so the literal text
 * `[Service]` inside a comment (which is what broke 1.4.4-1.4.6) is not a
 * section. Comment lines are skipped outright. Anything outside `[Service]` is
 * ignored, so the malformed `Environment=` lines those releases put in `[Unit]`
 * cannot ride along.
 *
 * @param {string|null} text
 * @param {(line: string) => void} [log]
 * @returns {Array<[string, string]>}
 */
function tuningFromUnit(text, log = () => {}) {
  if (typeof text !== 'string') return [];

  const kept = new Map();
  let section = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;

    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1];
      continue;
    }

    if (section !== 'Service') continue;

    const equals = line.indexOf('=');
    if (equals <= 0) continue;

    const key = line.slice(0, equals).trim();
    const value = line.slice(equals + 1).trim();
    if (!TUNING_KEY_RE.test(key)) continue;

    if (!TUNING_VALUE_RE.test(value)) {
      log(`dropped ${key} from the old unit`);
      continue;
    }

    // A repeated key keeps its first position and its last value, which is how
    // systemd reads a repeated scalar setting. serializeUnit() refuses a
    // duplicate, so this has to be resolved here.
    kept.set(key, value);
  }

  return [...kept.entries()];
}

/**
 * The unit, as data: sections in order, each with ordered items.
 *
 * An item is either a whole-line comment (a string beginning with `#`) or an
 * ordered `[key, value]` pair. An empty string is a blank line. That is the
 * entire format — there is no second place where unit text is written.
 *
 * Choices worth knowing:
 *
 *  - `After=network-online.target nginx.service` plus `Wants=network-online`:
 *    the daemon's first action is to probe domains and reach the Hub, both of
 *    which fail noisily on a machine whose network is not up yet. `After` on
 *    `nginx.service` is ordering only — a machine without nginx as a service
 *    still starts, because it is not listed under `Requires`.
 *  - `Restart=always` with `RestartSec=5`: a crash loop is handled by
 *    `StartLimitBurst` rather than by giving up after one failure.
 *  - `StartLimitIntervalSec`/`StartLimitBurst` let systemd stop restarting a
 *    daemon that cannot start at all, which is what makes `status` able to
 *    report a crash loop instead of showing "activating" for ever. They belong
 *    in the unit section: systemd moved them there in v229 and still accepts
 *    the old position only with a deprecation warning.
 *  - No `ExecStop`: the daemon handles SIGTERM, releases the lock and closes
 *    the database. systemd's default is exactly that signal.
 *
 * @param {Object} opts
 * @param {string} opts.nodeExe  The pinned runtime path (a symlink)
 * @param {string} opts.entry    Absolute path to the ez entry script
 * @param {string} opts.user
 * @param {string} opts.dataDir
 * @param {string} [opts.workingDir]
 * @param {Array<[string, string]>} [opts.tuning] Operator settings carried over, in order
 * @param {string|null} [opts.nodeVersion] The pinned runtime's version, so the
 *   confinement flag matches what that Node supports. Unknown → the loader flag.
 * @returns {Array<{ name: string, items: Array<string|string[]> }>}
 */
export function unitSections({ nodeExe, entry, user, dataDir, workingDir = null, tuning = [], nodeVersion = null }) {
  if (!nodeExe) throw new Error('the unit needs the path of the pinned runtime (nodeExe)');
  if (!entry) throw new Error('the unit needs the entry script path (entry)');
  if (!user) throw new Error('the unit needs the user the daemon runs as');

  // The confinement, exactly as core/service/runtime.js decides it for this
  // Node: --import + register() where the runtime has it, the loader flag
  // otherwise. The URLs are built from the package root (the entry's ../..),
  // which is also the unit's WorkingDirectory.
  const confinement = daemonNodeArgs({
    nodeVersion,
    packageRoot: path.resolve(path.dirname(entry), '..', '..'),
  });

  // Only passed when it is NOT the default. A unit that sets it to the very
  // directory the code already resolves on its own adds nothing, and the one
  // that did set it needlessly turned the service into a dev run — staging
  // certificates on real domains. See isDevDataDir() in core/platform.js.
  const dataDirItem = isDefaultDataDir(dataDir)
    ? '# EASY_DEVOPS_DATA_DIR is not set: this is the default directory.'
    : ['Environment', unitArg(`EASY_DEVOPS_DATA_DIR=${dataDir}`)];

  // Carried over from the installed unit by refreshUnit(): limits and
  // scheduling an operator raised by hand. Emitted like every other directive,
  // from data, never pasted into an existing file.
  const tuningItems = (Array.isArray(tuning) ? tuning : []).length === 0
    ? []
    : [
      '',
      '# Operator resource tuning, carried over unchanged from the previous unit.',
      ...tuning.map(([key, value]) => [key, value]),
    ];

  return [
    {
      name: 'Unit',
      items: [
        ['Description', 'Easy DevOps background service'],
        ['Documentation', 'https://github.com/farghaly/easy-devops'],
        '',
        '# The daemon probes domains and reaches the Hub as soon as it starts, so',
        '# wait for the network. nginx is ordering only: a machine without nginx',
        '# still runs.',
        ['After', 'network-online.target nginx.service'],
        ['Wants', 'network-online.target'],
        '',
        '# Stop restarting after 5 failures inside 60s, so a daemon that cannot',
        "# start ends in a state 'systemctl status' reports plainly instead of",
        '# thrashing. These two live here, not in the service section below:',
        '# systemd moved them in v229 and the old position is deprecated.',
        ['StartLimitIntervalSec', '60'],
        ['StartLimitBurst', '5'],
        '',
      ],
    },
    {
      name: 'Service',
      items: [
        ['Type', 'simple'],
        ['User', unitArg(user)],
        ['WorkingDirectory', unitArg(workingDir ?? packageRootFor(entry))],
        '',
        '# The pinned runtime, not whatever "node" resolves to in a shell. A version',
        '# manager can change that at any time; this path is ours. The daemon also',
        '# starts confined to its own package: --import on Node 18.19/20.6 and later,',
        '# the older loader flag before that.',
        ['ExecStart', [unitArg(nodeExe), ...confinement.map(unitArg), unitArg(entry), 'daemon'].join(' ')],
        '',
        '# Ambient Node settings and the optional ws accelerators are switched off,',
        '# so a daemon started from an unusual environment cannot behave differently.',
        '# These are service settings: systemd reads them from this section only, and',
        '# an assignment placed elsewhere is ignored.',
        ['Environment', unitArg('NODE_OPTIONS=')],
        ['Environment', unitArg('NODE_PATH=')],
        ['Environment', unitArg('WS_NO_BUFFER_UTIL=1')],
        ['Environment', unitArg('WS_NO_UTF_8_VALIDATE=1')],
        ['Environment', unitArg('NODE_ENV=production')],
        dataDirItem,
        '',
        ['Restart', 'always'],
        ['RestartSec', '5'],
        '',
        '# Give the daemon time to release its lock and close the database.',
        ['TimeoutStopSec', '20'],
        ['KillSignal', 'SIGTERM'],
        ...tuningItems,
        '',
        ['StandardOutput', 'journal'],
        ['StandardError', 'journal'],
        ['SyslogIdentifier', 'easy-devops'],
        '',
      ],
    },
    {
      name: 'Install',
      items: [
        ['WantedBy', 'multi-user.target'],
      ],
    },
  ];
}

/**
 * Turns the sections into the unit file's text. The only writer of unit text.
 *
 * It refuses the two mistakes that produced the broken 1.4.6 units rather than
 * trusting every future caller: a comment line that contains a `Key=value`
 * pattern (systemd would ignore the value, silently), and a directive that
 * would be a duplicate in a section where systemd treats a second occurrence
 * as a conflict.
 *
 * @param {Array<{ name: string, items: Array<string|string[]> }>} sections
 * @returns {string}
 */
export function serializeUnit(sections) {
  if (!Array.isArray(sections) || sections.length === 0) throw new Error('the unit template has no sections');

  const lines = [];
  const seen = new Set();

  for (const section of sections) {
    if (!UNIT_KEY_RE.test(section?.name ?? '')) {
      throw new Error(`invalid unit section name: ${section?.name}`);
    }
    lines.push(`[${section.name}]`);

    for (const item of section.items ?? []) {
      if (typeof item === 'string') {
        if (item === '') {
          lines.push('');
          continue;
        }
        if (!item.startsWith('#')) {
          throw new Error(`a unit line is neither a comment nor a directive: ${item}`);
        }
        if (KEY_VALUE_RE.test(item)) {
          throw new Error(`a unit comment must not contain a Key=value pattern: ${item}`);
        }
        lines.push(item);
        continue;
      }

      const [key, raw] = item ?? [];
      if (!UNIT_KEY_RE.test(key ?? '')) throw new Error(`invalid unit directive name: ${key}`);
      const value = String(raw ?? '');
      if (/[\r\n\0]/.test(value)) throw new Error(`invalid value for ${key}: a line break inside a unit value`);

      if (!REPEATABLE_KEYS.has(key)) {
        const id = `${section.name}\u0000${key}`;
        if (seen.has(id)) throw new Error(`${key} appears twice in [${section.name}], which systemd rejects`);
        seen.add(id);
      }

      lines.push(`${key}=${value}`);
    }
  }

  // A trailing newline: systemd accepts a file without one, but every text
  // tool a user opens it with is happier, and `diff` against a rewrite is
  // clean only when both end the same way.
  return `${lines.join('\n')}\n`;
}

/**
 * The generated unit for a given install.
 *
 * @param {Object} opts See unitSections()
 * @returns {string}
 */
export function buildUnit({ nodeExe, entry, user, dataDir, workingDir = null, tuning = [], nodeVersion = null }) {
  return serializeUnit(unitSections({ nodeExe, entry, user, dataDir, workingDir, tuning, nodeVersion }));
}

/** What to print when systemd is absent. */
export function manualInstructions({ nodeExe, entry, dataDir }) {
  return [
    'This machine does not use systemd, so there is no unit to install.',
    '',
    'Run the daemon yourself with whatever supervisor you use. The command is:',
    '',
    `  EASY_DEVOPS_DATA_DIR=${dataDir} ${nodeExe} ${entry} daemon`,
    '',
    'It runs in the foreground, logs to stdout and stderr, and stops cleanly on',
    'SIGTERM. Anything that can keep a foreground process alive will do:',
    '',
    '  • OpenRC    — an /etc/init.d script with supervise-daemon',
    '  • runit     — a run script under /etc/service/easy-devops/',
    '  • s6        — an s6-rc service definition',
    '  • supervisord — a [program:easy-devops] section',
    '',
    'Only one daemon may run at a time; a second refuses to start and says so,',
    'so a supervisor that accidentally starts two cannot duplicate notifications.',
  ].join('\n');
}

/**
 * Installs and starts the unit.
 *
 * As a normal user sudo asks for the password, on the user's terminal, in its
 * own words. This process never sees it. That also means a real TTY is
 * required, which is checked first rather than discovered as a hang. As root
 * nothing is wrapped: the copy, the enable and the restart run directly.
 *
 * @param {Object} opts
 * @param {string} opts.nodeExe
 * @param {string} opts.entry
 * @param {string} opts.dataDir
 * @param {string} [opts.user]
 * @param {(line: string) => void} [opts.log]
 * @param {Function} [opts.runner]
 * @param {Function} [opts.interactive]
 * @param {string} [opts.unitPath]
 * @param {boolean|null} [opts.isRoot] Injected by tests; otherwise the account
 * @returns {Promise<{ ok: boolean, reason?: string, unitPath?: string }>}
 */
export async function install({
  nodeExe,
  entry,
  dataDir,
  user = os.userInfo().username,
  log = () => {},
  runner = run,
  interactive = runInteractive,
  fileRunner = runFile,
  unitPath = UNIT_PATH,
  stdin = process.stdin,
  isRoot = null,
} = {}) {
  const access = serviceAccess({ isRoot, interactive, fileRunner, runner });

  // Someone has to answer sudo's prompt, so a normal user needs a terminal.
  // Root has nothing to answer: refusing a root install for want of a TTY would
  // block the automated setup of a server that needs no password at all.
  if (!access.root && !stdin?.isTTY) {
    return {
      ok: false,
      reason: 'installing the service needs a real terminal, because sudo has to ask for your password. '
        + 'Run `ezz service install` from a shell rather than from a script or the dashboard.',
    };
  }

  // Root runs every privileged step directly, and may have no sudo at all.
  if (access.root) log('Running as root: privileged commands go out directly, without sudo.');

  const nodeVersion = await readNodeVersion({ nodeExe });
  const unit = buildUnit({ nodeExe, entry, user, dataDir, nodeVersion });

  const written = await writeUnit(unit, {
    fileRunner: fileRunnerFor(access),
    interactive: access.shell,
    unitPath,
    log,
    root: access.root,
  });
  if (!written.ok) return written;

  const enable = await access.run(['sudo', 'systemctl', 'enable', UNIT_NAME], { timeout: 300_000 });
  if (!enable.success) return { ok: false, reason: `systemctl enable ${UNIT_NAME} failed` };

  const start = await access.run(['sudo', 'systemctl', 'restart', UNIT_NAME], { timeout: 300_000 });
  if (!start.success) {
    const recent = await journal({ lines: 20, runner });
    return {
      ok: false,
      reason: `the service was installed but would not start.\n\nLast log lines:\n${recent.output}`,
      unitPath,
    };
  }

  return { ok: true, unitPath };
}

/** Reads a text file, answering null when it is not there. */
function readTextFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Keeps the previous unit as `<unitPath>.prev`, beside it.
 *
 * The updater's transaction also snapshots the unit (core/service/
 * updateTransaction.js), but that snapshot lives in a temporary directory and
 * disappears with the transaction. This one stays: it is what a person can
 * copy back by hand after a bad unit, which is the situation 1.4.6 created.
 * systemd ignores the suffix, so the file cannot become a second unit.
 *
 * Written directly when the folder is writable (a root install, and every
 * test's temporary unit path), and through `sudo install` otherwise — the same
 * escalation the unit write itself uses, so it costs no second password
 * prompt.
 *
 * @returns {Promise<{ ok: boolean, path: string, reason?: string }>}
 */
async function backupUnit(previous, {
  unitPath = UNIT_PATH,
  stagingDir = null,
  fileRunner = runFile,
  stdin = 'inherit',
  root = false,
} = {}) {
  const backupPath = `${unitPath}.prev`;
  if (typeof previous !== 'string' || previous === '') return { ok: true, path: backupPath, skipped: true };

  // Written to a temporary name and renamed, so a failed write cannot leave a
  // truncated `.prev` behind — that file may be the only copy of a working
  // unit that a person can restore by hand.
  const temporary = `${backupPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, previous, { mode: 0o600 });
    renameWithRetry(temporary, backupPath);
    return { ok: true, path: backupPath };
  } catch { /* the folder needs sudo; fall through */ }
  try { fs.rmSync(temporary, { force: true }); } catch { /* nothing to clean up */ }

  if (!stagingDir) return { ok: false, path: backupPath, reason: 'no staging directory for the backup' };

  const staged = path.join(stagingDir, `${UNIT_NAME}.prev`);
  try {
    fs.writeFileSync(staged, previous, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    return { ok: false, path: backupPath, reason: error.message };
  }

  const copied = await fileRunner('sudo', ['install', '-m', '0600', '--', staged, backupPath], {
    timeout: 300_000,
    stdin,
  });
  return copied.success
    ? { ok: true, path: backupPath }
    : { ok: false, path: backupPath, reason: copied.stderr || `${root ? 'install' : 'sudo install'} failed` };
}

/**
 * Writes one generated unit to `unitPath`, after keeping the previous one.
 *
 * Nothing here reads the old unit and edits it: the caller hands over complete
 * text that came from buildUnit(), and this function only stages, backs up and
 * copies it.
 *
 * @param {string} unit
 * @param {Object} [opts]
 * @param {Function} [opts.fileRunner]  argv runner for `sudo install`
 * @param {Function} [opts.interactive] used for `systemctl daemon-reload` only
 * @param {string}   [opts.unitPath]
 * @param {(line: string) => void} [opts.log]
 * @param {boolean}  [opts.reload]  run daemon-reload here (default true)
 * @param {string|null} [opts.previousUnit] already-read previous text
 * @param {string}   [opts.stdin]   stdio for the sudo child, so it can prompt
 * @param {boolean}  [opts.root]    this process is root: no sudo, so say so
 * @returns {Promise<{ ok: boolean, reason?: string, backup?: string, warning?: string }>}
 */
async function writeUnit(unit, {
  fileRunner = runFile,
  interactive = runInteractive,
  unitPath = UNIT_PATH,
  log = () => {},
  reload = true,
  previousUnit = undefined,
  stdin = 'inherit',
  root = false,
} = {}) {
  let stagingDir;
  try {
    let staged;
    try {
      // mkdtemp creates the directory atomically with mode 0700 on Linux.
      stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-devops-unit-'));
      staged = path.join(stagingDir, UNIT_NAME);
      fs.writeFileSync(staged, unit, { flag: 'wx', mode: 0o600 });
    } catch (err) {
      return { ok: false, reason: `could not stage the unit file: ${err.message}` };
    }

    const previous = previousUnit === undefined ? readTextFile(unitPath) : previousUnit;
    const backup = await backupUnit(previous, { unitPath, stagingDir, fileRunner, stdin, root });
    // A backup that cannot be written must not block the repair: without it
    // the update transaction's snapshot is still the rollback path, and a
    // refused repair would leave the service broken. Say so instead of
    // failing silently.
    const warning = backup.ok ? undefined : `could not keep a copy of the previous unit at ${backup.path}: ${backup.reason}`;
    if (warning) log(`warning: ${warning}`);
    else if (!backup.skipped) log(`Previous unit kept as ${backup.path}`);

    log(root
      ? `Installing ${unitPath}`
      : `Installing ${unitPath} (sudo will ask for your password)`);
    // sudo reads passwords directly from its controlling terminal; as root
    // there is nothing to ask, so `install` runs directly.
    const copy = await fileRunner('sudo', ['install', '-m', '0644', '--', staged, unitPath], { timeout: 300_000, stdin });
    if (!copy.success) {
      return {
        ok: false,
        reason: `could not write ${unitPath}. ${root ? 'install' : 'sudo'} exited ${copy.exitCode ?? 'non-zero'}.`,
      };
    }

    if (reload) {
      const reloaded = await interactive('sudo systemctl daemon-reload');
      if (!reloaded.success) return { ok: false, reason: 'systemctl daemon-reload failed' };
    }

    return { ok: true, backup: backup.skipped ? null : backup.path, ...(warning ? { warning } : {}) };
  } finally {
    if (stagingDir) fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

/**
 * The user an installed unit runs as, if it has one that can be trusted.
 *
 * Read from the unit's own `[Service]` section — never from a comment, which
 * is how the broken units came about — and only when the value looks like a
 * plain account name. A unit written for `deploy` must keep running as
 * `deploy` even when an update is applied by root through sudo.
 *
 * @param {string|null} text
 * @returns {string|null}
 */
function installedUser(text) {
  if (typeof text !== 'string') return null;

  let section = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;

    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1];
      continue;
    }
    if (section !== 'Service') continue;

    const match = /^User\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    const value = match[1].trim().replace(/^"(.*)"$/, '$1');
    return /^[A-Za-z0-9_][A-Za-z0-9_.@-]*\$?$/.test(value) ? value : null;
  }

  return null;
}

/**
 * Rewrites the installed unit from the template, keeping its identity and the
 * operator's resource tuning.
 *
 * This is the repair, the update and the recovery path, and it always writes a
 * freshly generated unit: the previous file is read for exactly two things —
 * which account the service runs as, and the resource limits an operator set
 * by hand (LimitNOFILE, TasksMax, Nice, …). It is never edited. That is what
 * turns a 1.4.6 unit with `Environment=` assignments inside a comment into a
 * valid one, and what makes a second repair byte-identical (identical text is
 * not written at all).
 *
 * The pinned values come from the code, not from the old file: the runtime
 * link, the loader URL, the package root as the working directory, and the
 * daemon's environment. A stale `WorkingDirectory` after a package move is
 * therefore fixed rather than preserved. Operator tuning comes from the old
 * unit's own `[Service]` section only — see tuningFromUnit().
 *
 * @param {Object} opts
 * @param {string} opts.entry
 * @param {string} opts.dataDir
 * @param {string} [opts.unitPath]
 * @param {string} [opts.user] Explicit owner; otherwise the installed one, otherwise this user
 * @param {(line: string) => void} [opts.log]
 * @param {Object} [opts] Rest forwarded to writeUnit (fileRunner, interactive, reload, stdin)
 * @returns {Promise<{ ok: boolean, unchanged?: boolean, unitPath?: string, reason?: string, backup?: string }>}
 */
export async function refreshUnit({
  entry,
  dataDir,
  unitPath = UNIT_PATH,
  user = null,
  log = () => {},
  isRoot = null,
  ...options
} = {}) {
  const previous = readTextFile(unitPath);
  const owner = user ?? installedUser(previous) ?? os.userInfo().username;
  const tuning = tuningFromUnit(previous, log);

  const nodeExe = runtimeNodePath(dataDir);
  // Read from the pinned binary, not from the CLI's own Node: a unit must run
  // on the Node it names. Unknown means the loader flag, which every version
  // understands.
  const nodeVersion = await readNodeVersion({ nodeExe });
  const unit = buildUnit({ nodeExe, entry, dataDir, user: owner, tuning, nodeVersion });
  if (previous === unit) {
    log(`${unitPath} is already up to date`);
    return { ok: true, unitPath, unchanged: true };
  }

  // The file copy and the daemon-reload go through the same rule as every other
  // privileged step: root writes directly, everyone else through sudo.
  const access = serviceAccess({
    isRoot,
    interactive: options.interactive ?? runInteractive,
    fileRunner: options.fileRunner ?? runFile,
  });

  return writeUnit(unit, {
    ...options,
    fileRunner: fileRunnerFor(access),
    interactive: access.shell,
    unitPath,
    log,
    previousUnit: previous,
    root: access.root,
  });
}

/**
 * Whether this process already has root's power, so sudo adds nothing.
 *
 * A minimal server can run the daemon and this CLI as root with no `sudo`
 * installed at all; asking for `sudo systemctl` there fails with ENOENT even
 * though nothing extra is needed. There is no shared helper for this — the
 * only other uid read in the code base (core/permissions.js) is about file
 * ownership — so it is read here, from the account, never from the platform.
 *
 * @returns {boolean}
 */
function isRootUser() {
  try {
    return os.userInfo().uid === 0;
  } catch {
    return false;
  }
}

/**
 * The one place that decides how a privileged command is invoked.
 *
 * Two rules, and no third:
 *
 *  - **uid 0** already has what sudo would ask for, and a minimal server may
 *    not even have sudo installed. Every privileged command goes out directly:
 *    `systemctl restart …`, `install -m 0644 …`, `rm -f …`.
 *  - **anyone else** goes through sudo exactly as before. sudo asks on the
 *    user's own terminal, in its own words. This process never sees, stores or
 *    forwards a password, and never passes `-n` (which would fail instead of
 *    asking) or `-S` (which would take one from us).
 *
 * Reading the service's state is not privileged — `systemctl show` is readable
 * by any user — so `read()` never elevates. A status command that prompted for
 * a password would be a status command nobody could put in a script.
 *
 * @param {Object} [opts]
 * @param {boolean|null} [opts.isRoot] Injected by tests; otherwise the account
 * @param {Function} [opts.interactive] string runner that can prompt
 * @param {Function} [opts.fileRunner] argv runner
 * @param {Function} [opts.runner] read-only string runner
 * @returns {{
 *   root: boolean,
 *   run: (argv: string[], options?: Object) => Promise<Object>,
 *   shell: (command: string, options?: Object) => Promise<Object>,
 *   read: (command: string, options?: Object) => Promise<Object>,
 * }}
 */
export function serviceAccess({
  isRoot = null,
  interactive = runInteractive,
  fileRunner = runFile,
  runner = run,
} = {}) {
  const root = (isRoot ?? isRootUser()) === true;

  return {
    root,

    /**
     * Runs a fixed argument list. A leading `sudo` element is what marks a
     * command as privileged, and it is dropped when this process is root.
     */
    run(argv, options = {}) {
      const [first, ...rest] = argv;
      if (root && first === 'sudo') return fileRunner(rest[0], rest.slice(1), options);
      return fileRunner(first, rest, options);
    },

    /** Runs a command line that needs a shell (a `|| true`, a redirect). */
    shell(command, options = {}) {
      const text = String(command);
      return interactive(root ? text.replace(/^sudo\s+/, '') : text, options);
    },

    /** Runs a command that reads state only. Never elevated. */
    read(command, options = {}) {
      return runner(command, options);
    },
  };
}

/**
 * Adapts serviceAccess().run() to the `(file, args, options)` shape that the
 * unit writers expect, so a file copy is elevated by the same rule as a
 * systemctl call.
 *
 * @param {ReturnType<typeof serviceAccess>} access
 * @returns {(file: string, args: string[], options?: Object) => Promise<Object>}
 */
function fileRunnerFor(access) {
  return (file, args, options = {}) => access.run([file, ...(Array.isArray(args) ? args : [])], options);
}

/**
 * Puts a Linux install broken by 1.4.4-1.4.6 back into a working state.
 *
 * The steps, in this order, and each one is reported if it fails:
 *
 *   1. re-point the pinned runtime link at the running Node;
 *   2. regenerate the unit from the template (which replaces a malformed one);
 *   3. `systemctl daemon-reload`;
 *   4. clear a stale stop request, so the daemon cannot exit again at once;
 *   5. `systemctl restart`;
 *   6. wait for the daemon's own heartbeat — not the service manager's word.
 *
 * Nothing here prompts by itself and nothing touches user data: sudo may ask
 * for its own password on the terminal, and the only file removed is the
 * daemon's stop request. Run as root, every privileged command goes out
 * directly instead of through sudo. On failure the answer carries the last
 * journal lines and the exact command to run next.
 *
 * @param {Object} [opts]
 * @param {string} [opts.dataDir]
 * @param {string} [opts.entry]            The entry script to record in the unit
 * @param {string} [opts.unitPath]
 * @param {(line: string) => void} [opts.log]
 * @param {Function} [opts.run]            Shell runner, for journalctl
 * @param {Function} [opts.runFile]        argv runner, for `sudo` / `systemctl`
 * @param {Function} [opts.waitForDaemon]  Injected for tests
 * @param {number} [opts.startupGraceMs]
 * @param {number} [opts.journalLines]
 * @param {Object} [opts.deps]             Injected for tests
 * @returns {Promise<{ ok: boolean, reason?: string, step?: string, next?: string, journal?: string|null, pid?: number|null }>}
 */
export async function recoverService({
  dataDir = getDataDir(),
  entry = ENTRY_SCRIPT,
  unitPath = UNIT_PATH,
  log = () => {},
  run: runner = run,
  runFile: fileRunner = runFile,
  waitForDaemon: waiter = null,
  startupGraceMs = RECOVER_STARTUP_GRACE_MS,
  journalLines = 25,
  stdin = 'inherit',
  deps = {},
} = {}) {
  const fail = async (step, reason, next) => {
    let output = null;
    // Before the unit is written there is nothing new in the journal, and a
    // stale tail would be read as the cause of this failure.
    if (step !== 'unit') {
      try {
        output = (await journal({ lines: journalLines, runner })).output || null;
      } catch { /* the reason is still worth returning without the log tail */ }
    }
    const tail = output ? `\n\nLast log lines:\n${output}` : '';
    return { ok: false, step, reason: `${reason}${tail}\n\nNext: ${next}`, next, journal: output };
  };

  // Root already has the privilege sudo would ask for — and a minimal server
  // may not even have sudo. Every privileged call below goes through this one
  // rule (see serviceAccess), so dropping the wrapper is the whole difference.
  const access = serviceAccess({ isRoot: (deps.isRoot ?? isRootUser)(), fileRunner });
  if (access.root) log('Running as root: privileged commands go out directly, without sudo.');

  // ── 1. The pinned runtime ────────────────────────────────────────────────
  log('Re-pointing the pinned Node runtime…');
  try {
    const linked = await (deps.linkRuntime ?? linkRuntime)({ dataDir });
    if (linked?.ok) log(`  ${linked.link} → ${linked.target}`);
    else log(`  warning: could not re-point the runtime link: ${linked?.reason ?? 'no result'}`);
  } catch (error) {
    log(`  warning: could not re-point the runtime link: ${error.message}`);
  }

  // ── 2. The unit ──────────────────────────────────────────────────────────
  log(`Regenerating ${unitPath}…`);
  let refreshed;
  try {
    refreshed = await refreshUnit({
      entry, dataDir, unitPath, log, fileRunner: fileRunnerFor(access), isRoot: access.root, reload: false, stdin,
    });
  } catch (error) {
    return fail(
      'unit',
      `could not regenerate ${unitPath}: ${error.message}`,
      'ezz service recover   (from a terminal where sudo can ask for your password)',
    );
  }
  if (!refreshed.ok) {
    return fail(
      'unit',
      `could not write ${unitPath}: ${refreshed.reason}`,
      'ezz service recover   (from a terminal where sudo can ask for your password)',
    );
  }
  if (refreshed.unchanged) log('  the installed unit was already the generated one');

  // ── 3. daemon-reload ─────────────────────────────────────────────────────
  log('Reloading systemd…');
  const reloaded = await access.run(['sudo', 'systemctl', 'daemon-reload'], { timeout: 300_000, stdin });
  if (!reloaded?.success) {
    return fail(
      'reload',
      `\`systemctl daemon-reload\` failed${reloaded?.stderr ? `: ${reloaded.stderr}` : ''}`,
      `systemd-analyze verify ${unitPath}`,
    );
  }

  // ── 4. A stop request left behind would stop the new daemon at once ──────
  const request = (deps.readStopRequest ?? readStopRequest)({ dataDir });
  const cleared = (deps.clearStopRequest ?? clearStopRequest)({ dataDir });
  if (cleared === false) {
    return fail(
      'stop-request',
      `could not clear the stop request at ${stopRequestPath(dataDir)}; the daemon would stop again as soon as it starts`,
      `rm -f ${stopRequestPath(dataDir)}`,
    );
  }
  if (request.requested) log('Cleared a stop request that would have stopped the daemon again.');

  // ── 5. Restart ───────────────────────────────────────────────────────────
  log(`Restarting ${UNIT_NAME}…`);
  const restarted = await access.run(['sudo', 'systemctl', 'restart', UNIT_NAME], { timeout: 300_000, stdin });
  if (!restarted?.success) {
    return fail(
      'restart',
      `\`systemctl restart ${UNIT_NAME}\` failed${restarted?.stderr ? `: ${restarted.stderr}` : ''}`,
      'ezz service logs',
    );
  }

  // ── 6. The daemon's own heartbeat, not the manager's word ────────────────
  log('Waiting for the daemon to report in…');
  let wait = waiter;
  if (!wait) {
    const svc = await import('./index.js');
    wait = svc.waitForDaemon;
  }

  const alive = await wait({
    dataDir,
    timeoutMs: startupGraceMs,
    onProgress: (waited, limit) => log(`  still waiting… ${Math.round(waited / 1000)}s of ${Math.round(limit / 1000)}s`),
  });

  if (!alive?.alive) {
    const seconds = Math.round((alive?.waitedMs ?? startupGraceMs) / 1000);
    return fail(
      'heartbeat',
      `the unit was regenerated and ${UNIT_NAME} was restarted, but the daemon did not report in within `
        + `${seconds}s — so it is starting and failing.`,
      'ezz service logs   (then `ezz service status` for the database and runtime diagnostics)',
    );
  }

  log(`The daemon is running (pid ${alive.lock?.pid ?? 'unknown'}).`);
  return {
    ok: true,
    unitPath,
    pid: alive.lock?.pid ?? null,
    waitedMs: alive.waitedMs,
    backup: refreshed.backup ?? null,
  };
}

/**
 * Stops, disables and removes the unit.
 *
 * Every step tolerates "already gone": uninstall must succeed on a machine
 * where the user removed the unit by hand, or they are left unable to clean up
 * through the tool at all.
 *
 * @param {Object} [opts]
 * @param {boolean|null} [opts.isRoot] Injected by tests; otherwise the account
 */
export async function uninstall({
  log = () => {},
  interactive = runInteractive,
  fileRunner = runFile,
  unitPath = UNIT_PATH,
  stdin = process.stdin,
  isRoot = null,
} = {}) {
  // Root does the same steps without a sudo wrapper - and a minimal server may
  // have no sudo at all, so no terminal is needed either.
  const access = serviceAccess({ isRoot, interactive, fileRunner });

  if (!access.root && !stdin?.isTTY) {
    return {
      ok: false,
      reason: 'removing the service needs a real terminal, because sudo has to ask for your password.',
    };
  }

  log(access.root
    ? `Removing ${unitPath}`
    : `Removing ${unitPath} (sudo will ask for your password)`);

  await access.shell(`sudo systemctl stop ${UNIT_NAME} || true`);
  await access.shell(`sudo systemctl disable ${UNIT_NAME} || true`);
  const remove = await access.run(['sudo', 'rm', '-f', '--', unitPath], { timeout: 300_000 });
  if (!remove.success) return { ok: false, reason: `could not remove ${unitPath}` };

  const reload = await access.shell('sudo systemctl daemon-reload');
  if (!reload.success) return { ok: false, reason: 'systemctl daemon-reload failed' };
  await access.shell(`sudo systemctl reset-failed ${UNIT_NAME} || true`);

  return { ok: true };
}

/**
 * `systemctl restart`, which needs no password beyond sudo's own prompt.
 *
 * @param {Object} [opts]
 * @param {boolean|null} [opts.isRoot] Injected by tests; otherwise the account
 */
export async function restart({ fileRunner = runFile, isRoot = null, stdin = 'inherit' } = {}) {
  const access = serviceAccess({ isRoot, fileRunner });
  const result = await access.run(['sudo', 'systemctl', 'restart', UNIT_NAME], { timeout: 300_000, stdin });
  return { ok: result.success, reason: result.success ? null : `systemctl restart ${UNIT_NAME} failed` };
}

/**
 * `systemctl stop` — temporary. The unit stays enabled, so the daemon comes
 * back at the next boot. Removing it permanently is `ezz service uninstall`.
 *
 * @param {Object} [opts]
 * @param {boolean|null} [opts.isRoot] Injected by tests; otherwise the account
 */
export async function stop({
  fileRunner = runFile, isRoot = null, stdin = process.stdin, unitPath = UNIT_PATH,
} = {}) {
  if (!fs.existsSync(unitPath)) {
    return { ok: false, reason: 'the service is not installed, so there is nothing to stop' };
  }

  const access = serviceAccess({ isRoot, fileRunner });
  if (!access.root && !stdin?.isTTY) {
    return {
      ok: false,
      reason: 'stopping the service needs a terminal, because sudo has to ask for your password.',
    };
  }

  const result = await access.run(['sudo', 'systemctl', 'stop', UNIT_NAME], { timeout: 300_000, stdin: 'inherit' });
  return { ok: result.success, reason: result.success ? null : `systemctl stop ${UNIT_NAME} failed` };
}

/**
 * `systemctl start`, through the same rule as stop: root directly, everyone
 * else with sudo asking on their own terminal.
 *
 * @param {Object} [opts]
 * @param {boolean|null} [opts.isRoot] Injected by tests; otherwise the account
 */
export async function start({
  fileRunner = runFile, isRoot = null, stdin = process.stdin, unitPath = UNIT_PATH,
} = {}) {
  if (!fs.existsSync(unitPath)) {
    return { ok: false, reason: 'the service is not installed; run `ezz service install` first' };
  }

  const access = serviceAccess({ isRoot, fileRunner });
  if (!access.root && !stdin?.isTTY) {
    return {
      ok: false,
      reason: 'starting the service needs a terminal, because sudo has to ask for your password.',
    };
  }

  const result = await access.run(['sudo', 'systemctl', 'start', UNIT_NAME], { timeout: 300_000, stdin: 'inherit' });
  return { ok: result.success, reason: result.success ? null : `systemctl start ${UNIT_NAME} failed` };
}

/**
 * Recent log lines, from the journal.
 *
 * Read with plain `journalctl` and no sudo: a unit running as the current user
 * logs where that user can read it, and requiring sudo to read your own logs
 * would be a password prompt for a status command.
 */
export async function journal({ lines = 50, runner = run } = {}) {
  const result = await runner(
    `journalctl -u ${UNIT_NAME} -n ${Math.max(1, Math.min(5000, Number(lines) || 50))} --no-pager`,
    { timeout: 20_000 },
  );

  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();

  if (!result.success) {
    return {
      ok: false,
      output: output || `journalctl could not read the unit's logs. If this says "No journal files were found", `
        + 'the journal is not persistent on this machine.',
    };
  }

  return { ok: true, output };
}

/**
 * The unit's state, including whether it is in a crash loop.
 *
 * A crash loop is the failure mode a naive status read misses: `is-active`
 * says `activating` while systemd is restarting a daemon that dies every five
 * seconds, which reads as "starting up" for ever. `NRestarts` is what reveals
 * it, so it is read explicitly and reported.
 *
 * @param {Object} [opts]
 * @param {boolean|null} [opts.isRoot] Injected by tests; otherwise the account
 * @param {string} [opts.unitPath] Injected by tests
 * @returns {Promise<Object>}
 */
export async function status({ runner = run, isRoot = null, unitPath = UNIT_PATH } = {}) {
  const installed = fs.existsSync(unitPath);

  if (!installed) {
    return {
      installed: false,
      running: false,
      enabledOnBoot: false,
      state: 'not installed',
      restarts: 0,
      crashLooping: false,
      unitPath,
    };
  }

  // Reading the state is not privileged (`systemctl show` is world-readable
  // for system units), so the same rule applies to everyone and never adds
  // sudo: a status check that prompted for a password would be useless in a
  // script. serviceAccess().read() is the one place that says so.
  const access = serviceAccess({ isRoot, runner });

  // One call for several properties: cheaper than four systemctl invocations,
  // and consistent — four calls can straddle a state change.
  const props = await access.read(
    `systemctl show ${UNIT_NAME} --property=ActiveState --property=SubState --property=NRestarts `
    + '--property=UnitFileState --property=ExecMainStartTimestamp --property=Result --no-pager',
    { timeout: 15_000 },
  );

  const parsed = Object.fromEntries(
    (props.stdout || '').split('\n')
      .map((line) => line.split('='))
      .filter((pair) => pair.length >= 2)
      .map(([key, ...rest]) => [key.trim(), rest.join('=').trim()]),
  );

  const activeState = parsed.ActiveState || 'unknown';
  const restarts = Number(parsed.NRestarts) || 0;

  // Restarting repeatedly, or stopped by the start limit. Either way the
  // daemon is not staying up, which is the thing worth saying.
  const crashLooping = restarts >= 3 && activeState !== 'active'
    || parsed.Result === 'start-limit-hit'
    || (activeState === 'failed' && restarts >= 3);

  return {
    installed: true,
    running: activeState === 'active',
    enabledOnBoot: parsed.UnitFileState === 'enabled',
    state: parsed.SubState ? `${activeState} (${parsed.SubState})` : activeState,
    restarts,
    crashLooping,
    result: parsed.Result || null,
    startedAt: parsed.ExecMainStartTimestamp || null,
    unitPath,
  };
}

/**
 * Re-points the runtime symlink and reloads the unit.
 *
 * The repair case this exists for: the user upgraded Node through nvm, the old
 * version was removed, and the link now points at nothing. Re-pointing the
 * link is enough — the unit itself refers to the link, not to a Node version,
 * which is the entire reason it is a link.
 */
export async function repair({
  dataDir, entry, nodeExe = process.execPath, log = () => {}, interactive = runInteractive,
  fileRunner = runFile, isRoot = null,
} = {}) {
  const linked = linkRuntime({ dataDir, nodeExe });
  if (!linked.ok) return { ok: false, reason: linked.reason };
  log(`Runtime link → ${linked.target}`);

  const access = serviceAccess({ isRoot, interactive, fileRunner });

  if (!fs.existsSync(UNIT_PATH)) {
    return { ok: true, relinked: true, reason: 'the runtime link was fixed; no unit is installed' };
  }

  if (!access.root && !process.stdin.isTTY) {
    return {
      ok: false,
      reason: 'the runtime link was fixed, but restarting the unit needs a terminal for sudo.',
    };
  }

  if (entry) {
    const result = await refreshUnit({
      dataDir, entry, interactive: access.shell, isRoot: access.root, log,
    });
    if (!result.ok) return { ...result, relinked: true };
  }
  const result = await access.run(['sudo', 'systemctl', 'restart', UNIT_NAME], { timeout: 300_000 });
  return result.success
    ? { ok: true, relinked: true, target: linked.target }
    : { ok: false, reason: `the link was fixed but \`systemctl restart ${UNIT_NAME}\` failed` };
}

/** The pinned runtime path for this data directory. Re-exported for the installer. */
export { runtimeNodePath };
