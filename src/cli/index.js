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

// Must match DATA_DIR_ENV in core/platform.js. Hardcoded rather than imported
// because importing platform.js here is fine, but keeping this file free of
// project imports makes the ordering guarantee obvious at a glance.
const DATA_DIR_ENV = 'EASY_DEVOPS_DATA_DIR';

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
  const known = new Set(['dash', 'dev', 'help', 'version']);
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
  service <action>  Run the dashboard in the background through PM2.
                    Actions: install, uninstall, status, restart, logs

Options:
  --dash            Start the web dashboard in the foreground and print its
                    URL. Press Ctrl+C to stop it cleanly.
  --dev             Use an isolated data directory (.dev-data in the project)
                    instead of the real one, so development never touches your
                    installed configuration. Combines with --dash.
  -h, --help        Show this help
  -v, --version     Show the version

Examples:
  ezz                       Interactive menu
  ezz --dash                Run the dashboard in this terminal
  ezz --dev --dash          Run the dashboard against .dev-data
  ezz service install       Keep the dashboard running in the background
  ezz service status        Show whether the service runs and starts on boot
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
if (flags.has('dev') && !process.env[DATA_DIR_ENV]?.trim()) {
  process.env[DATA_DIR_ENV] = DEV_DATA_DIR;
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

if (flags.has('dash')) {
  const { runDashboard } = await import('./dash.js');
  await runDashboard();
} else if (command === 'system-info') {
  const { systemInfo } = await import('./menu.js');
  await systemInfo();
  process.exit(0);
} else if (command === 'service') {
  const { serviceCommand } = await import('./menus/service.js');
  process.exit(await serviceCommand(args[0] ?? 'status'));
} else {
  // Interactive menu: Ctrl+C simply quits.
  process.on('SIGINT', () => process.exit(0));
  const { run } = await import('./menu.js');
  await run();
}
