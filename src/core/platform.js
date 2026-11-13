/**
 * core/platform.js
 *
 * Shared platform constants and nginx command-building helpers.
 * Used by CLI managers, dashboard routes, and dashboard lib.
 * Centralises the isWindows guard, the persistent data directory, and nginx
 * shell invocations so they are defined exactly once and behave identically
 * everywhere. This module imports nothing from the project, so it is safe to
 * load before the database is initialised.
 */

import path from 'path';
import os from 'os';

export const isWindows = process.platform === 'win32';

/** Env var that redirects every persistent artifact to a chosen directory. */
export const DATA_DIR_ENV = 'EASY_DEVOPS_DATA_DIR';

/**
 * Env var that marks a test run. When set to '1', getDataDir() REFUSES to
 * resolve the real data directory — see assertTestDataDir().
 */
export const TEST_MODE_ENV = 'EZ_TEST';

/** The data directory a normal installation uses. */
function realDataDir() {
  return isWindows
    ? path.join(process.env.APPDATA || os.homedir(), 'easy-devops')
    : path.join(os.homedir(), '.config', 'easy-devops');
}

/** Case-insensitive on Windows, where paths are not case-sensitive. */
function isSameDir(a, b) {
  const norm = (p) => (isWindows ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
}

/** True when `child` is `parent` or lives inside it. */
function isDirWithin(child, parent) {
  const norm = (p) => (isWindows ? path.resolve(p).toLowerCase() : path.resolve(p));
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p + path.sep);
}

/**
 * Refuses to let a test run touch the real installation.
 *
 * Five separate incidents have ended with a test suite reading or writing the
 * real `%APPDATA%\easy-devops` / `~/.config/easy-devops`, every one of them
 * the same root cause: core/db.js resolves its directory ONCE at module load,
 * and a static ESM import graph is fully evaluated before the first line of
 * the importing file runs. Setting the environment variable at the top of a
 * test is therefore too late, and no amount of care in the test files fixes
 * that ordering.
 *
 * So the refusal lives here, at the one function every path goes through:
 * with EZ_TEST=1, resolving the real directory throws instead of returning.
 * A test can only ever get a directory it was explicitly given.
 *
 * Use e2e/run.mjs, which sets both variables before Node starts.
 *
 * @param {string|undefined} override The raw EASY_DEVOPS_DATA_DIR value
 */
function assertTestDataDir(override) {
  const real = realDataDir();

  const fail = (reason) => {
    throw new Error(
      `${TEST_MODE_ENV}=1 is set, so refusing to use the real data directory.\n` +
      `  reason  : ${reason}\n` +
      `  ${DATA_DIR_ENV}: ${override || '(unset)'}\n` +
      `  real dir: ${real}\n` +
      '\n' +
      'Run the e2e suites through the runner, which sets both variables before\n' +
      'Node starts and gives each suite its own temporary directory:\n' +
      '\n' +
      '  npm run test:e2e            (all suites)\n' +
      '  npm run test:e2e -- service (one suite)\n'
    );
  };

  // The failure behind all five incidents: no override at all, so the real
  // directory got resolved by default.
  if (!override) fail(`${DATA_DIR_ENV} is not set`);

  const resolved = path.resolve(override);

  // A directory under the system temp folder is throwaway by construction, so
  // it is accepted without further checks.
  //
  // This exception is needed, not merely convenient: several suites isolate
  // themselves by redirecting APPDATA/HOME into their temp directory, which
  // makes realDataDir() compute a path inside — or equal to — that same temp
  // directory. Comparing against it would then reject the safest pattern in
  // the suite while telling the user their temp directory "is" the real one.
  if (isDirWithin(resolved, os.tmpdir())) return;

  // Anywhere else, the real directory must not be reachable: not the same
  // directory, not inside it, and not a parent of it (%APPDATA% itself).
  if (isSameDir(resolved, real)) fail('it points at the real data directory');
  if (isDirWithin(resolved, real)) fail('it points inside the real data directory');
  if (isDirWithin(real, resolved)) fail('it contains the real data directory');
}

/**
 * Returns the directory holding all persistent user data: the SQLite database,
 * dashboard sessions and logs.
 *
 * Resolution order:
 *   1. EASY_DEVOPS_DATA_DIR — set by `--dev` (and inherited by child processes)
 *   2. Windows: %APPDATA%\easy-devops  (home directory if APPDATA is unset)
 *   3. Otherwise: ~/.config/easy-devops
 *
 * Principle IV: never inside the package directory, which `npm update` wipes.
 *
 * Throws when EZ_TEST=1 and the resolved directory would be the real one.
 *
 * @returns {string} Absolute path to the data directory
 */
export function getDataDir() {
  const override = process.env[DATA_DIR_ENV]?.trim();

  if (process.env[TEST_MODE_ENV] === '1') {
    assertTestDataDir(override);
    return path.resolve(override);
  }

  if (override) return path.resolve(override);

  return realDataDir();
}

/** True when the data directory came from EASY_DEVOPS_DATA_DIR (dev mode). */
export function isDevDataDir() {
  return Boolean(process.env[DATA_DIR_ENV]?.trim());
}

/**
 * Raw Node platform identifier ('win32', 'linux', 'darwin', …).
 * Exported so consumers that need to *report* the platform (e.g. to the Hub or
 * the settings API) do not have to read `process.platform` themselves.
 */
export const platformName = process.platform;

/**
 * Returns the nginx binary invocation string suitable for use in shell commands.
 * On Windows returns `& "path\nginx.exe"` (PowerShell call operator + quoted path).
 * On Linux/macOS returns the plain `nginx` command (assumed to be on PATH).
 * @param {string} nginxDir
 * @returns {string}
 */
export function getNginxExe(nginxDir) {
  if (isWindows) {
    return `& "${nginxDir}\\nginx.exe"`;
  }
  return 'nginx';
}

/**
 * Builds the nginx config-test command for the given nginx directory.
 * On Windows passes an explicit -c flag with the full conf path to avoid
 * working-directory issues when nginx.exe is invoked from an arbitrary cwd.
 * @param {string} nginxDir
 * @returns {string}
 */
export function nginxTestCmd(nginxDir) {
  if (isWindows) {
    const confPath = `${nginxDir}\\conf\\nginx.conf`;
    return `& "${nginxDir}\\nginx.exe" -c "${confPath}" -t`;
  }
  return 'nginx -t';
}

/**
 * Builds the nginx graceful-reload command.
 * @param {string} nginxDir
 * @returns {string}
 */
export function nginxReloadCmd(nginxDir) {
  if (isWindows) {
    return `& "${nginxDir}\\nginx.exe" -s reload`;
  }
  return 'nginx -s reload';
}

// ─── NGINX SERVICE CONTROL ────────────────────────────────────────────────────
//
// On Linux every command here MUST match a rule written by core/permissions.js
// into /etc/sudoers.d/easy-devops, byte for byte, or `sudo -n` fails silently:
//   /usr/bin/systemctl start nginx
//   /usr/bin/systemctl stop nginx
//   /usr/bin/systemctl reload nginx
//
// On Windows nginx.exe must be launched detached with the nginx directory as
// its working directory, otherwise it resolves relative paths such as
// logs/error.log against our cwd and dies on startup. This is the same
// Start-Process form dashboard/lib/nginx-service.js already uses successfully.

/**
 * Command that starts nginx as a long-running service.
 * @param {string} nginxDir
 * @returns {string}
 */
export function nginxServiceStartCmd(nginxDir) {
  if (isWindows) {
    const exe = path.join(nginxDir, 'nginx.exe');
    const conf = path.join(nginxDir, 'conf', 'nginx.conf');
    return `Start-Process -FilePath "${exe}" -ArgumentList '-c','"${conf}"' -WorkingDirectory "${nginxDir}" -WindowStyle Hidden`;
  }
  return 'sudo -n /usr/bin/systemctl start nginx';
}

/**
 * Command that stops nginx.
 * @param {string} nginxDir
 * @returns {string}
 */
export function nginxServiceStopCmd(nginxDir) {
  if (isWindows) return 'taskkill /f /IM nginx.exe';
  return 'sudo -n /usr/bin/systemctl stop nginx';
}

/**
 * Command that gracefully reloads nginx without dropping connections.
 * @param {string} nginxDir
 * @returns {string}
 */
export function nginxServiceReloadCmd(nginxDir) {
  if (isWindows) return `${getNginxExe(nginxDir)} -s reload`;
  return 'sudo -n /usr/bin/systemctl reload nginx';
}

/** Command that reports whether nginx is currently running. */
export function nginxIsRunningCmd() {
  return isWindows
    ? 'tasklist /FI "IMAGENAME eq nginx.exe" /NH'
    : 'pgrep -x nginx';
}

/**
 * Interprets the output of nginxIsRunningCmd().
 * @param {{ success: boolean, stdout: string, stderr: string }} result
 * @returns {boolean}
 */
export function isNginxRunning(result) {
  if (isWindows) {
    return combineOutput(result).toLowerCase().includes('nginx.exe');
  }
  return result.success && result.stdout.trim().length > 0;
}

/**
 * Merges stdout and stderr from a shell result into a single trimmed string.
 * Useful for surfacing nginx output that may come from either stream.
 * @param {{ stdout: string, stderr: string }} result
 * @returns {string}
 */
export function combineOutput(result) {
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
}

// ─── NGINX PATH FORMATTING ────────────────────────────────────────────────────
//
// nginx on Windows accepts forward slashes, and its config lexer treats a
// backslash as an escape character. An unquoted path such as
//   ssl_certificate C:\nginx\test\certs\fullchain.pem;
// therefore has \n and \t read as a newline and a tab, which is why some
// machines accept a config and others fail `nginx -t` purely because of the
// folder names involved. Forward slashes sidestep the lexer entirely.
//
// On Linux these helpers are deliberately identity functions: paths there
// contain no backslashes and must be emitted byte-for-byte unchanged.

/**
 * Converts a filesystem path into the form nginx should see in a config file.
 * Windows: backslashes become forward slashes and duplicate separators are
 * collapsed. Linux/macOS: returned unchanged.
 * @param {string} p
 * @returns {string}
 */
export function toNginxPath(p) {
  const value = String(p ?? '');
  if (!isWindows) return value;
  return value.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
}

/**
 * Converts a path into a quoted, escape-safe backslash form for nginx.
 * Used only as the Windows fallback when the forward-slash form is rejected.
 * Every backslash is doubled and the result is quoted, so nginx's lexer reads
 * each pair as one literal backslash instead of an escape sequence.
 *   C:\nginx\certs\a.pem  ->  "C:\\nginx\\certs\\a.pem"
 * @param {string} p
 * @returns {string}
 */
export function toEscapedNginxPath(p) {
  const native = String(p ?? '').replace(/\//g, '\\');
  return `"${native.replace(/\\/g, '\\\\')}"`;
}

/**
 * Returns true when a path still contains a backslash separator.
 * Used to report (never auto-rewrite) existing configs that predate the fix.
 * @param {string} p
 * @returns {boolean}
 */
export function hasBackslashPath(p) {
  return typeof p === 'string' && p.includes('\\');
}

/**
 * Extracts the config file paths nginx mentions in a failed test.
 * nginx reports the offending file as `... in <file>:<line>`.
 * @param {string} output
 * @returns {string[]} File paths, in the order nginx reported them
 */
export function parseNginxErrorFiles(output) {
  const files = [];
  const re = / in (.+?):\d+/g;
  let match;
  while ((match = re.exec(String(output ?? ''))) !== null) {
    files.push(match[1].trim());
  }
  return files;
}

/** True when two paths refer to the same file (Windows: separator- and case-insensitive). */
function samePath(a, b) {
  const norm = (v) => {
    const slashed = String(v ?? '').replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    return isWindows ? slashed.toLowerCase() : slashed;
  };
  return norm(a) === norm(b);
}

/**
 * Returns true when a failed `nginx -t` blames the certificate directives of a
 * specific config file.
 *
 * Both halves matter: the error must be about loading a certificate AND must
 * name this config file. A cert problem in some *other* config must not cause
 * this domain's paths to be rewritten.
 *
 * @param {string} output   Combined nginx test output
 * @param {string} confPath The config file we just wrote
 * @returns {boolean}
 */
export function isCertPathErrorFor(output, confPath) {
  const text = String(output ?? '');
  if (!text) return false;

  const mentionsCert =
    /cannot load certificate/i.test(text) ||
    /BIO_new_file/i.test(text) ||
    /ssl_certificate(_key)?/i.test(text) ||
    /PEM_read_bio/i.test(text);
  if (!mentionsCert) return false;

  const blamed = parseNginxErrorFiles(text);
  // No file attribution at all: fall back to the cert signal alone.
  if (blamed.length === 0) return true;

  return blamed.some((file) => samePath(file, confPath));
}

/**
 * Returns true if an `nginx -t` result indicates a valid config.
 *
 * Without root, nginx exits with code 1 after printing "syntax is ok" because
 * it cannot write /run/nginx.pid (Permission denied). The config itself is
 * valid in that case — we check the output text rather than the exit code.
 *
 * @param {{ success: boolean, stdout: string, stderr: string }} result
 * @returns {boolean}
 */
export function isNginxTestOk(result) {
  if (result.success) return true;
  const output = (result.stdout || '') + (result.stderr || '');
  return output.includes('syntax is ok');
}

// ─── PM2 / BACKGROUND SERVICE ─────────────────────────────────────────────────
//
// Easy DevOps does not implement its own daemon: PM2 keeps the dashboard alive
// and brings it back after a crash or a reboot. Every PM2 invocation is built
// here so the OS differences live in one place, and all of them are executed
// through core/shell.js by core/runner.js.
//
// `pm2 startup` covers the init systems PM2 knows (systemd, launchd, openrc,
// …) but has no Windows support at all, so Windows gets its own two paths —
// see getStartupFolder() and windowsBootTaskCmd() below.

/** Name of the Windows Task Scheduler task that resurrects PM2 at boot. */
export const WINDOWS_BOOT_TASK = 'EasyDevOps-PM2';

/** Filename of the logon launcher dropped into the user's Startup folder. */
export const WINDOWS_STARTUP_FILE = 'easy-devops-pm2.cmd';

/**
 * Quotes a path for the current shell.
 * PowerShell needs the call operator for a quoted executable path; bash does
 * not, and quoting is enough there.
 * @param {string} p
 * @returns {string}
 */
export function quoteExe(p) {
  return isWindows ? `& "${p}"` : `"${p}"`;
}

/**
 * The user's per-user Startup folder (what `shell:startup` opens).
 *
 * Resolved from APPDATA rather than through a shell call so it can be swapped
 * for a temporary directory in tests — nothing may write to the real Startup
 * folder outside a real install.
 *
 * @returns {string|null} Absolute path, or null on non-Windows
 */
export function getStartupFolder() {
  if (!isWindows) return null;
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

/**
 * Contents of the logon launcher.
 *
 * A `.cmd` file is used rather than the traditional `.vbs` wrapper: VBScript
 * is deprecated and slated for removal from Windows, so a .vbs launcher would
 * stop working on exactly the machines this targets. The cost is that the
 * .cmd's own console window flashes briefly at logon; `start /b` plus
 * `-WindowStyle Hidden` keeps the actual work invisible.
 *
 * @param {string} pm2Path Absolute path to the pm2 executable
 * @returns {string}
 */
export function windowsStartupLauncher(pm2Path) {
  return [
    '@echo off',
    'REM Easy DevOps - restores PM2 apps at logon.',
    'REM Created and removed by `ezz service install` / `ezz service uninstall`.',
    'REM Do not edit: it is rewritten on every install.',
    `start "" /b powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "& '${pm2Path}' resurrect"`,
    '',
  ].join('\r\n');
}

/**
 * Command that registers the at-boot Task Scheduler task.
 *
 * `/RP *` makes schtasks itself prompt for the password on the console, so the
 * password never reaches Easy DevOps: it is not in this string, not in argv,
 * not stored and not logged. That is also why this path needs a real terminal
 * and cannot be driven from the dashboard.
 *
 * `/DELAY` is only valid for ONSTART/ONLOGON/ONEVENT and takes mmmm:ss. The
 * delay gives the network stack time to come up before nginx is reloaded.
 *
 * The `--%` stop-parsing token is REQUIRED, not decoration. shell.js runs
 * commands through `powershell -Command`, and PowerShell rewrites the quotes
 * inside /TR on the way to a native exe. Measured against a stand-in exe that
 * printed the argv it received, the `\"..\"`, '..' and backtick-escaped forms
 * all arrived truncated at the first space ("C:\Program"), and doubled quotes
 * failed to parse at all. Only `--%` passes the value through byte for byte.
 * It also means nothing after it is expanded by PowerShell.
 *
 * No hidden-window wrapper is used around pm2 here: an ONSTART task runs in
 * session 0, which has no desktop, so there is no window to hide.
 *
 * @param {Object} opts
 * @param {string} opts.pm2Path  Absolute path to the pm2 executable
 * @param {string} opts.user     Account the task runs as, e.g. 'DOMAIN\user'
 * @param {number} [opts.delaySeconds=30]
 * @returns {string}
 */
export function windowsBootTaskCmd({ pm2Path, user, delaySeconds = 30 }) {
  const mm = String(Math.floor(delaySeconds / 60)).padStart(4, '0');
  const ss = String(delaySeconds % 60).padStart(2, '0');
  // `\"` is how the Windows CRT delivers a literal quote to schtasks.
  return [
    'schtasks --% /Create',
    `/TN "${WINDOWS_BOOT_TASK}"`,
    '/SC ONSTART',
    `/DELAY ${mm}:${ss}`,
    `/RU "${user}"`,
    '/RP *',
    `/TR "\\"${pm2Path}\\" resurrect"`,
    '/F',
  ].join(' ');
}

/** Command that removes the at-boot task. */
export function windowsBootTaskDeleteCmd() {
  return `schtasks --% /Delete /TN "${WINDOWS_BOOT_TASK}" /F`;
}

/** Command that reports whether the at-boot task exists. */
export function windowsBootTaskQueryCmd() {
  return `schtasks --% /Query /TN "${WINDOWS_BOOT_TASK}" /FO LIST`;
}

/**
 * Command that prints 1 when this Windows session is elevated, else 0.
 * The at-boot task needs administrator rights; the logon launcher does not.
 */
export function windowsIsElevatedCmd() {
  return '[int]([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())' +
    '.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)';
}

/**
 * Command that prints the OS product type: 1 workstation, 2 domain
 * controller, 3 server. Used to default the boot mode on Windows Server.
 */
export function windowsProductTypeCmd() {
  return '(Get-CimInstance Win32_OperatingSystem).ProductType';
}

/**
 * Name of the systemd unit `pm2 startup` installs for a user.
 * PM2 always uses this shape, which is what makes the unit detectable without
 * asking PM2 anything.
 * @param {string} user
 * @returns {string}
 */
export function pm2SystemdUnit(user) {
  return `pm2-${user}`;
}

/** Command that reports whether systemd is available on this machine. */
export function hasSystemctlCmd() {
  return 'command -v systemctl';
}

/**
 * Read-only check of whether PM2's init-system unit is enabled.
 *
 * Deliberately NOT `pm2 startup`: that command INSTALLS the hook when it has
 * the rights to do so (running as root it does it silently), so it can never
 * be used to merely detect state. `systemctl is-enabled` only reads.
 *
 * Prints `enabled`, `disabled`, or fails when the unit does not exist.
 *
 * @param {string} user
 * @returns {string}
 */
export function systemdIsEnabledCmd(user) {
  return `systemctl is-enabled ${pm2SystemdUnit(user)}`;
}

/**
 * Command that asks PM2 to print the init-system hook for this platform.
 * Linux/macOS only; PM2 exits non-zero when it cannot detect an init system.
 * @param {string} pm2Path
 * @returns {string}
 */
export function pm2StartupCmd(pm2Path) {
  return `${quoteExe(pm2Path)} startup`;
}

/** Command that removes PM2's init-system hook (Linux/macOS). */
export function pm2UnstartupCmd(pm2Path) {
  return `${quoteExe(pm2Path)} unstartup`;
}
