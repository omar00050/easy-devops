import chalk from 'chalk';
import inquirer from 'inquirer';
import { loadConfig, saveConfig } from '../../core/config.js';
import { dbGet } from '../../core/db.js';

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

    console.log();
    console.log(chalk.bold('⚙️  Settings'));
    console.log(chalk.gray('─'.repeat(40)));
    console.log(`  Dashboard Port:     ${chalk.cyan(config.dashboardPort)}`);
    console.log(`  Dashboard Password: ${chalk.cyan(passwordDisplay)}`);
    console.log(`  Nginx Directory:    ${chalk.cyan(config.nginxDir)}`);
    console.log(`  Certbot Directory:  ${chalk.cyan(config.certbotDir)}`);
    console.log();

    // T014: field selection
    const { field } = await inquirer.prompt([{
      type: 'list',
      name: 'field',
      message: 'Select a field to edit:',
      choices: [
        { name: `Dashboard Port     (${config.dashboardPort})`, value: 'dashboardPort' },
        { name: `Dashboard Password (${passwordDisplay})`, value: 'dashboardPassword' },
        { name: `Nginx Directory    (${config.nginxDir})`, value: 'nginxDir' },
        { name: `Certbot Directory  (${config.certbotDir})`, value: 'certbotDir' },
        { name: '← Back', value: 'back' },
      ],
    }]);

    if (field === 'back') return;

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
