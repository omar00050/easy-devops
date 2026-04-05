import chalk from 'chalk';
import inquirer from 'inquirer';
import { loadConfig, saveConfig } from '../../core/config.js';
import { dbGet } from '../../core/db.js';
import { setupLinuxPermissions, checkPermissionsConfigured } from '../../core/permissions.js';

export default async function settingsMenu() {
  // T021: detect missing/corrupted config before loadConfig() creates defaults
  const wasStored = dbGet('config') !== undefined;
  const config = loadConfig();

  if (!wasStored) {
    console.log(chalk.yellow('\nDefaults applied — config not found or reset.'));
  }

  while (true) {
    // T013: display current values
    const passwordDisplay = config.dashboardPassword ? '***' : '(not set)';
    const emailDisplay = config.acmeEmail || '(not set)';

    const isLinux = process.platform !== 'win32';
    const permsOk = isLinux ? await checkPermissionsConfigured() : true;

    console.log();
    console.log(chalk.bold('⚙️ Settings'));
    console.log(chalk.gray('─'.repeat(40)));
    console.log(` Dashboard Port: ${chalk.cyan(config.dashboardPort)}`);
    console.log(` Dashboard Password: ${chalk.cyan(passwordDisplay)}`);
    console.log(` Nginx Directory: ${chalk.cyan(config.nginxDir)}`);
    console.log(` SSL Directory: ${chalk.cyan(config.sslDir)}`);
    console.log(` ACME Email: ${chalk.cyan(emailDisplay)}`);
    console.log();

    // T014: field selection
    const { field } = await inquirer.prompt([{
      type: 'list',
      name: 'field',
      message: 'Select a field to edit:',
      choices: [
        { name: `Dashboard Port (${config.dashboardPort})`, value: 'dashboardPort' },
        { name: `Dashboard Password (${passwordDisplay})`, value: 'dashboardPassword' },
        { name: `Nginx Directory (${config.nginxDir})`, value: 'nginxDir' },
        { name: `SSL Directory (${config.sslDir})`, value: 'sslDir' },
        { name: `ACME Email (${emailDisplay})`, value: 'acmeEmail' },
        ...(isLinux ? [{
          name: permsOk
            ? '🔓 Linux Permissions  ✅ configured'
            : '🔓 Setup Linux Permissions  ⚠ required',
          value: 'permissions',
        }] : []),
        { name: '← Back', value: 'back' },
      ],
    }]);

    if (field === 'back') return;

    if (field === 'permissions') {
      if (process.platform !== 'win32') {
        console.log(chalk.yellow('\n  You will be prompted for your sudo password once.\n'));
        const result = await setupLinuxPermissions();
        if (result.success) {
          console.log(chalk.green('\n  ✅ Permissions configured! No more password prompts.\n'));
        } else {
          console.log(chalk.red(`\n  ✗ Failed: ${result.reason || 'unknown error'}\n`));
        }
      }
      continue;
    }

    if (field === 'dashboardPort') {
      // T015: port validation with inline error + re-prompt
      const { value } = await inquirer.prompt([{
        type: 'input',
        name: 'value',
        message: 'Dashboard port (1–65535):',
        default: String(config.dashboardPort),
        validate(input) {
          const port = parseInt(input, 10);
          if (isNaN(port) || !Number.isInteger(port) || port < 1 || port > 65535) {
            return chalk.red('Must be an integer between 1 and 65535.');
          }
          return true;
        },
      }]);
      config.dashboardPort = parseInt(value, 10);
      saveConfig(config); // T016

    } else if (field === 'dashboardPassword') {
      const { value } = await inquirer.prompt([{
        type: 'password',
        name: 'value',
        message: 'New dashboard password (leave blank to clear):',
        mask: '*',
      }]);
      config.dashboardPassword = value;
      saveConfig(config); // T016

    } else if (field === 'acmeEmail') {
      const { value } = await inquirer.prompt([{
        type: 'input',
        name: 'value',
        message: 'ACME Email (Let\'s Encrypt):',
        default: config.acmeEmail || '',
        validate(input) {
          if (input && !input.includes('@')) {
            return chalk.red('Please enter a valid email address.');
          }
          return true;
        },
      }]);
      config.acmeEmail = value;
      saveConfig(config); // T016

    } else {
      const { value } = await inquirer.prompt([{
        type: 'input',
        name: 'value',
        message: `New value for ${field}:`,
        default: config[field],
      }]);
      config[field] = value;
      saveConfig(config); // T016
    }
  }
}
