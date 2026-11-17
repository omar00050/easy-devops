import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import {
  findFreePort,
  getDashboardStatus,
  startDashboard,
  stopDashboard,
} from '../../core/dashboardProcess.js';
import { run } from '../../core/shell.js';

// ─── Browser ──────────────────────────────────────────────────────────────────

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `Start-Process "${url}"` : `xdg-open "${url}"`;
  run(cmd).catch(() => {});
}

// ─── Usage Info ──────────────────────────────────────────────────────────────

function showUsageInfo() {
  console.log(chalk.cyan('\n How to use the Dashboard:'));
  console.log(chalk.gray(' ─'.repeat(40)));
  console.log('  1. Start the dashboard from this menu');
  console.log('  2. Open it in your browser (or visit the URL shown)');
  console.log('  3. Log in with the admin password from config');
  console.log('  4. Use the dashboard to:');
  console.log(chalk.gray('     • Manage domains → create nginx configs'));
  console.log(chalk.gray('     • View SSL certificates'));
  console.log(chalk.gray('     • Control nginx (start/stop/reload)'));
  console.log(chalk.gray('     • Edit nginx configuration files'));
  console.log();
  console.log(chalk.yellow(' Default login:'));
  console.log(chalk.gray('   Username: admin'));
  console.log(chalk.gray('   Password: (check your config or set one)'));
  console.log();
}

// ─── `ezz dashboard <action>` ─────────────────────────────────────────────────

const DASHBOARD_ACTIONS = ['setup-code'];

/**
 * Issues a new first-run setup code and prints it.
 *
 * CLI-only, deliberately: the code's whole purpose is to prove that whoever is
 * setting the first password can read this machine's terminal or its service
 * log. An endpoint that handed it out would defeat it, so there is none — and
 * this is also the only way back once a code has expired or been invalidated
 * by too many wrong guesses.
 *
 * @returns {Promise<number>} Process exit code
 */
async function issueSetupCode() {
  const { loadConfig } = await import('../../core/config.js');
  const setupCode = await import('../../core/setupCode.js');

  const config = loadConfig();

  if (!setupCode.setupPending(config)) {
    console.log();
    console.log('  ' + chalk.white('The dashboard is already set up.'));
    console.log('  ' + chalk.gray('A setup code only applies before the first password is set.'));
    console.log('  ' + chalk.gray('Change the password in the dashboard under Settings.'));
    console.log();
    // Any leftover code is removed rather than left outstanding.
    if (setupCode.clear()) {
      console.log('  ' + chalk.gray('An outstanding code was cleared.'));
      console.log();
    }
    return 0;
  }

  const issued = await setupCode.issue();

  for (const line of setupCode.describe({ code: issued.code, expiresAt: issued.expiresAt })) {
    console.log(line);
  }
  console.log('  ' + chalk.gray('This replaces any code issued earlier.'));
  console.log();

  return 0;
}

/**
 * Entry point for the `dashboard` command.
 *
 * @param {string} action
 * @returns {Promise<number>} Process exit code
 */
export async function dashboardCommand(action) {
  if (!DASHBOARD_ACTIONS.includes(action)) {
    process.stderr.write(
      `Unknown dashboard action: ${action}\n` +
      `Available: ${DASHBOARD_ACTIONS.join(', ')}\n`
    );
    return 1;
  }

  switch (action) {
    case 'setup-code': return issueSetupCode();
    default: return 1;
  }
}

// ─── Menu ─────────────────────────────────────────────────────────────────────

export default async function dashboardMenu() {
  while (true) {
    const spinner = ora('Checking dashboard status...').start();
    const status = await getDashboardStatus();

    // The background SERVICE no longer runs the dashboard — it runs the daemon,
    // which serves no UI. So this menu always owns starting and stopping the
    // dashboard; what the service state changes is only what to tell the user
    // about monitoring.
    let background = null;
    try {
      const { backgroundServiceState } = await import('../../core/service/index.js');
      background = backgroundServiceState();
    } catch { /* unreadable state: the dashboard lines below still apply */ }
    spinner.stop();

    const url = `http://localhost:${status.port}`;

    console.log(chalk.bold('\n  Dashboard'));
    console.log(chalk.gray('  ' + '─'.repeat(40)));

    if (status.running) {
      console.log(`  ${chalk.green('✅ Running')}  |  ${chalk.cyan(url)}  |  PID ${status.pid}`);
    } else {
      console.log(`  ${chalk.red('❌ Stopped')}  |  port ${status.configPort}`);
    }

    // Whether monitoring survives closing the dashboard is a separate fact,
    // and the one users were surprised by.
    if (background?.running) {
      console.log(chalk.gray(`  Background service running (pid ${background.pid}) — monitoring continues without this page.`));
    } else if (background?.installed) {
      console.log(chalk.yellow('  Background service installed but not running') + chalk.gray(' — `ezz service start`'));
    } else {
      console.log(chalk.gray('  No background service — monitoring runs only while the dashboard is open.'));
    }
    console.log();

    const choices = status.running
      ? ['Open in browser', 'Stop dashboard', 'How to use', new inquirer.Separator(), '← Back']
      : ['Start dashboard', 'How to use', new inquirer.Separator(), '← Back'];

    let choice;
    try {
      ({ choice } = await inquirer.prompt([{
        type:    'list',
        name:    'choice',
        message: 'Select an option:',
        choices,
      }]));
    } catch (err) {
      if (err.name === 'ExitPromptError') return;
      throw err;
    }

    switch (choice) {
      case 'Start dashboard': {
        const portToUse = await findFreePort(status.configPort);

        if (portToUse !== status.configPort) {
          console.log(chalk.yellow(`\n  Port ${status.configPort} is in use — using port ${portToUse} instead.`));
        }

        const sp = ora(`Starting dashboard on port ${portToUse}...`).start();
        const result = await startDashboard(portToUse);

        if (result.success) {
          sp.succeed(`Dashboard started  ->  http://localhost:${portToUse}  (PID ${result.pid})`);
        } else {
          sp.fail(`Dashboard did not start — check log: ${result.logPath}`);
        }
        break;
      }

      case 'Stop dashboard': {
        const sp = ora('Stopping dashboard...').start();
        await stopDashboard(status.pid);
        sp.succeed('Dashboard stopped');
        break;
      }

      case 'Open in browser':
        openBrowser(url);
        console.log(chalk.gray(`\n  Opening ${url} ...\n`));
        break;

      case '← Back':
        return;
    }

    if (choice !== '← Back') {
      try {
        await inquirer.prompt([{ type: 'input', name: '_', message: 'Press Enter to continue...' }]);
      } catch (err) {
        if (err.name === 'ExitPromptError') return;
        throw err;
      }
    }
  }
}
