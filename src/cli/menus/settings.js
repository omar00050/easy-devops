import chalk from 'chalk';
import inquirer from 'inquirer';
import {
  loadConfig, saveConfig, AUTH_MODES, BIND_LOOPBACK, BIND_LOOPBACK_V6,
  isLoopbackBind, effectiveAuthMode,
} from '../../core/config.js';
import {
  hashPassword, validateNewPassword, MIN_PASSWORD_LENGTH,
} from '../../core/passwords.js';
import { dbGet } from '../../core/db.js';
import { isWindows } from '../../core/platform.js';
import {
  setupLinuxPermissions, checkPermissionsConfigured, buildSetupScript, deriveOwnDirs,
} from '../../core/permissions.js';
import {
  getAutoRenewSettings, normalizeAutoRenewDays, MIN_AUTO_RENEW_DAYS, MAX_AUTO_RENEW_DAYS,
} from '../../core/cert-renewal.js';
import { deployRoot, defaultDeployRoot, validateDeployDir } from '../../core/deploy/store.js';
import { page, pause, BACK } from '../ui/page.js';

export default async function settingsMenu() {
  // T021: detect missing/corrupted config before loadConfig() creates defaults
  const wasStored = dbGet('config') !== undefined;
  const config = loadConfig();
  let announceDefaults = !wasStored;

  while (true) {
    page(['Settings']);
    if (announceDefaults) {
      announceDefaults = false;
      console.log(chalk.yellow('Defaults applied — config not found or reset.'));
    }
    // T013: display current values
    const authMode = effectiveAuthMode(config);
    const hasPassword = Boolean(config.dashboardPasswordHash || config.dashboardPassword);
    const passwordDisplay = hasPassword ? '***' : '(not set)';
    const authDisplay = authMode === AUTH_MODES.NONE
      ? 'none (this machine only)'
      : `password ${passwordDisplay}`;
    const bindDisplay = isLoopbackBind(config.dashboardBindAddress)
      ? `${config.dashboardBindAddress} (this machine only)`
      : `${config.dashboardBindAddress} (all interfaces)`;
    const emailDisplay = config.acmeEmail || '(not set)';
    const autoRenew = getAutoRenewSettings(config);
    const autoRenewDisplay = autoRenew.enabled
      ? `on, ${autoRenew.days} day${autoRenew.days === 1 ? '' : 's'} before expiry`
      : 'off';

    const isLinux = !isWindows;
    const permsOk = isLinux ? await checkPermissionsConfigured() : true;

    console.log(chalk.gray('─'.repeat(40)));
    console.log(` Dashboard Port: ${chalk.cyan(config.dashboardPort)}`);
    console.log(` Dashboard Auth: ${chalk.cyan(authDisplay)}`);
    console.log(` Listen On: ${chalk.cyan(bindDisplay)}`);
    console.log(` Nginx Directory: ${chalk.cyan(config.nginxDir)}`);
    console.log(` SSL Directory: ${chalk.cyan(config.sslDir)}`);
    console.log(` ACME Email: ${chalk.cyan(emailDisplay)}`);
    console.log(` SSL Auto-Renew: ${chalk.cyan(autoRenewDisplay)}`);
    console.log(` Deployments Folder: ${chalk.cyan(deployRoot())}`);
    console.log();

    // T014: field selection
    const { field } = await inquirer.prompt([{
      type: 'list',
      name: 'field',
      message: 'Select a field to edit:',
      choices: [
        { name: `Dashboard Port (${config.dashboardPort})`, value: 'dashboardPort' },
        { name: `Dashboard Auth (${authDisplay})`, value: 'dashboardAuth' },
        { name: `Listen On (${bindDisplay})`, value: 'dashboardBindAddress' },
        { name: `Nginx Directory (${config.nginxDir})`, value: 'nginxDir' },
        { name: `SSL Directory (${config.sslDir})`, value: 'sslDir' },
        { name: `ACME Email (${emailDisplay})`, value: 'acmeEmail' },
        { name: `SSL Auto-Renew (${autoRenewDisplay})`, value: 'sslAutoRenew' },
        { name: `Deployments Folder (${deployRoot()})`, value: 'deployDir' },
        ...(isLinux ? [{
          name: permsOk
            ? '🔓 Linux Permissions  ✅ configured'
            : '🔓 Setup Linux Permissions  ⚠ required',
          value: 'permissions',
        }] : []),
        { name: BACK, value: 'back' },
      ],
    }]);

    if (field === 'back') return;

    if (field === 'permissions') {
      if (!isWindows) {
        // Same derivation and same script as the dashboard's
        // POST /api/settings/permissions/setup: one source, so the two can
        // never show or run different rules. The commands are printed BEFORE
        // anything runs, so they can be copied into a terminal by hand.
        const { ownDirs, refused } = deriveOwnDirs(config);
        const script = buildSetupScript({ ownDirs });

        for (const item of refused) {
          console.log(chalk.yellow(`\n  Skipped ${item.dir}: ${item.reason}`));
        }

        if (!script.ok) {
          console.log(chalk.red(`\n  ✗ Failed: ${script.reason}\n`));
          await pause();
          continue;
        }

        console.log(chalk.bold('\n  These commands will run now:'));
        for (const line of script.lines) console.log(chalk.gray(`    ${line}`));
        console.log(chalk.gray('\n  sudo asks for YOUR password in this terminal; Easy DevOps never sees it.\n'));

        const result = await setupLinuxPermissions({ ownDirs });
        if (result.success) {
          console.log(chalk.green('\n  ✅ Permissions configured! No more password prompts.\n'));
        } else {
          console.log(chalk.red(`\n  ✗ Failed: ${result.reason || 'unknown error'}\n`));
        }
      }
      await pause();
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

    } else if (field === 'dashboardAuth') {
      // 'none' is only offered when the dashboard cannot be reached from the
      // network. The CLI runs on the machine itself, so the loopback-request
      // half of the rule is satisfied by definition here.
      const loopbackBound = isLoopbackBind(config.dashboardBindAddress);

      const { mode } = await inquirer.prompt([{
        type: 'list',
        name: 'mode',
        message: 'How should the dashboard authenticate?',
        default: authMode,
        choices: [
          { name: 'Password', value: AUTH_MODES.PASSWORD },
          {
            name: loopbackBound
              ? 'No password (this machine only)'
              : `No password — unavailable while listening on ${config.dashboardBindAddress}`,
            value: AUTH_MODES.NONE,
            disabled: loopbackBound ? false : 'set Listen On to 127.0.0.1 first',
          },
          { name: '← Cancel', value: 'cancel' },
        ],
      }]);

      if (mode === 'cancel') continue;

      if (mode === AUTH_MODES.NONE) {
        if (!loopbackBound) {
          console.log(chalk.yellow(`\n  Not allowed while listening on ${config.dashboardBindAddress}.`));
          console.log(chalk.gray('  Set "Listen On" to this machine only first.\n'));
          await pause();
          continue;
        }
        config.dashboardAuth = AUTH_MODES.NONE;
        saveConfig(config);
        console.log(chalk.green('\n  ✓ The dashboard will no longer ask for a password.'));
        console.log(chalk.gray('  It stays reachable from this machine only.\n'));
        await pause();
        continue;
      }

      const { value } = await inquirer.prompt([{
        type: 'password',
        name: 'value',
        message: `New dashboard password (at least ${MIN_PASSWORD_LENGTH} characters)${hasPassword ? ', or blank to keep the current one' : ''}:`,
        mask: '*',
      }]);

      if (!value && hasPassword) {
        // Keep the stored password, just require it again.
        config.dashboardAuth = AUTH_MODES.PASSWORD;
        saveConfig(config);
        console.log(chalk.green('\n  ✓ A password is now required.\n'));
        await pause();
        continue;
      }

      const problem = validateNewPassword(value);
      if (problem) {
        console.log(chalk.red(`\n  ${problem}\n`));
        await pause();
        continue;
      }

      // Hashed, never stored in clear — the same path the dashboard uses.
      config.dashboardPasswordHash = await hashPassword(value);
      config.dashboardPassword = '';
      config.dashboardAuth = AUTH_MODES.PASSWORD;
      saveConfig(config);
      console.log(chalk.green('\n  ✓ Password saved.\n'));

    } else if (field === 'dashboardBindAddress') {
      const { value } = await inquirer.prompt([{
        type: 'list',
        name: 'value',
        message: 'Which interfaces should the dashboard listen on?',
        default: config.dashboardBindAddress,
        choices: [
          { name: `This machine only (${BIND_LOOPBACK})`, value: BIND_LOOPBACK },
          { name: `This machine only (IPv6 ${BIND_LOOPBACK_V6})`, value: BIND_LOOPBACK_V6 },
          { name: '← Cancel', value: 'cancel' },
        ],
      }]);

      if (value === 'cancel') continue;

      config.dashboardBindAddress = value;
      saveConfig(config);
      console.log(chalk.green('\n  ✓ Saved. Restart the dashboard for it to take effect.'));
      console.log(chalk.gray('  Remote access uses a local HTTPS reverse proxy or secure tunnel.\n'));

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

    } else if (field === 'deployDir') {
      // Only NEW apps are created here. Existing apps keep the folder they
      // were created in; moving one is done from the dashboard.
      const { value } = await inquirer.prompt([{
        type: 'input',
        name: 'value',
        message: `Folder for new deployed apps (empty = ${defaultDeployRoot()}):`,
        default: config.deployDir || '',
        validate(input) {
          if (!input.trim()) return true;
          const problem = validateDeployDir(input);
          return problem ? chalk.red(problem) : true;
        },
      }]);
      config.deployDir = value.trim() ? value.trim() : null;
      saveConfig(config);
      console.log(chalk.green(`\n  ✓ Saved. New apps will be created in ${deployRoot()}.`));
      console.log(chalk.gray('    Existing apps stay where they are.\n'));

    } else if (field === 'sslAutoRenew') {
      // The background service renews HTTP-01 certificates on its own. DNS-01
      // certificates (wildcards) need a TXT record added by hand, so they only
      // ever get the expiry warning.
      const { enabled } = await inquirer.prompt([{
        type: 'list',
        name: 'enabled',
        message: 'Renew certificates automatically before they expire?',
        default: autoRenew.enabled,
        choices: [
          { name: 'On — renew HTTP-validated certificates in the background', value: true },
          { name: 'Off — only warn before expiry', value: false },
        ],
      }]);
      config.sslAutoRenew = enabled;

      if (enabled) {
        const { days } = await inquirer.prompt([{
          type: 'input',
          name: 'days',
          message: `Renew how many days before expiry? (${MIN_AUTO_RENEW_DAYS}-${MAX_AUTO_RENEW_DAYS})`,
          default: String(autoRenew.days),
          validate(input) {
            return normalizeAutoRenewDays(input) !== null
              || chalk.red(`Enter a whole number from ${MIN_AUTO_RENEW_DAYS} to ${MAX_AUTO_RENEW_DAYS}.`);
          },
        }]);
        config.sslAutoRenewDays = normalizeAutoRenewDays(days);
      }
      saveConfig(config);

      if (enabled && !config.acmeEmail) {
        console.log(chalk.yellow('\n  ⚠ Set an ACME email too — renewal cannot run without one.\n'));
      } else {
        console.log(chalk.green('\n  ✓ Saved. The background service picks it up on its next check.\n'));
      }

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

    // The menu clears the screen when it redraws, so a saved value would
    // otherwise vanish before it could be read.
    await pause();
  }
}
