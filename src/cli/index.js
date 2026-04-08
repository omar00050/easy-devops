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
const { version } = require('../../package.json');

process.on('SIGINT', () => process.exit(0));

if (process.argv[2] === 'system-info') {
  await runDetection();
  showSystemStatus();
  process.exit(0);
}

// ─── Detection cache — only re-run if stale (>60s) ───────────────────────────
const DETECTION_TTL_MS = 60_000;
let lastDetectionAt = 0;

async function runDetectionIfStale() {
  const now = Date.now();
  if (now - lastDetectionAt >= DETECTION_TTL_MS) {
    await runDetection();
    lastDetectionAt = now;
  }
}

function renderBanner() {
  const c = chalk.hex('#d64a29');
  const dim = chalk.hex('#d64a29').dim;

  // Compact "EZ" logo — 6 lines, ~20 chars wide, fits any 80-col terminal
  const logo = [
    '███████╗███████╗',
    '██╔════╝╚════██╗',
    '█████╗      ██╔╝',
    '██╔══╝     ██╔╝ ',
    '███████╗ ██████╗',
    '╚══════╝ ╚═════╝',
  ];

  const gap = '    ';
  const info = [
    chalk.bold.white('Easy DevOps') + '  ' + chalk.hex('#d64a29')(`v${version}`),
    dim('─────────────────────'),
    chalk.hex('#888888')('CLI & Web Dashboard'),
    chalk.hex('#888888')('Nginx · SSL · Domains · Node.js'),
    '',
    '',
  ];

  console.log();
  logo.forEach((line, i) => {
    console.log('  ' + c(line) + gap + (info[i] ?? ''));
  });
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
    await runDetectionIfStale();
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
