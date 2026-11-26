#!/usr/bin/env node
/**
 * cli/index.js — entry point and bootstrap.
 *
 * This file deliberately has NO static import that reaches core/db.js.
 * ESM evaluates every static import before any module body runs, so the data
 * directory has to be decided here, before the database module is loaded.
 * Everything else is pulled in with a dynamic import() once the environment
 * is set up.
 *
 * Flags are parsed by hand: util.parseArgs is not available on Node 18.0,
 * which is this project's documented minimum.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { version } = require('../../package.json');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DEV_DATA_DIR = path.join(PROJECT_ROOT, '.dev-data');

// Must match DATA_DIR_ENV and DEV_MODE_ENV in core/platform.js. Hardcoded
// rather than imported because importing platform.js here is fine, but keeping
// this file free of project imports makes the ordering guarantee obvious at a
// glance.
const DATA_DIR_ENV = 'EASY_DEVOPS_DATA_DIR';
const DEV_MODE_ENV = 'EZ_DEV';

// Read by dashboard/server.js, not by core/. Set here because the flag is a
// one-run override of the dashboardUi setting and the server must know about
// it before it mounts its routes.
//
// The React UI is now the default, so the override runs the other way:
// --classic-ui asks for the old EJS page. --new-ui is kept as an accepted
// no-op so an existing habit or script does not start failing.
const CLASSIC_UI_ENV = 'EASY_DEVOPS_CLASSIC_UI';

/**
 * Parses argv into flags and positional arguments.
 * Recognises `--flag` and the short aliases `-h` / `-v`.
 *
 * Every positional is kept, not just the first: `ezz service install` needs
 * both the command and its subcommand.
 *
 * @param {string[]} argv Arguments after node and the script path
 * @returns {{ flags: Set<string>, command: string|null, args: string[], unknown: string[] }}
 */
function parseArgs(argv) {
  const known = new Set([
    'dash', 'dev', 'classic-ui', 'new-ui', 'help', 'version',
    // Command options. Kept in the same set because the parser runs before
    // any command module is loaded, and an unknown flag must still be
    // refused rather than silently ignored.
    'purge', 'yes',
    // With `service install`: what to do with an earlier Server-mode install's
    // data in C:\ProgramData\easy-devops when the Server-mode marker is gone.
    'adopt-existing-data', 'set-aside-existing-data',
  ]);
  // Options that take a value, so `--days 30` does not leave `30` looking
  // like a positional argument.
  const valued = new Set(['days']);
  const flags = new Set();
  const unknown = [];
  const positionals = [];

  const options = {};
  let expecting = null;

  for (const arg of argv) {
    if (expecting) {
      options[expecting] = arg;
      expecting = null;
      continue;
    }

    if (arg === '-h') { flags.add('help'); continue; }
    if (arg === '-v') { flags.add('version'); continue; }

    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      const name = eq === -1 ? body : body.slice(0, eq);

      if (valued.has(name)) {
        if (eq === -1) expecting = name;
        else options[name] = body.slice(eq + 1);
        continue;
      }

      if (known.has(name)) flags.add(name);
      else unknown.push(arg);
      continue;
    }

    positionals.push(arg);
  }

  if (expecting) unknown.push(`--${expecting} (missing its value)`);

  return {
    flags,
    options,
    command: positionals[0] ?? null,
    args: positionals.slice(1),
    unknown,
  };
}

function printHelp() {
  process.stdout.write(`
Easy DevOps v${version}

Usage:
  easy-devops [command] [options]
  ezz [command] [options]          (short alias)

Commands:
  (none)            Start the interactive CLI menu
  system-info       Print detected system info and exit
  daemon            Run the background worker in the foreground: monitoring,
                    notifications and the Hub agent. No web port is opened.
                    Normally started by the installed service, not by hand.
  service <action>  Install and manage the native background service.
                    Actions: install, uninstall, status, start, stop,
                    restart, logs, repair
  runtime <action>  The Node runtime the service is pinned to.
                    Actions: status, update
  update            Update Easy DevOps itself, then restart the service.
  hub <action>      Pair this server with an Easy DevOps Hub.
                    Actions: connect <link-or-ezops-string>, status, unlink
  cleanup           List reclaimable files (runtime backups, old logs, stale
                    locks, nginx .bak files) and remove the ones you choose.
  uninstall         Remove Easy DevOps. Needs --purge to do anything.
  dashboard <action>
                    Actions: setup-code (issue a new first-run setup code)

Options:
  --dash            Start the web dashboard in the foreground and print its
                    URL. Press Ctrl+C to stop it cleanly.
  --dev             Use an isolated data directory (.dev-data in the project)
                    instead of the real one, so development never touches your
                    installed configuration. Combines with --dash.
  --classic-ui      Serve the old EJS dashboard instead of the React one, for
                    one run. A temporary fallback; overrides the dashboardUi
                    setting.
  --purge           With "uninstall": remove the service, the pinned runtime
                    and the data directory, after exporting a backup. nginx,
                    your sites and your certificates are kept.
  --days N          With "cleanup": treat logs older than N days as
                    reclaimable (default 14).
  --yes             Answer the confirmations yes. For scripts;
                    "uninstall --purge" still prints what it will do.
  --adopt-existing-data
  --set-aside-existing-data
                    With "service install", when C:\ProgramData\easy-devops
                    holds an earlier Server-mode install's data:
                    --adopt-existing-data keeps that data as it is;
                    --set-aside-existing-data moves it to
                    easy-devops.old-<date>, then uses %APPDATA%.
                    Without either, install asks and changes nothing when it
                    cannot ask. Never both.
  -h, --help        Show this help
  -v, --version     Show the version

Examples:
  ezz                       Interactive menu
  ezz --dash                Run the dashboard in this terminal
  ezz --dash --classic-ui   Run the dashboard with the old EJS UI
  ezz --dev --dash          Run the dashboard against .dev-data
  ezz service install       Install the background service
  ezz service status        Show whether the service runs and starts on boot
  ezz service stop          Stop it until the next logon/boot (temporary)
  ezz service start         Start it again now
  ezz daemon                Run the background worker here (debugging)
  ezz runtime status        Show the pinned Node and the available LTS versions
  ezz runtime update        Move the service to a newer Node, with rollback
  ezz update                Update Easy DevOps and restart the service
  ezz hub connect <link>    Pair with a Hub using the command from its "From the CLI" option
  ezz hub status            Show the Hub origin, server id and agent state
  ezz hub unlink --yes      Remove the pairing (the Hub keeps the server, offline)
  ezz cleanup               Show what can be reclaimed (nothing is deleted)
  ezz dashboard setup-code  Issue a new first-run setup code
  npm run dev               Interactive menu against .dev-data

`);
}

const { flags, options, command, args, unknown } = parseArgs(process.argv.slice(2));

if (command === 'daemon') {
  process.env.WS_NO_BUFFER_UTIL = '1';
  process.env.WS_NO_UTF_8_VALIDATE = '1';

  // The CommonJS half of the confinement. Installed unconditionally and
  // idempotently: the boundary is what refuses a `require` or a native addon
  // from outside the package, and it must be in place however the daemon was
  // started.
  require('../core/service/runtime-boundary.cjs').install();

  const loaderHref = new URL('../core/service/runtime-loader.mjs', import.meta.url).href;
  const registerHref = new URL('../core/service/runtime-register.mjs', import.meta.url).href;
  const LOADER_FLAG = '--experimental-loader';

  /**
   * Three command lines exist in the field, and each is "already confined":
   *
   *  - 1.4.4-1.4.7 units, XML and supervisors pass
   *    `--experimental-loader=<this package's runtime-loader.mjs>`;
   *  - 1.4.8 and later pass `--import <this package's runtime-register.mjs>`,
   *    which installed both halves before this file ran;
   *  - anything else (1.4.0-1.4.3 units have no flag, and `ezz daemon` run by
   *    hand has none either) needs register() here.
   *
   * The loader flag keeps working - it only prints Node's deprecation warning -
   * so an old unit is never broken by this; `ezz service repair` rewrites it.
   */
  const confinedByLoaderFlag = process.execArgv.some((arg, index) => (
    (arg === LOADER_FLAG && /runtime-loader\.mjs$/.test(process.execArgv[index + 1] ?? ''))
    || (arg.startsWith(`${LOADER_FLAG}=`) && /runtime-loader\.mjs$/.test(arg.slice(LOADER_FLAG.length + 1)))
  ));
  const confinedByImport = process.execArgv.some((arg, index) => (
    (arg === '--import' && process.execArgv[index + 1] === registerHref)
    || arg === `--import=${registerHref}`
  ));

  if (!confinedByLoaderFlag && !confinedByImport) {
    try {
      // On a Node without module.register() this throws, and the message says
      // to run service repair or use a newer Node.
      const daemonLoader = await import(registerHref);
      daemonLoader.install();
    } catch (error) {
      // A copy from before 1.4.8 - an old runtime copy, or a tree that was half
      // refreshed - has the loader but not the register module. Confine it the
      // way 1.4.7 did and say what to run: a service that will not start is
      // worse than one running with the older flag, and `ezz service repair`
      // writes both the file and the command line.
      const missingRegister = error?.code === 'ERR_MODULE_NOT_FOUND'
        && /runtime-register\.mjs/.test(String(error?.message ?? ''));
      if (!missingRegister) throw error;

      const { register } = await import('node:module');
      if (!register) {
        throw new Error('Run service repair to enable the daemon module loader, or use Node 18.19 or later.');
      }
      register(loaderHref);
      process.stderr.write(
        'Warning: this copy is missing src/core/service/runtime-register.mjs, so the daemon was '
        + 'confined with the older loader. Run `ezz service repair` to bring the copy up to date.\n',
      );
    }
  }
}

if (unknown.length > 0) {
  process.stderr.write(`Unknown option: ${unknown.join(', ')}\n`);
  process.stderr.write('Run `easy-devops --help` to see the available options.\n');
  process.exit(1);
}

if (flags.has('help')) {
  printHelp();
  process.exit(0);
}

if (flags.has('version')) {
  process.stdout.write(`${version}\n`);
  process.exit(0);
}

// ─── Leftover-data choice ─────────────────────────────────────────────────────
// Two flags that each answer the same question, so `--yes` cannot stand in for
// either: adopting keeps the ProgramData data, setting it aside moves it. A
// command that got both, or one of them on the wrong command, changes nothing.
const leftoverChoice = flags.has('adopt-existing-data')
  ? 'adopt'
  : flags.has('set-aside-existing-data') ? 'keep-aside' : undefined;

if (flags.has('adopt-existing-data') && flags.has('set-aside-existing-data')) {
  process.stderr.write(
    'Choose one: --adopt-existing-data or --set-aside-existing-data, not both. '
    + 'Adopting keeps the data in C:\\ProgramData\\easy-devops; setting it aside moves that '
    + 'folder to easy-devops.old-<date> first. Nothing was changed.\n',
  );
  process.exit(1);
}

if (leftoverChoice && !(command === 'service' && args[0] === 'install')) {
  process.stderr.write(
    '--adopt-existing-data and --set-aside-existing-data only apply to `ezz service install`. '
    + 'Nothing was changed.\n',
  );
  process.exit(1);
}

// ─── Dev data mode ────────────────────────────────────────────────────────────
// Set before any dynamic import below, so core/db.js — and any child process
// that inherits this environment, such as the detached dashboard — resolves
// the isolated directory. An explicit EASY_DEVOPS_DATA_DIR always wins.
//
// EZ_DEV is set alongside it, and is what actually marks the run as
// development. The data directory alone must never imply dev mode: every
// installed service passes EASY_DEVOPS_DATA_DIR so the service and the CLI
// agree on one location, and treating that as dev issued staging certificates
// on real domains. See isDevDataDir() in core/platform.js.
if (flags.has('dev')) {
  process.env[DEV_MODE_ENV] = '1';
  if (!process.env[DATA_DIR_ENV]?.trim()) {
    process.env[DATA_DIR_ENV] = DEV_DATA_DIR;
  }
}

// Same ordering reason as the data directory: dashboard/server.js is only
// imported below, so the flag is in the environment before it can be read.
if (flags.has('classic-ui')) {
  process.env[CLASSIC_UI_ENV] = '1';
}

// Accepted and ignored: the new UI is what you get anyway.
if (flags.has('new-ui') && !flags.has('classic-ui')) {
  process.stdout.write('Note: --new-ui is the default now; the flag is no longer needed.\n');
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

/**
 * A database this account cannot write is a permissions problem, not a crash.
 *
 * It is what a normal terminal met in Windows Server mode before 1.4.3: the
 * data lives in C:\ProgramData\easy-devops, created by an elevated install,
 * and every write failed with "SqliteError: attempt to write a readonly
 * database" and a stack trace. Install and repair now give the installing
 * account access; this says so for an install that has not been repaired yet.
 *
 * @returns {Promise<boolean>} true when the error was explained
 */
async function explainDatabaseError(err) {
  const code = String(err?.code ?? '');
  const readOnly = code === 'SQLITE_READONLY' || code.startsWith('SQLITE_READONLY_')
    || /attempt to write a readonly database/i.test(String(err?.message ?? ''));
  if (!readOnly) return false;

  const { isWindows, isServerMode, getDataDir } = await import('../core/platform.js');
  let dir = '(unknown)';
  try { dir = getDataDir(); } catch { /* the message still helps */ }

  const lines = ['', '  Easy DevOps cannot write its database with this account:', `    ${dir}`, ''];
  if (isWindows && isServerMode()) {
    lines.push(
      '  In Windows Server mode the data is shared with the service. Run this once',
      '  from PowerShell opened with "Run as administrator":',
      '',
      '    ezz service repair',
      '',
      '  It lets your account use the data, and start, stop and restart the service,',
      '  without elevation from then on. No password is needed. Nothing was changed.',
    );
  } else {
    lines.push(
      '  Check that your account owns that folder and can write to it, then run the',
      '  command again. Nothing was changed.',
    );
  }
  process.stderr.write(`${lines.join('\n')}\n\n`);
  return true;
}

/**
 * One warning when the service this machine should be running needs the CLI's
 * help: leftover Server-mode data, an install that stopped, or a service whose
 * copy is an older version (finding A3, and the owner's 1.4.7 server).
 *
 * Cheap by construction: the check reads files (a package.json, the daemon's
 * lock, the install record, and the ProgramData database only when one is
 * actually there) and never runs `sc.exe`, `icacls`, the registry or
 * `systemctl` unless one of those file checks already found a problem. It
 * therefore runs on every ordinary command.
 *
 * Never repairs by itself. Windows: the existing "Relaunch as administrator?"
 * flow is offered only in an interactive terminal. Linux: the `sudo` command is
 * printed for the user to run. A pipe, a script or CI gets the warning and the
 * exact command only.
 *
 * @returns {Promise<void>}
 */
async function reportServiceHealth() {
  try {
    const { getDataDir } = await import('../core/platform.js');
    const { runServiceStartupCheck } = await import('../core/service/versionDrift.js');

    const report = await runServiceStartupCheck({
      dataDir: getDataDir(),
      deps: {
        // core/ must not import the CLI, so the prompt is injected from here.
        // Imported lazily: chalk and inquirer are only needed on Windows, in a
        // real terminal, once a problem was found.
        requireElevation: async (opts) => {
          const { requireElevation } = await import('./elevation.js');
          return requireElevation(opts);
        },
      },
    });

    // Handed off: the elevated window owns the repair, so this one must not
    // also run the command the user asked for. Declining continues normally.
    if (report.handedOff) process.exit(0);
  } catch {
    // A health warning must never be why a command fails.
  }
}

// Errors thrown later, from callbacks the dispatch below does not await. Not
// for the daemon or the dashboard: they own their crash handling (releasing
// the lock and the jobs marker), and an exit from here would pre-empt it.
if (command !== 'daemon' && !flags.has('dash')) {
  process.on('uncaughtException', async (err) => {
    if (await explainDatabaseError(err)) process.exit(1);
    process.stderr.write(`${err?.stack ?? err}\n`);
    process.exit(1);
  });
}

try {
  // Service health first, so a user whose service is behind or half-installed
  // hears it before the command they typed does its work. Skipped for the
  // commands that are themselves the fix, and for the long-running processes
  // that report it through status instead.
  const skipsServiceHealth = command === 'daemon'
    || command === '_post-update'
    || command === 'update'
    || (command === 'service' && ['install', 'repair', 'recover'].includes(args[0] ?? ''));
  if (!skipsServiceHealth) await reportServiceHealth();

  if (flags.has('dash')) {
    const { runDashboard } = await import('./dash.js');
    await runDashboard();
  } else if (command === 'system-info') {
    const { systemInfo } = await import('./menu.js');
    await systemInfo();
    process.exit(0);
  } else if (command === 'daemon') {
    // Runs in the foreground and never returns: the service managers that start
    // it (WinSW, systemd, the Startup supervisor) all expect a process they can
    // watch, and one that forks into the background looks to them like a crash.
    const { runDaemon } = await import('../core/daemon/run.js');
    process.exit(await runDaemon());
  } else if (command === 'service') {
    const action = args[0] ?? 'status';
    if (action === 'status') {
      const { getDataDir } = await import('../core/platform.js');
      const {
        inspectServiceStatusDatabase,
        formatDatabasePreflightFailure,
      } = await import('./serviceStatusPreflight.js');
      const report = inspectServiceStatusDatabase({ dataDir: getDataDir() });
      if (!report.ok) {
        process.stderr.write(formatDatabasePreflightFailure(report));
        process.exit(1);
      }
    }
    const { serviceCommand } = await import('./menus/service.js');
    // The leftover-data choice is asked by menus/service.js (lane F3 reads
    // `options.leftoverChoice`) and applied by core install({ leftoverChoice }).
    process.exit(await serviceCommand(action, { leftoverChoice }));
  } else if (command === 'runtime') {
    const { runtimeCommand } = await import('./menus/runtime.js');
    process.exit(await runtimeCommand(args[0] ?? 'status', { yes: flags.has('yes') }));
  } else if (command === 'update') {
    const { updateCommand } = await import('./menus/update.js');
    process.exit(await updateCommand({ yes: flags.has('yes') }));
  } else if (command === '_post-update') {
    const { postUpdateCommand } = await import('./menus/postUpdate.js');
    process.exit(await postUpdateCommand());
  } else if (command === 'hub') {
    const { hubCommand } = await import('./menus/hub.js');
    process.exit(await hubCommand(args[0] ?? 'status', args.slice(1), { yes: flags.has('yes') }));
  } else if (command === 'cleanup') {
    const { cleanupCommand } = await import('./menus/cleanup.js');
    process.exit(await cleanupCommand({ days: options.days, yes: flags.has('yes') }));
  } else if (command === 'uninstall') {
    const { uninstallCommand } = await import('./menus/uninstall.js');
    process.exit(await uninstallCommand({ purge: flags.has('purge'), yes: flags.has('yes') }));
  } else if (command === 'dashboard') {
    const { dashboardCommand } = await import('./menus/dashboard.js');
    process.exit(await dashboardCommand(args[0] ?? 'setup-code'));
  } else {
    // Interactive menu: Ctrl+C simply quits.
    process.on('SIGINT', () => process.exit(0));
    const { run } = await import('./menu.js');
    await run();
  }
} catch (err) {
  if (!(await explainDatabaseError(err))) throw err;
  process.exit(1);
}
