/**
 * cli/dash.js
 *
 * Runs the dashboard in the foreground (`ezz --dash`), skipping the menu.
 *
 * Importing dashboard/server.js starts the HTTP server as a side effect; this
 * module waits for it to bind, prints the URL, and installs signal handlers
 * that shut everything down cleanly so the terminal is returned on Ctrl+C.
 */

import chalk from 'chalk';
import { getDataDir, isDevDataDir } from '../core/platform.js';

/** How long a graceful shutdown may take before the process is forced out. */
const FORCE_EXIT_MS = 5000;

export async function runDashboard() {
  const { whenListening, shutdown } = await import('../dashboard/server.js');

  let port;
  try {
    port = await whenListening;
  } catch (err) {
    const hint = err?.code === 'EADDRINUSE'
      ? '\n Another process is already using that port. Stop it, or change the port in Settings.'
      : '';
    process.stderr.write(chalk.red(`\n Failed to start the dashboard: ${err.message}${hint}\n\n`));
    process.exit(1);
  }

  const url = `http://localhost:${port}`;

  console.log();
  if (isDevDataDir()) {
    console.log('  ' + chalk.bgYellow.black(' DEV MODE ') + ' ' + chalk.yellow(`data: ${getDataDir()}`));
  }
  console.log('  ' + chalk.hex('#d64a29').bold('Easy DevOps Dashboard'));
  console.log('  ' + chalk.white(url));
  console.log('  ' + chalk.gray('Press Ctrl+C to stop'));
  console.log();

  let stopping = false;

  /**
   * Shuts down and exits. shutdown() is itself idempotent, so a second Ctrl+C
   * cannot double-close; this guard only avoids printing the notice twice and
   * re-arming the force-exit timer.
   */
  const stop = async (signal) => {
    if (stopping) {
      console.log('  ' + chalk.gray('Still shutting down…'));
      return;
    }
    stopping = true;

    console.log();
    console.log('  ' + chalk.gray(`Received ${signal}, shutting down…`));

    // Safety net: never leave the user stuck if a socket refuses to close.
    const force = setTimeout(() => {
      console.log('  ' + chalk.yellow('Shutdown timed out — exiting anyway.'));
      process.exit(0);
    }, FORCE_EXIT_MS);
    force.unref();

    try {
      await shutdown();
      console.log('  ' + chalk.green('Dashboard stopped.'));
      console.log();
      process.exit(0);
    } catch (err) {
      process.stderr.write(chalk.red(`  Shutdown error: ${err.message}\n`));
      process.exit(1);
    }
  };

  process.on('SIGINT', () => { stop('SIGINT'); });
  process.on('SIGTERM', () => { stop('SIGTERM'); });
}
