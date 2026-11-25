/**
 * core/platform.js
 *
 * Shared platform constants and nginx command-building helpers.
 * Used by CLI managers, dashboard routes, and dashboard lib.
 * Centralises the isWindows guard, the persistent data directory, and nginx
 * shell invocations so they are defined exactly once and behave identically
 * everywhere. It reaches nothing that touches the database — the one project
 * import is core/shell.js, which only spawns when it is called — so it is safe
 * to load before the database is initialised.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';

import { run as runShell } from './shell.js';

export const isWindows = process.platform === 'win32';

/** Env var that redirects every persistent artifact to a chosen directory. */
export const DATA_DIR_ENV = 'EASY_DEVOPS_DATA_DIR';

/**
 * Env var that marks a test run. When set to '1', getDataDir() REFUSES to
 * resolve the real data directory — see assertTestDataDir().
 */
export const TEST_MODE_ENV = 'EZ_TEST';

/**
 * Windows system locations are resolved from fixed machine roots.
 *
 * An unprivileged process can set ProgramData and SystemRoot before asking
 * Windows for elevation. Trusting either value inside the elevated child would
 * let the caller choose where the service is installed or which icacls.exe is
 * run. Tests may redirect ProgramData into their own temporary directory, but
 * production never accepts a caller-supplied machine root.
 */
export const WINDOWS_SYSTEM_ROOT = 'C:\\Windows';
export const WINDOWS_PROGRAM_DATA_ROOT = 'C:\\ProgramData';
export const WINDOWS_PROGRAM_FILES_ROOT = 'C:\\Program Files';
export const WINDOWS_PROGRAM_FILES_X86_ROOT = 'C:\\Program Files (x86)';

/**
 * The per-user data directory: where a normal, non-service install lives.
 */
function userDataDir() {
  return isWindows
    ? path.join(process.env.APPDATA || os.homedir(), 'easy-devops')
    : path.join(os.homedir(), '.config', 'easy-devops');
}

/**
 * The machine-wide data directory, used when the Windows service is installed.
 *
 * A Windows service running as `NT SERVICE\EasyDevOps` has no `%APPDATA%` of
 * the installing user — a virtual account's profile is not that user's — so a
 * per-user directory cannot be shared between the service and the CLI. Putting
 * the data under ProgramData is what lets the service, the CLI and the
 * dashboard all see one database.
 */
export function programDataDir() {
  let root = WINDOWS_PROGRAM_DATA_ROOT;
  if (process.env[TEST_MODE_ENV] === '1') {
    const testRoot = process.env.ProgramData?.trim();
    if (testRoot && path.isAbsolute(testRoot) && isDirWithin(testRoot, os.tmpdir())) {
      root = path.win32.resolve(testRoot);
    }
  }
  return path.win32.join(root, 'easy-devops');
}

/**
 * Marker written by `ezz service install` in Server mode.
 *
 * Its presence — not the service's running state — is what selects the
 * machine-wide directory. That distinction matters: a stopped or uninstalled
 * service must not silently move the data back to `%APPDATA%`, because the
 * data in ProgramData is then the real data and the per-user directory is a
 * stale copy. `ezz service uninstall` asks before moving anything and removes
 * this marker only if the user chooses to move back.
 */
export function serverModeMarkerPath() {
  return path.join(programDataDir(), '.server-mode');
}

/**
 * Cached because getDataDir() is called on nearly every code path and this
 * would otherwise be a filesystem stat each time. The migration is the only
 * thing that changes the answer within one process's life, and it calls
 * resetDataDirCache() when it does.
 */
let serverModeCache = null;

/** True when this machine is in Server mode (the marker exists). */
export function isServerMode() {
  if (!isWindows) return false;
  if (serverModeCache !== null) return serverModeCache;

  try {
    serverModeCache = fs.existsSync(serverModeMarkerPath());
  } catch {
    // An unreadable ProgramData is not Server mode. Erring toward the per-user
    // directory keeps a non-elevated CLI working rather than failing outright.
    serverModeCache = false;
  }

  return serverModeCache;
}

/** Forgets the cached Server-mode answer. Called by the data-dir migration. */
export function resetDataDirCache() {
  serverModeCache = null;
}

/**
 * The data directory a normal installation uses, Server mode included.
 */
function realDataDir() {
  return isServerMode() ? programDataDir() : userDataDir();
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
  // Every directory a real installation could be using, not just the one it
  // would resolve to right now. Server mode depends on a marker file, so
  // whether `realDataDir()` returns ProgramData varies with machine state —
  // and a guard that protected only the currently-selected directory would
  // leave the other one exposed on exactly the machines where it matters.
  // Both are refused unconditionally.
  const real = realDataDir();
  const forbidden = [userDataDir()];
  if (isWindows) forbidden.push(programDataDir());

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

  // Anywhere else, no real directory may be reachable: not the same directory,
  // not inside it, and not a parent of it (%APPDATA% or ProgramData itself).
  for (const dir of forbidden) {
    if (isSameDir(resolved, dir)) fail(`it points at a real data directory (${dir})`);
    if (isDirWithin(resolved, dir)) fail(`it points inside a real data directory (${dir})`);
    if (isDirWithin(dir, resolved)) fail(`it contains a real data directory (${dir})`);
  }
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

/**
 * Env var that explicitly marks a development run.
 *
 * Exists because "dev mode" and "a redirected data directory" are different
 * questions, and conflating them caused a real incident — see below.
 */
export const DEV_MODE_ENV = 'EZ_DEV';

/** The project-local directory `--dev` points at. */
const DEV_DIR_NAME = '.dev-data';

/**
 * True for a DEVELOPMENT run: Let's Encrypt staging, `-dev` process names, and
 * the legacy data migration skipped.
 *
 * It used to be `Boolean(process.env.EASY_DEVOPS_DATA_DIR)` — the mere presence
 * of a redirected data directory. That was wrong and shipped a serious bug: the
 * Windows Personal-mode launcher sets `EASY_DEVOPS_DATA_DIR` to the ordinary
 * `%APPDATA%\easy-devops` so the service and the CLI agree on one location, and
 * that alone put the daemon into dev mode — issuing **staging certificates**,
 * which browsers reject, on a user's real domains. The same trap applied to the
 * systemd unit and the Windows service, both of which also set the variable.
 *
 * So dev mode is now decided by intent, never by a side effect:
 *
 *   1. `EZ_DEV=1` — set explicitly by `--dev`.
 *   2. the resolved directory IS a `.dev-data` directory — which is what
 *      `--dev` points at, so an inherited environment still reads as dev
 *      without the flag having to be passed down.
 *
 * A redirected directory that is neither of those is a production install that
 * simply keeps its data somewhere specific. That is the normal case for every
 * installed service.
 *
 * @returns {boolean}
 */
export function isDevDataDir() {
  if (process.env[DEV_MODE_ENV] === '1') return true;

  const override = process.env[DATA_DIR_ENV]?.trim();
  if (!override) return false;

  // Compared on the final path segment rather than against one absolute path,
  // so a checkout anywhere still reads as dev.
  return path.basename(path.resolve(override)).toLowerCase() === DEV_DIR_NAME;
}

/**
 * True when `dir` is exactly what getDataDir() would resolve to with no
 * override at all.
 *
 * Service and launcher definitions use this to decide whether to pass
 * `EASY_DEVOPS_DATA_DIR` in the environment. When the answer is the default,
 * passing it is redundant — and redundant environment variables are not free:
 * the one that was being passed here turned on dev mode, because dev mode used
 * to be inferred from its mere presence. That inference is fixed, and the
 * variable is also no longer set needlessly, so a future regression of either
 * one on its own cannot reproduce the bug.
 *
 * @param {string} dir
 * @returns {boolean}
 */
export function isDefaultDataDir(dir) {
  if (!dir) return false;
  return isSameDir(dir, realDataDir());
}

/**
 * Command that reports whether this is a Windows Server edition.
 *
 * `InstallationType` in the CurrentVersion key is `Client`, `Server` or
 * `Server Core`. It is the right signal and the cheapest: `os.release()` does
 * not distinguish a server from a workstation at all (both report 10.0.x), and
 * the WMI route (`Get-CimInstance Win32_OperatingSystem`) takes seconds to
 * start its service on a cold machine. Measured on Windows 10: this returns
 * `Client` immediately.
 *
 * Returns the raw value on stdout, so the caller decides what it means.
 *
 * @returns {string}
 */
export function windowsEditionQueryCmd() {
  return "(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion')"
    + '.InstallationType';
}

/**
 * Command that reports the Windows product name, for display.
 * @returns {string}
 */
export function windowsProductNameCmd() {
  return "(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion').ProductName";
}

/**
 * Command that prints `True` only when this process runs ELEVATED.
 *
 * Membership of Administrators is not enough: with UAC on, an administrator's
 * normal terminal carries a filtered token, and IsInRole(Administrator) is
 * false there until "Run as administrator". That is exactly the question —
 * a filtered token is what makes Windows raise a UAC prompt for the wrapper.
 * @returns {string}
 */
export function windowsElevationCheckCmd() {
  return '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())'
    + '.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)';
}

/**
 * Command that prints `<SID>|<DOMAIN\name>` for the account this process runs as.
 *
 * The SID is what an ACL or a service DACL is written against; the name is only
 * for display. Asked of Windows rather than read from %USERNAME%, which a
 * caller can set to anything.
 * @returns {string}
 */
export function windowsCurrentUserCmd() {
  return '$i = [Security.Principal.WindowsIdentity]::GetCurrent(); "$($i.User.Value)|$($i.Name)"';
}

/**
 * PowerShell's UAC API needs one argument string. Carry the relaunch arguments
 * as encoded JSON data; neither PowerShell parses any of those values as code.
 */
export function windowsElevatedRelaunchCmd({ execPath, script, args = [], cwd, env = {} }) {
  const sid = env.EZ_OPERATOR_SID;
  if (Object.keys(env).some(name => name !== 'EZ_OPERATOR_SID')
      || (sid !== undefined && !/^S-[0-9]+(?:-[0-9]+)+$/.test(sid))) {
    throw new Error('refusing to pass an unexpected environment value to an elevated process');
  }
  const payload = Buffer.from(JSON.stringify({ execPath, script, args, sid }), 'utf8').toString('base64');
  const lines = [
    `$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json`,
    // The unelevated caller can set any inherited variable before UAC. Start
    // the elevated copy from a clean environment, then rebuild the machine and
    // user values it needs from Windows rather than from the caller.
    'Get-ChildItem Env: | Remove-Item -ErrorAction SilentlyContinue',
    "$env:SystemRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)",
    "$env:ProgramData = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)",
    "$env:USERPROFILE = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)",
    "$env:APPDATA = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)",
    "$env:LOCALAPPDATA = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)",
    "$env:SystemDrive = [Environment]::GetEnvironmentVariable('SystemDrive', 'Machine')",
    '$env:WINDIR = $env:SystemRoot',
    "$env:ProgramFiles = [Environment]::GetEnvironmentVariable('ProgramFiles', 'Machine')",
    "${env:ProgramFiles(x86)} = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)', 'Machine')",
    "$env:ProgramW6432 = [Environment]::GetEnvironmentVariable('ProgramW6432', 'Machine')",
    "$env:CommonProgramFiles = [Environment]::GetEnvironmentVariable('CommonProgramFiles', 'Machine')",
    "${env:CommonProgramFiles(x86)} = [Environment]::GetEnvironmentVariable('CommonProgramFiles(x86)', 'Machine')",
    "$env:CommonProgramW6432 = [Environment]::GetEnvironmentVariable('CommonProgramW6432', 'Machine')",
    "$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine')",
    "$env:PATHEXT = [Environment]::GetEnvironmentVariable('PATHEXT', 'Machine')",
    "$env:TEMP = [Environment]::GetEnvironmentVariable('TEMP', 'Machine')",
    "$env:TMP = [Environment]::GetEnvironmentVariable('TMP', 'Machine')",
    "if (-not $env:TEMP) { $env:TEMP = Join-Path $env:SystemRoot 'Temp' }",
    'if (-not $env:TMP) { $env:TMP = $env:TEMP }',
    "$env:NUMBER_OF_PROCESSORS = [Environment]::GetEnvironmentVariable('NUMBER_OF_PROCESSORS', 'Machine')",
    "$env:PROCESSOR_ARCHITECTURE = [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITECTURE', 'Machine')",
    "$env:ComSpec = Join-Path $env:SystemRoot 'System32\\cmd.exe'",
    "$env:PSModulePath = @((Join-Path $env:ProgramFiles 'WindowsPowerShell\\Modules'), (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\Modules')) -join ';'",
    'if ($p.sid) { $env:EZ_OPERATOR_SID = $p.sid } else { Remove-Item Env:EZ_OPERATOR_SID -ErrorAction SilentlyContinue }',
    // Never inherit a caller-controlled working directory. Node resolves the
    // entry script from its absolute path, and any helper that searches the
    // current directory must therefore see the protected Windows directory.
    'Set-Location -LiteralPath $env:SystemRoot -ErrorAction Stop',
    '$nodeItem = Get-Item -LiteralPath $p.execPath -Force -ErrorAction Stop',
    "if ($nodeItem.PSIsContainer) { throw 'The selected node.exe is not a file.' }",
    '$p.execPath = $nodeItem.FullName',
    '$nodeSignature = Get-AuthenticodeSignature -FilePath $p.execPath -ErrorAction Stop',
    "if ($nodeSignature.Status -ne 'Valid') { throw 'The selected node.exe does not have a valid Authenticode signature.' }",
    '$cliArgs = @($p.script) + @($p.args)',
    '& $p.execPath @cliArgs',
    'Write-Host "Easy DevOps finished (exit code $LASTEXITCODE). This window stays open; close it when you are done."',
  ];
  const encoded = Buffer.from(lines.join('\n'), 'utf16le').toString('base64');
  return "try { Start-Process -FilePath 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' "
    + '-Verb RunAs -ErrorAction Stop '
    + `-ArgumentList '-NoExit','-NoProfile','-EncodedCommand','${encoded}'; 'relaunched' } `
    + "catch { 'relaunch-failed: ' + $_.Exception.Message; exit 1 }";
}

/**
 * The Service Control Manager's command-line tool, always with its extension.
 *
 * Commands run through PowerShell on Windows, and there `sc` is the built-in
 * alias for Set-Content: `sc query EasyDevOps` silently wrote a file named
 * `query` containing "EasyDevOps" into the current directory and "succeeded".
 * 1.4.0 shipped that, which is why status read "unknown" and stop/start did
 * nothing. `sc.exe` names the real program in PowerShell and cmd alike.
 */
export const WINDOWS_SC = 'sc.exe';

/**
 * Address the daemon listens on for local event delivery to a dashboard.
 *
 * Two different kinds of thing behind one name, which is why it lives here:
 *
 *  - Windows: a named pipe. `\\.\pipe\...` is a name in a kernel namespace,
 *    not a path on disk — it cannot live in the data directory, so the data
 *    directory is HASHED into the name instead. That keeps a dev instance
 *    (`--dev`, its own data dir) from talking to the real one, which sharing a
 *    fixed pipe name would otherwise allow.
 *  - Everything else: a Unix socket file inside the data directory, which
 *    gives the same isolation for free and inherits the directory's
 *    permissions.
 *
 * @param {string} dataDir
 * @returns {string}
 */
export function daemonIpcPath(dataDir) {
  if (!isWindows) return path.join(dataDir, 'daemon.sock');

  // A short, stable hash: the pipe namespace is flat and a full path would be
  // both too long and full of characters that are not allowed in a pipe name.
  const key = createHash('sha256').update(path.resolve(dataDir).toLowerCase()).digest('hex').slice(0, 12);
  return `\\\\.\\pipe\\easy-devops-${key}`;
}

/**
 * Where an nginx log file actually lives.
 *
 * The only correct resolver, and the reason it exists: three places resolved
 * this independently and one of them was wrong. `getLogs()` in
 * core/nginx-service.js read `<nginxDir>/logs/error.log` unconditionally,
 * which is the Windows layout — so on Linux, where a distribution nginx logs
 * to /var/log/nginx, the dashboard's log view was permanently empty. The live
 * tail in the socket layer had the branch right, which is why the bug showed
 * up as "the tail works but the log page does not".
 *
 * @param {string} nginxDir
 * @param {'error'|'access'} [which]
 * @returns {string}
 */
export function nginxLogPath(nginxDir, which = 'error') {
  const file = which === 'access' ? 'access.log' : 'error.log';

  // A Windows nginx is a self-contained directory: binary, conf and logs.
  if (isWindows) return path.join(nginxDir, 'logs', file);

  // On Linux the package puts logs under /var/log, not under the config
  // directory, and nginxDir there is /etc/nginx.
  return `/var/log/nginx/${file}`;
}

/**
 * Raw Node platform identifier ('win32', 'linux', 'darwin', …).
 * Exported so consumers that need to *report* the platform (e.g. to the Hub or
 * the settings API) do not have to read `process.platform` themselves.
 */
export const platformName = process.platform;

/**
 * The full command line of a running process, or null when it cannot be read.
 *
 * Exists for one reason: a pid recorded on disk (`dashboard-pid`) may belong
 * to a completely unrelated process by the time someone acts on it, because
 * the OS reuses pids. Before signalling such a pid, the caller must be able to
 * ask what that process actually is — and that question differs by platform,
 * which is why it lives here and nowhere else:
 *
 *   - Linux: `/proc/<pid>/cmdline` is NUL-separated argv. Read directly, with
 *     no subprocess at all, so this works in a context with no shell.
 *   - Windows: there is no such file, so `Get-CimInstance` is asked through
 *     core/shell.js like every other command.
 *
 * The result is a display string, not a parsed argv: callers only ever look
 * for a path inside it. A process that has exited, a pid that never existed,
 * and a machine that denies access all answer null — "I could not check" —
 * which callers must treat as "not verified".
 *
 * @param {number} pid
 * @returns {Promise<string|null>}
 */
export async function readProcessCommandLine(pid) {
  // Never interpolate an unvalidated value into a shell command.
  if (!Number.isInteger(pid) || pid <= 0) return null;

  if (isWindows) {
    const query = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`;
    const result = await runShell(query);
    if (!result.success) return null;
    const text = String(result.stdout ?? '').trim();
    return text || null;
  }

  try {
    const raw = await fs.promises.readFile(`/proc/${pid}/cmdline`);
    const text = raw.toString('utf8').split('\0').filter(Boolean).join(' ').trim();
    return text || null;
  } catch {
    return null;
  }
}

/**
 * Quote one value as a PowerShell single-quoted literal.
 *
 * Values inserted into a PowerShell command can contain `$`, backticks or
 * parentheses from a saved nginx directory. Single quotes make all of those
 * literal. A single quote itself is represented by doubling it.
 */
export function powerShellLiteral(value) {
  const text = String(value ?? '');
  if (/[\0\r\n]/.test(text)) {
    throw new Error('PowerShell arguments cannot contain control characters');
  }
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * Builds a PowerShell invocation of an executable with literal arguments.
 * Every value is single-quoted, so `$`, backticks, parentheses and quotes have
 * no evaluator meaning.
 *
 * @param {string} file
 * @param {string[]} [args]
 * @returns {string}
 */
export function powerShellCall(file, args = []) {
  const rendered = args.map((arg) => powerShellLiteral(String(arg)));
  return `& ${powerShellLiteral(file)}${rendered.length ? ` ${rendered.join(' ')}` : ''}`;
}

/**
 * Returns the nginx binary invocation string suitable for PowerShell.
 * On Windows returns `& 'path\nginx.exe'`.
 * On Linux/macOS returns the plain `nginx` command (assumed to be on PATH).
 * @param {string} nginxDir
 * @returns {string}
 */
export function getNginxExe(nginxDir) {
  if (isWindows) {
    return `& ${powerShellLiteral(`${nginxDir}\\nginx.exe`)}`;
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
    return `& ${powerShellLiteral(`${nginxDir}\\nginx.exe`)} -c ${powerShellLiteral(confPath)} -t`;
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
    return `& ${powerShellLiteral(`${nginxDir}\\nginx.exe`)} -s reload`;
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
// Start-Process form core/nginx-service.js already uses successfully.

/**
 * Command that starts nginx as a long-running service.
 * @param {string} nginxDir
 * @returns {string}
 */
export function nginxServiceStartCmd(nginxDir) {
  if (isWindows) {
    const exe = path.join(nginxDir, 'nginx.exe');
    const conf = path.join(nginxDir, 'conf', 'nginx.conf');
    return `Start-Process -FilePath ${powerShellLiteral(exe)} -ArgumentList @('-c', ${powerShellLiteral(conf)}) -WorkingDirectory ${powerShellLiteral(nginxDir)} -WindowStyle Hidden`;
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
