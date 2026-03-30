#!/usr/bin/env node
import { createRequire } from 'module';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { runDetection, showSystemStatus, formatStatusLine } from '../core/detector.js';

import nodejsMenu from './menus/nodejs.js';
import nginxMenu from './menus/nginx.js';
import sslMenu from './menus/ssl.js';
import domainsMenu from './menus/domains.js';
import dashboardMenu from './menus/dashboard.js';
import settingsMenu from './menus/settings.js';
import updateMenu from './menus/update.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

process.on('SIGINT', () => process.exit(0));

if (process.argv[2] === 'system-info') {
  await runDetection();
  showSystemStatus();
  process.exit(0);
}

function renderBanner() {
  const title = ` Easy DevOps v${version}`;
  const paddedTitle = title.padEnd(30);
  console.log(chalk.cyan('╔══════════════════════════════╗'));
  console.log(chalk.cyan('║') + chalk.bold(paddedTitle) + chalk.cyan('║'));
  console.log(chalk.cyan('╚══════════════════════════════╝'));
  console.log();
}

async function showMainMenu() {
  const answers = await inquirer.prompt([{
    type: 'list',
    name: 'choice',
    message: 'Select an option:',
    choices: [
      '📦 Node.js Manager',
      '🌐 Nginx Manager',
      '🔒 SSL Manager',
      '🔗 Domain Manager',
      '🎛️ Open Dashboard',
      '⚙️ Settings',
      '🔄 Check for Updates',
      '✖ Exit',
    ],
  }]);
  return answers.choice;
}

async function dispatch(choice) {
  switch (choice) {
    case '📦 Node.js Manager': await nodejsMenu(); break;
    case '🌐 Nginx Manager': await nginxMenu(); break;
    case '🔒 SSL Manager': await sslMenu(); break;
    case '🔗 Domain Manager': await domainsMenu(); break;
    case '🎛️ Open Dashboard': await dashboardMenu(); break;
    case '⚙️ Settings': await settingsMenu(); break;
    case '🔄 Check for Updates': await updateMenu(); break;
    case '✖ Exit': process.exit(0);
  }
}

async function main() {
  while (true) {
    const spinner = ora('Checking system…').start();
    await runDetection();
    spinner.stop();

    try {
      renderBanner();
      console.log(' ' + formatStatusLine());
      console.log();
    } catch {
      console.log(`\n=== Easy DevOps v${version} ===\n`);
    }

    try {
      const choice = await showMainMenu();
      await dispatch(choice);
    } catch (err) {
      if (err.name === 'ExitPromptError') {
        process.exit(0);
      }
      throw err;
    }
  }
}

await main();
