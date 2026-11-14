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
  const known = new Set(['dash', 'dev', 'classic-ui', 'new-ui', 'help', 'version']);
  const flags = new Set();
  const unknown = [];
  const positionals = [];

  for (const arg of argv) {
    if (arg === '-h') { flags.add('help'); continue; }
    if (arg === '-v') { flags.add('version'); continue; }

    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (known.has(name)) flags.add(name);
      else unknown.push(arg);
      continue;
    }

    positionals.push(arg);
  }

  return {
    flags,
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

Options:
  --dash            Start the web dashboard in the foreground and print its
                    URL. Press Ctrl+C to stop it cleanly.
  --dev             Use an isolated data directory (.dev-data in the project)
                    instead of the real one, so development never touches your
                    installed configuration. Combines with --dash.
  --classic-ui      Serve the old EJS dashboard instead of the React one, for
                    one run. A temporary fallback; overrides the dashboardUi
                    setting.
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
  npm run dev               Interactive menu against .dev-data

`);
}

const { flags, command, args, unknown } = parseArgs(process.argv.slice(2));

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
  const { serviceCommand } = await import('./menus/service.js');
  process.exit(await serviceCommand(args[0] ?? 'status'));
} else {
  // Interactive menu: Ctrl+C simply quits.
  process.on('SIGINT', () => process.exit(0));
  const { run } = await import('./menu.js');
  await run();
}
