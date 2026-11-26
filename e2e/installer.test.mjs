/**
 * Tests for the Windows and Unix bootstrap installers. The security cases
 * prove that helper code is release-pinned, altered or partial downloads are
 * refused, and nothing arrives through a mutable HEAD/main URL.
 *
 * Run with:  npm run test:e2e -- installer
 *
 * Plain Node, no framework — the constitution forbids adding one here.
 *
 * ── The bug this pins ──────────────────────────────────────────────────────
 *
 * The script looked for its modules at `lib/installer`, which exists neither
 * in the repository nor in the published package (they live at
 * `src/lib/installer`). So a clone failed, and the GitHub fallback — whose URL
 * had the same wrong path — then `mkdir -p`'d an empty `lib/installer` into
 * whatever directory the user was standing in. The empty `lib/installer/` in
 * this repository is the scar from exactly that.
 *
 * ── Never the real machine ─────────────────────────────────────────────────
 *
 * Every run here is against a COPY of an installer inside the temp data
 * directory, with recording stubs ahead of PATH so that even a run which gets
 * past validation cannot install anything. PowerShell receives TEMP/TMP
 * inside the guarded test directory. Nothing touches real installer state,
 * and no network request is made.
 */

import './lib/guard.mjs';
import { TEST_DATA_DIR, assertInsideTestDataDir } from './lib/guard.mjs';

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const results = [];
let group = '';
function setGroup(g) { group = g; process.stdout.write(`\n-- ${g}\n`); }
function check(label, passed, detail = '') {
  results.push({ group, label, passed, detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}

const SCRIPT = path.join(ROOT, 'install.sh');
const PS_SCRIPT = path.join(ROOT, 'install.ps1');
const MODULES = ['progress.sh', 'detect.sh', 'node-versions.sh', 'picker.sh', 'nvm-bootstrap.sh', 'pm2.sh'];

function scratch(name) {
  const dir = path.join(TEST_DATA_DIR, 'scratch', name);
  assertInsideTestDataDir(dir, `create the scratch dir ${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Is there a bash we can run? Git Bash on Windows, /bin/bash elsewhere. */
async function findBash() {
  for (const candidate of ['bash', 'C:\\Program Files\\Git\\bin\\bash.exe', '/bin/bash']) {
    const ok = await new Promise((resolve) => {
      const child = spawn(candidate, ['-c', 'echo ok'], { stdio: 'ignore', shell: false });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    });
    if (ok) return candidate;
  }
  return null;
}

/**
 * Runs a copy of install.sh and captures everything.
 *
 * `piped` sends the script on stdin, which is what `curl | bash` does and the
 * case in which the script has no directory of its own.
 */
function runScript(bash, { cwd, args = [], piped = false, scriptPath, env = {} }) {
  return new Promise((resolve) => {
    const base = {
      ...process.env,
      ...env,
    };

    const child = piped
      ? spawn(bash, ['-s', '--', ...args], { cwd, env: base })
      : spawn(bash, [scriptPath, ...args], { cwd, env: base });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    if (piped) {
      child.stdin.write(fs.readFileSync(scriptPath));
      child.stdin.end();
    }

    const timer = setTimeout(() => { child.kill(); resolve({ code: 124, stdout, stderr, timedOut: true }); }, 60_000);
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(err), error: true }); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** A copy of install.sh, with or without its modules, in a temp directory. */
function layout(name, { modulesAt = 'src/lib/installer', withPackageJson = true } = {}) {
  const dir = scratch(name);
  fs.copyFileSync(SCRIPT, path.join(dir, 'install.sh'));

  if (modulesAt) {
    const target = path.join(dir, ...modulesAt.split('/'));
    fs.mkdirSync(target, { recursive: true });
    for (const module of MODULES) {
      fs.copyFileSync(path.join(ROOT, 'src', 'lib', 'installer', module), path.join(target, module));
    }
  }

  if (withPackageJson) {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'easy-devops', version: '0.0.0-test' }));
  }

  return dir;
}

/**
 * A fixture that mirrors the release layout install.sh downloads from:
 * <base>/src/lib/installer/<module>. Served with a file:// URL, so the test
 * never touches the network.
 */
function helperFixture(name) {
  const dir = scratch(name);
  const target = path.join(dir, 'src', 'lib', 'installer');
  fs.mkdirSync(target, { recursive: true });
  for (const module of MODULES) {
    fs.copyFileSync(path.join(ROOT, 'src', 'lib', 'installer', module), path.join(target, module));
  }
  return { dir, baseUrl: pathToFileURL(dir).href.replace(/\/$/, '') };
}

/** Stub executables ahead of PATH, so even a full run installs nothing. */
function stubTools(name) {
  const dir = scratch(name);
  for (const tool of ['npm', 'node', 'nvm', 'curl', 'wget']) {
    const file = path.join(dir, tool);
    fs.writeFileSync(file, `#!/usr/bin/env bash\necho "STUB ${tool} $*" >&2\nexit 1\n`);
    fs.chmodSync(file, 0o755);
  }
  return dir;
}

/** Downloader stubs that leave a marker if the installer even attempts a fetch. */
function recordingDownloaders(name) {
  const dir = scratch(name);
  for (const tool of ['curl', 'wget']) {
    const file = path.join(dir, tool);
    fs.writeFileSync(file, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "\${0}.called"\nexit 1\n`);
    fs.chmodSync(file, 0o755);
  }
  return dir;
}

/** Run a one-off bash command with captured output and a bounded timeout. */
function runBashCommand(bash, args, { cwd, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bash, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { child.kill(); resolve({ code: 124, stdout, stderr }); }, 60_000);
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(err) }); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** Is PowerShell available on this runner? */
async function findPowerShell() {
  const candidates = process.platform === 'win32'
    ? ['powershell.exe', 'pwsh']
    : ['pwsh', 'powershell'];
  for (const candidate of candidates) {
    const ok = await new Promise((resolve) => {
      const child = spawn(candidate, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
        stdio: 'ignore',
        shell: false,
        windowsHide: true,
      });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    });
    if (ok) return candidate;
  }
  return null;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function withoutCommentLines(text) {
  return text.split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join('\n');
}

/** Everything in a directory, relative, for before/after comparison. */
function snapshot(dir) {
  const out = [];
  const walk = (base, prefix = '') => {
    for (const entry of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      out.push(entry.isDirectory() ? `${rel}/` : rel);
      if (entry.isDirectory()) walk(path.join(base, entry.name), rel);
    }
  };
  walk(dir);
  return out;
}

// ─── PM2 fixtures ────────────────────────────────────────────────────────────

/**
 * A PATH whose pm2 / easy-devops resolution is decided ONLY by the stub
 * directory passed in.
 *
 * This machine can have a real pm2 and a real easy-devops on PATH, so a case
 * that says "PM2 is missing" must not find either one, and a case that tests
 * the package install must not fall into "already installed" mode. Every other
 * directory is kept: the installer needs sed, awk, sha256sum and the shell
 * builtins, and stubbing those would test nothing.
 */
function controlledPath(binDir) {
  const hidden = ['pm2', 'pm2.cmd', 'pm2.exe', 'easy-devops', 'easy-devops.cmd', 'easy-devops.exe'];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter((dir) => (
    dir && !hidden.some((name) => fs.existsSync(path.join(dir, name)))
  ));
  return [binDir, ...dirs].join(path.delimiter);
}

/** Reads the calls a stub recorded next to itself. */
function readCallLog(stubPath) {
  try {
    const text = fs.readFileSync(`${stubPath}.called`, 'utf8');
    return text.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Stubs for a PM2 run: npm (recording, with an optional failure), pm2 when the
 * case wants it present, and downloaders that fail at once so nothing leaves
 * the machine.
 *
 * The pm2 stub is a TRIPWIRE: it records any execution. Every PM2 path must
 * read the version from `<npm root -g>/pm2/package.json` instead, because
 * `pm2 --version` is itself a PM2 command and starts the daemon.
 */
function pm2Stubs(name, { pm2 = true, npmPm2Exit = 0, version = '5.4.2' } = {}) {
  const dir = scratch(name);
  const root = path.join(dir, 'npm-root');
  const pkgDir = path.join(root, 'pm2');
  const npmRoot = root.replace(/\\/g, '/');
  const pkgPath = `${npmRoot}/pm2/package.json`;
  fs.mkdirSync(dir, { recursive: true });

  const write = (file, body) => {
    fs.writeFileSync(path.join(dir, file), body);
    fs.chmodSync(path.join(dir, file), 0o755);
  };

  write('npm', [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$*" >> "${0}.called"',
    `if [ "$*" = "root -g" ]; then printf '%s\\n' "${npmRoot}"; exit 0; fi`,
    'case "$*" in',
    '  *"-g pm2"*)',
    `    if [ "${npmPm2Exit}" != "0" ]; then`,
    '      printf "npm ERR! code EACCES: permission denied, mkdir /usr/lib/node_modules/pm2\\n" >&2',
    `      exit ${npmPm2Exit}`,
    '    fi',
    `    mkdir -p "${npmRoot}/pm2" && printf '{"name":"pm2","version":"${version}"}\\n' > "${pkgPath}"`,
    '    ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'));

  if (pm2) {
    // Present, and reachable, but running it is the failure this test watches.
    write('pm2', [
      '#!/usr/bin/env bash',
      'printf "%s\\n" "$*" >> "${0}.called"',
      'printf "TRIPWIRE: pm2 must never be executed by the installer\\n" >&2',
      'exit 0',
      '',
    ].join('\n'));
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'pm2', version }));
  }

  // The installer probes nodejs.org unless --keep-node is given. These make the
  // probe fail immediately and offline instead of reaching the network.
  for (const tool of ['curl', 'wget', 'ping']) {
    write(tool, '#!/usr/bin/env bash\nexit 1\n');
  }

  return dir;
}

/** A full installer run with the PM2 stubs in front of PATH. */
async function runPm2Installer(bash, name, { args = [], pm2 = false, npmPm2Exit = 0 } = {}) {
  const dir = layout(name);
  const bin = pm2Stubs(`${name}-bin`, { pm2, npmPm2Exit });
  const result = await runScript(bash, {
    cwd: dir,
    scriptPath: path.join(dir, 'install.sh'),
    args: ['--keep-node', ...args],
    env: { PATH: controlledPath(bin), HOME: path.join(dir, 'home') },
  });
  return {
    dir,
    bin,
    result,
    output: result.stdout + result.stderr,
    npmCalls: readCallLog(path.join(bin, 'npm')),
    pm2Calls: readCallLog(path.join(bin, 'pm2')),
  };
}

/** Is there a real terminal behind this runner? A child with piped stdin can
 *  still inherit one from the console that started the suite. */
async function environmentHasTty(bash) {
  const probe = await runBashCommand(bash, [
    '-c', 'if { exec 3</dev/tty; } 2>/dev/null; then echo HAS_TTY; else echo NO_TTY; fi',
  ], { cwd: TEST_DATA_DIR });
  return /HAS_TTY/.test(probe.stdout);
}

// ─── 1. --help costs nothing ─────────────────────────────────────────────────

async function testHelp(bash) {
  setGroup('1. --help needs no modules, no network and no writes');

  // The bare script, with no modules anywhere near it: the standalone case.
  const dir = layout('inst-help', { modulesAt: null, withPackageJson: false });
  const before = snapshot(dir);

  const result = await runScript(bash, { cwd: dir, scriptPath: path.join(dir, 'install.sh'), args: ['--help'] });

  check('--help exits 0', result.code === 0, `exit ${result.code}: ${result.stderr.slice(0, 120)}`);
  check('and prints the usage', /Usage:/.test(result.stdout), result.stdout.slice(0, 80));
  check('it lists the flags', /--keep-node/.test(result.stdout) && /--no-service/.test(result.stdout));

  // This is the regression: --help used to be parsed AFTER the module loading,
  // so asking for help tried to download five files first.
  check('no download was attempted', !/downloading/i.test(result.stdout + result.stderr),
    (result.stdout + result.stderr).slice(0, 120));

  const after = snapshot(dir);
  check('and nothing was created in the working directory',
    JSON.stringify(before) === JSON.stringify(after),
    after.filter((f) => !before.includes(f)).join(', '));
}

// ─── 2. A clone finds its modules ────────────────────────────────────────────

async function testCloneLayout(bash) {
  setGroup('2. a clone resolves src/lib/installer');

  const dir = layout('inst-clone');
  const stubs = stubTools('inst-clone-stubs');
  const before = snapshot(dir);

  // --keep-node skips every Node step, so this reaches the npm step and stops
  // there against the stub. Getting that far proves the modules loaded: the
  // banner and the step list come from progress.sh.
  const result = await runScript(bash, {
    cwd: dir,
    scriptPath: path.join(dir, 'install.sh'),
    args: ['--keep-node', '--no-service'],
    env: { PATH: `${stubs}${path.delimiter}${process.env.PATH}` },
  });

  const output = result.stdout + result.stderr;

  check('the modules were found, not downloaded',
    !/Installer modules not found/.test(output) && !/were not found/.test(output),
    output.slice(0, 160));
  check('the banner printed, which comes after the modules load',
    /Easy DevOps/.test(output), output.slice(0, 120));
  const mode = (output.match(/Mode: (\w+)/) ?? [])[1] ?? 'none';
  check('it decided a mode, which only happens after the modules load',
    ['source', 'update', 'npm'].includes(mode), mode);

  // Nothing was really installed, whichever mode this machine produced.
  // `source` reaches the stub npm and dies on it; `update` skips the npm steps
  // entirely because easy-devops is already on PATH. Both are safe, and the
  // test must not depend on which one the machine happens to give.
  const touchedNpm = /STUB npm/.test(output);
  check('no real npm install happened',
    mode === 'update' ? !touchedNpm : touchedNpm,
    `mode=${mode}, stub npm invoked=${touchedNpm}`);
  check('and no dependency tree was created',
    !fs.existsSync(path.join(dir, 'node_modules')));

  // And still nothing created beside the script.
  const after = snapshot(dir).filter((f) => !f.startsWith('node_modules'));
  const created = after.filter((f) => !before.includes(f));
  check('no lib/installer was created in the working directory',
    !created.some((f) => f.startsWith('lib/')), created.join(', '));
}

// ─── 3. curl | bash ──────────────────────────────────────────────────────────

async function testPiped(bash) {
  setGroup('3. piped on stdin, as curl | bash delivers it');

  // The script arrives on stdin and there is no script directory at all. The
  // working directory deliberately contains a DIFFERENT project's
  // package.json, which is what used to make the script think it was in an
  // Easy DevOps checkout.
  const dir = scratch('inst-piped');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'someone-elses-app' }));
  const fixture = helperFixture('inst-piped-fixture');
  const before = snapshot(dir);

  const help = await runScript(bash, {
    cwd: dir,
    scriptPath: SCRIPT,
    args: ['--help'],
    piped: true,
  });

  check('--help works when piped', help.code === 0 && /Usage:/.test(help.stdout),
    `exit ${help.code}: ${help.stderr.slice(0, 120)}`);

  // Past the flags, with no helpers in the current directory, it downloads the
  // reviewed bundle from the configured base and verifies it. --check-helpers
  // stops before any install step.
  const run = await runScript(bash, {
    cwd: dir,
    scriptPath: SCRIPT,
    args: ['--check-helpers'],
    piped: true,
    env: { EZ_INSTALLER_BASE_URL: fixture.baseUrl },
  });

  const output = run.stdout + run.stderr;
  check('a piped run without local helpers loads the verified bundle', run.code === 0,
    `exit ${run.code}: ${output.slice(0, 260)}`);
  check('the helpers were verified from the configured base',
    new RegExp(`check-helpers: verified ${MODULES.length} helper module\\(s\\).*downloaded from`).test(output),
    output.slice(0, 260));
  check('the private helper directory is requested 0700',
    /requested 0700/.test(output), output.slice(0, 260));
  if (process.platform !== 'win32') {
    check('and actually has mode 700 on this platform', /mode 700/.test(output), output.slice(0, 260));
  }

  const created = snapshot(dir).filter((f) => !before.includes(f));
  check('nothing was written into the current directory', created.length === 0, created.join(', '));
  check('specifically no lib/installer', !fs.existsSync(path.join(dir, 'lib')));

  // A base URL that is not https:// or a loopback/file fixture is refused
  // before any request is made.
  const refused = await runScript(bash, {
    cwd: dir,
    scriptPath: SCRIPT,
    args: ['--check-helpers'],
    piped: true,
    env: { EZ_INSTALLER_BASE_URL: 'http://example.com/not-allowed' },
  });
  const refusedOutput = refused.stdout + refused.stderr;
  check('a plain http base URL is refused', refused.code === 1, `exit ${refused.code}`);
  check('and the refusal says what is allowed',
    /loopback/.test(refusedOutput) && /Nothing was downloaded/.test(refusedOutput),
    refusedOutput.slice(0, 260));
}

// ─── 4. The legacy layout still works ───────────────────────────────────────

async function testLegacyLayout(bash) {
  setGroup('4. an older checkout with lib/installer still works');

  const dir = layout('inst-legacy', { modulesAt: 'lib/installer' });
  const stubs = stubTools('inst-legacy-stubs');

  const result = await runScript(bash, {
    cwd: dir,
    scriptPath: path.join(dir, 'install.sh'),
    args: ['--keep-node', '--no-service'],
    env: { PATH: `${stubs}${path.delimiter}${process.env.PATH}` },
  });

  const output = result.stdout + result.stderr;
  check('the modules are found at the old path too',
    !/were not found/.test(output), output.slice(0, 160));
  check('and the run gets as far as the banner', /Easy DevOps/.test(output), output.slice(0, 120));
}

// ─── 5. Release-pinned helpers and launch sources ────────────────────────────

async function testStaticHardening() {
  setGroup('5. mutable scripts are absent and release files are pinned');

  const text = fs.readFileSync(SCRIPT, 'utf8');
  const helper = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'installer', 'nvm-bootstrap.sh'), 'utf8');
  const windows = fs.readFileSync(PS_SCRIPT, 'utf8');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const docsInstaller = fs.readFileSync(
    path.join(ROOT, 'docs', 'components', 'InstallTabs.tsx'),
    'utf8',
  );
  const executableShell = withoutCommentLines(text);
  const executableHelper = withoutCommentLines(helper);

  check('install.sh pins the helper download base URL', 
    /_LIB_BASE_URL_DEFAULT="https:\/\/raw\.githubusercontent\.com\/omar00050\/Easy-DevOps\/main"/.test(text));
  check('install.sh only accepts https, file and loopback http helper sources',
    /https:\/\/\?\*\|file:\/\/\?\*/.test(text)
      && /http:\/\/127\.0\.0\.1/.test(text)
      && /http:\/\/localhost/.test(text));
  check('install.sh verifies downloaded helpers before sourcing them',
    /_lib_dir_verified "\$LIB_DIR"[\s\S]{0,400}\.\s+"\$LIB_DIR\/\$_module"/.test(text));
  check('install.sh never pipes a download into a shell',
    !/\b(?:curl|wget)\b[^\n|]*\|\s*(?:bash|sh)\b/i.test(executableShell));
  check('nvm-bootstrap pins a release version and leaves the digest for owner review',
    /NVM_VERSION="v0\.40\.\d+"/.test(helper)
      && /NVM_INSTALL_SHA256=""\s*\n/.test(helper)
      && /TODO\(owner\): pin from the reviewed nvm release/.test(helper));
  check('nvm-bootstrap has no mutable installer URL',
    !/nvm-sh\/nvm\/(?:HEAD|main)/.test(helper) && !/\/main\/install\.sh/.test(helper));
  check('nvm-bootstrap never pipes a download into a shell',
    !/\b(?:curl|wget)\b[^\n|]*\|\s*(?:bash|sh)\b/i.test(executableHelper));

  const documented = `${readme}\n${docsInstaller}`;
  check('the documented Linux one-line installer is exact',
    documented.includes('curl -fsSL https://raw.githubusercontent.com/omar00050/Easy-DevOps/main/install.sh -o install.sh && bash install.sh')
      && documented.includes('wget -qO install.sh https://raw.githubusercontent.com/omar00050/Easy-DevOps/main/install.sh && bash install.sh'));
  check('the documented Windows one-line installer is exact',
    documented.includes('Invoke-WebRequest -Uri "https://raw.githubusercontent.com/omar00050/Easy-DevOps/main/install.ps1" -OutFile "install.ps1"; ./install.ps1'));
  check('no documentation tells users to clone a non-existent release tag',
    !/git clone --branch v1\.4\.5/.test(documented));
  check('the documentation says no automatic nvm-windows install while its digest is empty',
    /Automatic nvm-windows installation is disabled/.test(docsInstaller));
  check('the documentation explains the winget Node.js LTS fallback',
    /winget install --id OpenJS\.NodeJS\.LTS/.test(docsInstaller));

  const listed = text.match(/_LIB_MODULES="([^"]+)"/)?.[1]?.split(/\s+/) ?? [];
  const missing = listed.filter((m) => !fs.existsSync(path.join(ROOT, 'src', 'lib', 'installer', m)));
  check('every bundled module named by install.sh exists',
    listed.length > 0 && missing.length === 0, missing.join(', '));

  const pinned = new Map(
    [...text.matchAll(/([A-Za-z0-9.-]+\.sh)\)\s+printf '%s\\n' '([0-9a-f]{64})'/g)]
      .map((m) => [m[1], m[2]]),
  );
  const mismatched = listed.filter((module) => {
    const body = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'installer', module), 'utf8').replace(/\r\n/g, '\n');
    const actual = sha256(body);
    return pinned.get(module) !== actual;
  });
  check('every bundled module has its final SHA-256 pinned',
    listed.length === pinned.size && mismatched.length === 0, mismatched.join(', '));

  const wingetPin = /\$WINGET_INSTALL_PS1_SHA256\s*=\s*'([0-9a-f]{64})'/.exec(windows)?.[1] ?? '';
  const wingetBody = fs.readFileSync(
    path.join(ROOT, 'src', 'lib', 'installer', 'winget-install.ps1'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  check('winget-install.ps1 matches the digest pinned in install.ps1',
    wingetPin !== '' && wingetPin === sha256(wingetBody), wingetPin);

  const files = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).files ?? [];
  check('package.json ships src/, including the reviewed modules',
    files.some((f) => f === 'src/' || f === 'src'), files.join(', '));

  check('Windows has no predictable shared nvm-setup.exe target',
    !/\$env:TEMP\\nvm-setup\.exe/i.test(windows));
  check('Windows uses a fresh GUID-named private temp directory',
    /easy-devops-nvm-'[\s\S]{0,120}\[Guid\]::NewGuid\(\)/.test(windows));
  check('Windows has no trusted digest guessed or derived at runtime',
    /\$NVM_WINDOWS_SHA256\s*=\s*''/.test(windows)
      && !/\$NVM_WINDOWS_SHA256\s*=\s*[^\r\n]*(?:SHA256|\$actualSha256)/i.test(windows));
  check('Windows calculates and compares SHA-256 before launch',
    /\[System\.Security\.Cryptography\.SHA256\]::Create\(\)[\s\S]{0,500}\$actualSha256[\s\S]{0,500}-ne \$ExpectedSha256/i.test(windows)
      && /Start-Process -FilePath \$installer/.test(windows));
  check('Windows only launches the exact file it downloaded',
    /Download-File -Url \$Url -Dest \$installer[\s\S]*Start-Process -FilePath \$installer/.test(windows));
  check('Windows cleans the attempt directory in finally',
    /finally \{[\s\S]{0,500}Remove-NvmAttempt -TempRoot \$tempRoot -TempDir \$tempDir/.test(windows)
      && !/Remove-Item[^\r\n]*-Recurse/i.test(windows));
  check('Windows refuses reparse directories before cleanup',
    /function Remove-NvmAttempt[\s\S]*?FileAttributes\]::ReparsePoint[\s\S]*?Directory\]::Delete\(\$resolvedTempDir, \$false\)/
      .test(windows));
  check('Windows nvm discovery does not trust caller-controlled folder variables',
    !/\$env:ProgramData\s+'nvm\\nvm\.exe'/.test(windows)
      && /\[Environment\+SpecialFolder\]::ApplicationData/.test(windows)
      && /\[Environment\+SpecialFolder\]::CommonApplicationData/.test(windows));
  check('Windows service elevation never evaluates an interpolated command string',
    !/Invoke-Expression/.test(withoutCommentLines(windows))
      && /Start-ElevatedServiceInstall[\s\S]*?'-EncodedCommand', \$encoded/.test(windows));
  check('the elevated Windows bootstrap rebuilds machine and loader paths',
    /Get-ChildItem Env:[\s\S]{0,250}Remove-Item[\s\S]{0,500}\$env:SystemRoot[\s\S]{0,1500}\$env:TEMP[\s\S]{0,500}\$env:PSModulePath/
      .test(windows));
  check('the elevated Windows bootstrap starts from the system directory',
    /Set-Location -LiteralPath \$env:SystemRoot -ErrorAction Stop/.test(windows)
      && !/Set-Location[^\r\n]*\$p\.cwd/.test(windows));
  check('the elevated Windows bootstrap canonicalizes and signs-checks Node before launch',
    /\$nodeItem = Get-Item -LiteralPath \$p\.execPath/.test(windows)
      && /if \(\$nodeItem\.PSIsContainer\)/.test(windows)
      && /\$p\.execPath = \$nodeItem\.FullName/.test(windows)
      && /Get-AuthenticodeSignature -FilePath \$p\.execPath/.test(windows)
      && /\.Status -ne 'Valid'/.test(windows)
      && /&\s+\$p\.execPath\s+@\(\$p\.args\)/.test(windows));
  check('the elevated Windows bootstrap executes the CLI with a direct argument array',
    /&\s+\$Invocation\.ExecPath\s+@\(\$Invocation\.Args\)/.test(windows)
      && /&\s+\$p\.execPath\s+@\(\$p\.args\)/.test(windows));

  // ── PM2: one standard install, asked before the service offer ───────────────
  //
  // The owner's decision is standard PM2 only: `npm i -g pm2` as the user who
  // ran the installer, with that user's own npm and default PM2 home. No PM2
  // home of our own, no second copy, no second daemon, and never an install
  // without an answer.
  const pm2Helper = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'installer', 'pm2.sh'), 'utf8');
  const batText = fs.readFileSync(path.join(ROOT, 'install.bat'), 'utf8');
  const pm2Executable = withoutCommentLines(pm2Helper);

  check('install.sh installs PM2 with exactly npm i -g pm2',
    /_LIB_MODULES="[^"]*\bpm2\.sh\b/.test(text)
      && /PM2_INSTALL_CMD="npm i -g pm2"/.test(pm2Helper));
  check('install.ps1 installs PM2 with exactly npm i -g pm2',
    /\$PM2_INSTALL_COMMAND = 'npm i -g pm2'/.test(windows));
  check('no installer sets or creates a PM2 home of its own',
    !/PM2_HOME=/.test(text) && !/PM2_HOME=/.test(pm2Helper) && !/env:PM2_HOME/.test(windows));
  check('no installer runs pm2 startup, save, resurrect or install',
    !/\bpm2\s+(startup|unstartup|install|save|resurrect)\b/.test(withoutCommentLines(text))
      && !/\bpm2\s+(startup|unstartup|install|save|resurrect)\b/.test(withoutCommentLines(windows))
      && !/\bpm2\s+(startup|unstartup|install|save|resurrect)\b/.test(pm2Executable));
  check('no installer runs sudo itself',
    !/^\s*sudo\s/m.test(withoutCommentLines(text))
      && !/^\s*sudo\s/m.test(withoutCommentLines(windows))
      && !/^\s*sudo\s/m.test(pm2Executable));

  check('install.ps1 declares the -Pm2 and -NoPm2 switches',
    /\[switch\]\$Pm2\b/.test(windows) && /\[switch\]\$NoPm2\b/.test(windows));
  check('the Linux help documents --pm2 and --no-pm2',
    /--pm2\s+Install standard PM2 globally/.test(text) && /--no-pm2\s+Do not install PM2/.test(text));
  check('the Windows help documents -Pm2 and -NoPm2',
    /-Pm2\s+Install standard PM2 globally/.test(windows) && /-NoPm2\s+Do not install PM2/.test(windows));
  check('install.bat maps --pm2 and --no-pm2 to the PowerShell switches',
    /"%~1"=="--pm2"[\s\S]{0,90}\s-Pm2"/i.test(batText)
      && /"%~1"=="--no-pm2"[\s\S]{0,90}\s-NoPm2"/i.test(batText));
  check('both prompts default to No',
    /\[y\/N\]/.test(pm2Helper) && /\[y\/N\]/.test(windows));
  check('the shell installer reads the PM2 version from its package, never by running pm2',
    /npm root -g/.test(pm2Helper)
      && !/\bpm2\s+(--version|-v)\b/.test(pm2Executable)
      && /pm2\/package\.json/.test(pm2Helper));
  check('the Windows installer reads the PM2 version from its package, never by running pm2',
    /'root' '-g'/.test(windows)
      && !/& \$pm2\b/.test(windows)
      && !/\bpm2\s+--version\b/.test(windows));

  const shellPm2Call = text.replace(/\r\n/g, '\n').indexOf('\nmaybe_install_pm2\n');
  const shellSummary = text.indexOf('=== Installation Summary ===');
  const shellServiceCall = text.replace(/\r\n/g, '\n').indexOf('\nmaybe_install_service\n');
  check('install.sh offers PM2 after the package install and before the service offer',
    shellPm2Call > 0 && shellPm2Call > shellSummary && shellPm2Call < shellServiceCall,
    `pm2=${shellPm2Call}, summary=${shellSummary}, service=${shellServiceCall}`);
  const psNorm = windows.replace(/\r\n/g, '\n');
  const psPm2Call = psNorm.indexOf('\nInvoke-Pm2Offer `');
  const psServiceCall = psNorm.lastIndexOf('\nInvoke-ServiceOffer');
  check('install.ps1 offers PM2 before the service offer',
    psPm2Call > 0 && psPm2Call < psServiceCall,
    `pm2=${psPm2Call}, service=${psServiceCall}`);
}

// ─── 6. Altered bundled bytes are rejected before they run ──────────────────

async function testAlteredModule(bash) {
  setGroup('6. a modified helper module is refused before sourcing');

  const crlfDir = layout('inst-crlf');
  for (const module of MODULES) {
    const file = path.join(crlfDir, 'src', 'lib', 'installer', module);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
  }
  const crlfStubs = stubTools('inst-crlf-stubs');
  const crlfResult = await runScript(bash, {
    cwd: crlfDir,
    scriptPath: path.join(crlfDir, 'install.sh'),
    args: ['--keep-node', '--no-service'],
    env: { PATH: `${crlfStubs}${path.delimiter}${process.env.PATH}` },
  });
  const crlfOutput = crlfResult.stdout + crlfResult.stderr;
  check('CRLF copies of the reviewed modules remain valid on Windows', !/does not match/.test(crlfOutput),
    crlfOutput.slice(0, 240));
  check('and the CRLF bundle reaches the installer banner', /Easy DevOps/.test(crlfOutput),
    crlfOutput.slice(0, 160));

  const dir = layout('inst-altered');
  const marker = path.join(dir, 'altered-module-ran');
  const progress = path.join(dir, 'src', 'lib', 'installer', 'progress.sh');
  fs.appendFileSync(progress, `\ntouch "${marker}"\n`);

  const result = await runScript(bash, {
    cwd: dir,
    scriptPath: path.join(dir, 'install.sh'),
    args: ['--keep-node', '--no-service'],
  });
  const output = result.stdout + result.stderr;

  check('the altered bundle exits nonzero', result.code === 1, `exit ${result.code}`);
  check('it names the module and the reviewed mismatch',
    /progress\.sh does not match the reviewed release/.test(output), output.slice(0, 260));
  check('the altered helper was never sourced or executed', !fs.existsSync(marker));
  check('the installer stops before printing its post-module banner', !/Mode:/.test(output));
}

// ─── 7. nvm bootstrap is local-only and does not execute shell rc files ─────

async function testNvmBootstrap(bash) {
  setGroup('7. nvm bootstrap never fetches or executes mutable code');

  const dir = scratch('inst-nvm-bootstrap');
  const downloaders = recordingDownloaders('inst-nvm-downloaders');
  const home = path.join(dir, 'home');
  const nvmDir = path.join(home, '.nvm');
  const rcMarker = path.join(dir, 'shell-rc-ran');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.bashrc'), `touch "${rcMarker}"\n`);

  const helper = path.join(ROOT, 'src', 'lib', 'installer', 'nvm-bootstrap.sh');
  const result = await runBashCommand(
    bash,
    ['-c', '. "$1"; HOME="$2"; NVM_DIR="$3"; bootstrap_nvm', 'harness', helper, home, nvmDir],
    { cwd: dir, env: { PATH: `${downloaders}${path.delimiter}${process.env.PATH}` } },
  );
  const output = result.stdout + result.stderr;

  check('missing nvm makes bootstrap fail closed', result.code === 1, `exit ${result.code}`);
  check('it prints the exact official nvm install command',
    /curl -o- https:\/\/raw\.githubusercontent\.com\/nvm-sh\/nvm\/v0\.40\.\d+\/install\.sh \| bash/.test(output),
    output.slice(0, 300));
  check('then source ~/.nvm/nvm.sh and re-run install.sh',
    /source ~\/\.nvm\/nvm\.sh/.test(output) && /bash install\.sh/.test(output),
    output.slice(0, 320));
  check('and offers --keep-node for an already-installed Node.js 18+',
    /--keep-node/.test(output) && /distro package|18\+/i.test(output), output.slice(0, 320));
  check('the fake curl was never called', !fs.existsSync(path.join(downloaders, 'curl.called')));
  check('the fake wget was never called', !fs.existsSync(path.join(downloaders, 'wget.called')));
  check('user shell rc files were not sourced', !fs.existsSync(rcMarker));
}

// ─── 9. PM2: present, --pm2, --no-pm2, a failure, and the order ──────────────

async function testPm2Offer(bash) {
  setGroup('9. PM2 is offered after the package and before the service');

  // Present: version printed, nothing installed, no question asked.
  const present = await runPm2Installer(bash, 'pm2-present', { args: ['--no-service'], pm2: true });
  check('a present PM2 is reported with its version and never installed again',
    present.result.code === 0 && /PM2 5\.4\.2 is already installed/.test(present.output),
    `exit ${present.result.code}: ${present.output.slice(-260)}`);
  check('and npm was never asked for PM2',
    !present.npmCalls.some((call) => /-g pm2/.test(call)), present.npmCalls.join(' | '));

  // --pm2: installs without asking, exactly once, and in the right order.
  const forced = await runPm2Installer(bash, 'pm2-forced', { args: ['--pm2', '--no-service'] });
  const pm2Installs = forced.npmCalls.filter((call) => call === 'i -g pm2');
  check('--pm2 installs without a terminal and without asking',
    forced.result.code === 0 && pm2Installs.length === 1,
    `exit ${forced.result.code}: ${forced.npmCalls.join(' | ')}`);
  check('it runs exactly npm i -g pm2, once',
    pm2Installs.length === 1 && !forced.npmCalls.some((call) => call !== 'i -g pm2' && /-g pm2/.test(call)),
    forced.npmCalls.join(' | '));
  check('the PM2 install runs after the package install',
    forced.npmCalls.indexOf('i -g pm2') > 0
      && forced.npmCalls.findIndex((call) => /^(install|link)\b/.test(call)) !== -1
      && forced.npmCalls.indexOf('i -g pm2')
        > forced.npmCalls.findIndex((call) => /^(install|link)\b/.test(call)),
    forced.npmCalls.join(' | '));
  check('the PM2 offer comes after the summary and before the service offer',
    forced.output.indexOf('Installing PM2 globally') > forced.output.indexOf('=== Installation Summary ===')
      && forced.output.indexOf('Installing PM2 globally') < forced.output.indexOf('Skipping the background service (--no-service)'),
    `pm2=${forced.output.indexOf('Installing PM2 globally')}, summary=${forced.output.indexOf('=== Installation Summary ===')}, service=${forced.output.indexOf('Skipping the background service (--no-service)')}`);
  check('and it says it installed PM2 for this account',
    /Installing PM2 globally: npm i -g pm2/.test(forced.output), forced.output.slice(-320));

  // --no-pm2: one line, no npm call for PM2.
  const skipped = await runPm2Installer(bash, 'pm2-skip', { args: ['--no-pm2', '--no-service'] });
  const pm2Lines = skipped.output.split(/\r?\n/).filter((line) => /PM2/.test(line));
  check('--no-pm2 skips without asking and never calls npm for PM2',
    skipped.result.code === 0
      && !skipped.npmCalls.some((call) => /-g pm2/.test(call))
      && /Skipping PM2 \(--no-pm2\)/.test(skipped.output),
    skipped.npmCalls.join(' | '));
  check('and it is one line, with the command to run later',
    pm2Lines.length === 1 && /npm i -g pm2/.test(pm2Lines[0]), pm2Lines.join(' | '));

  // A failed PM2 install is never a failed Easy DevOps install.
  const failed = await runPm2Installer(bash, 'pm2-failed', { args: ['--pm2', '--no-service'], npmPm2Exit: 1 });  check('a failed PM2 install still exits 0',
    failed.result.code === 0, `exit ${failed.result.code}: ${failed.output.slice(-260)}`);
  check('and prints npm\'s own error',
    /npm ERR! code EACCES/.test(failed.output), failed.output.slice(-320));
  check('and the exact command to run instead',
    /The command was:\s*\n\s*npm i -g pm2/.test(failed.output), failed.output.slice(-320));
  check('and says Easy DevOps still works without it',
    /Easy DevOps is installed and works without it/.test(failed.output));

  // `pm2 --version` is itself a PM2 command and starts the daemon, so every
  // path above must have read the version from <npm root -g>/pm2/package.json
  // instead. The pm2 stub is a tripwire; running it at all is the failure.
  const tripwire = [
    ...present.pm2Calls, ...forced.pm2Calls, ...skipped.pm2Calls, ...failed.pm2Calls,
  ];
  check('no PM2 path executes the pm2 command',
    tripwire.length === 0, tripwire.join(' | '));

  // No terminal and no flag: nothing installed, the command printed. Only
  // measurable where the runner really has no terminal; with one, the module
  // case below covers the same branch without guessing the default.
  if (await environmentHasTty(bash)) {
    check('the unattended PM2 case', true,
      'skipped: this terminal has a /dev/tty, so a full run would wait for an answer; the module case covers the branch');
  } else {
    const unattended = await runPm2Installer(bash, 'pm2-unattended', { args: ['--no-service'] });
    check('with no terminal and no flag, PM2 is not installed',
      unattended.result.code === 0 && !unattended.npmCalls.some((call) => /-g pm2/.test(call)),
      unattended.npmCalls.join(' | '));
    check('and the exact command is printed instead',
      /No terminal is available[\s\S]{0,120}npm i -g pm2/.test(unattended.output),
      unattended.output.slice(-320));
  }
}

// ─── 10. The PM2 question: only a real terminal, only an explicit yes ────────

async function testPm2Prompt(bash) {
  setGroup('10. the PM2 prompt reads a terminal and installs only on an explicit yes');

  const helper = path.join(ROOT, 'src', 'lib', 'installer', 'pm2.sh');
  const runOffer = async (name, body) => {
    const dir = scratch(name);
    const bin = pm2Stubs(`${name}-bin`, { pm2: false });
    const result = await runBashCommand(bash, ['-c', body, 'harness', helper], {
      cwd: dir,
      env: { PATH: controlledPath(bin), HOME: dir },
    });
    return {
      code: result.code,
      output: result.stdout + result.stderr,
      npmCalls: readCallLog(path.join(bin, 'npm')),
    };
  };

  // No terminal: never guess, always print the command.
  const noTty = await runOffer('pm2-no-tty', [
    '. "$1"',
    'PM2_CHOICE=ask',
    'pm2_open_terminal() { return 1; }',
    'maybe_install_pm2',
  ].join('\n'));
  check('with no terminal the offer exits cleanly',
    noTty.code === 0, `exit ${noTty.code}: ${noTty.output.slice(0, 240)}`);
  check('with no terminal npm is never called',
    !noTty.npmCalls.some((call) => /-g pm2/.test(call)), noTty.npmCalls.join(' | '));
  check('with no terminal the exact command is printed',
    /No terminal is available/.test(noTty.output) && /npm i -g pm2/.test(noTty.output),
    noTty.output.slice(0, 320));

  // A terminal and "y".
  const yes = await runOffer('pm2-tty-yes', [
    '. "$1"',
    'PM2_CHOICE=ask',
    'pm2_open_terminal() { return 0; }',
    'pm2_prompt_answer() { _PM2_ANSWER="y"; }',
    'maybe_install_pm2',
  ].join('\n'));
  check('a terminal and "y" installs PM2',
    yes.code === 0 && yes.npmCalls.filter((call) => call === 'i -g pm2').length === 1,
    `${yes.code}: ${yes.npmCalls.join(' | ')}`);
  check('and the question defaults to No',
    /Install PM2 now\? \[y\/N\]/.test(yes.output), yes.output.slice(0, 400));

  // A terminal and "n".
  const no = await runOffer('pm2-tty-no', [
    '. "$1"',
    'PM2_CHOICE=ask',
    'pm2_open_terminal() { return 0; }',
    'pm2_prompt_answer() { _PM2_ANSWER="n"; }',
    'maybe_install_pm2',
  ].join('\n'));
  check('a terminal and "n" installs nothing and says how',
    no.code === 0
      && !no.npmCalls.some((call) => /-g pm2/.test(call))
      && /PM2 was not installed\. Install it later with: npm i -g pm2/.test(no.output),
    `${no.code}: ${no.npmCalls.join(' | ')} ${no.output.slice(-200)}`);

  // A terminal and an empty answer: the default, which is No.
  const empty = await runOffer('pm2-tty-empty', [
    '. "$1"',
    'PM2_CHOICE=ask',
    'pm2_open_terminal() { return 0; }',
    'pm2_prompt_answer() { _PM2_ANSWER=""; }',
    'maybe_install_pm2',
  ].join('\n'));
  check('an empty answer is the default, and the default is No',
    empty.code === 0 && !empty.npmCalls.some((call) => /-g pm2/.test(call)),
    `${empty.code}: ${empty.npmCalls.join(' | ')}`);

  // The answer parser itself: only y/yes, in any case.
  const answers = await runOffer('pm2-answers', [
    '. "$1"',
    'for a in y Y yes YES n no "" x; do',
    '  if pm2_answer_is_yes "$a"; then printf "YES:%s\\n" "$a"; else printf "NO:%s\\n" "$a"; fi',
    'done',
  ].join('\n'));
  check('only y and yes install; every other answer is no',
    /YES:y\n/.test(answers.output) && /YES:Y\n/.test(answers.output)
      && /YES:yes\n/.test(answers.output) && /YES:YES\n/.test(answers.output)
      && /NO:n\n/.test(answers.output) && /NO:no\n/.test(answers.output)
      && /NO:\n/.test(answers.output) && /NO:x\n/.test(answers.output),
    answers.output.replace(/\n/g, ' '));
}

// ─── 11. Windows verifies a fresh per-attempt file before launching it ──────

async function testWindowsInstaller(powerShell) {
  setGroup('11. Windows download, digest and launch checks');

  const dir = scratch('inst-windows-security');
  const harness = path.join(dir, 'harness.ps1');
  const resultsFile = path.join(dir, 'results.json');
  const downloadMarker = path.join(dir, 'downloads.txt');
  const launchMarker = path.join(dir, 'launches.txt');
  const payload = 'reviewed fake nvm-windows installer payload';
  const expectedSha256 = sha256(payload);

  fs.writeFileSync(harness, String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$script:checks = [System.Collections.Generic.List[object]]::new()

function Add-Check {
  param([string]$Name, [bool]$Passed, [string]$Detail = '')
  $script:checks.Add([PSCustomObject]@{ name = $Name; passed = $Passed; detail = $Detail })
}

function Reset-Markers {
  foreach ($marker in @($env:EZ_TEST_DOWNLOAD_MARKER, $env:EZ_TEST_LAUNCH_MARKER)) {
    if (Test-Path -LiteralPath $marker) {
      Remove-Item -LiteralPath $marker -Force
    }
  }
}

function Get-AttemptDirs {
  return @(Get-ChildItem -LiteralPath $env:TEMP -Directory -Filter 'easy-devops-nvm-*' -ErrorAction SilentlyContinue)
}

. $env:EZ_INSTALLER_SCRIPT

$script:launchObserved = $false
$script:launchedFileExisted = $false
$script:launchedFile = ''

function Download-File {
  param([string]$Url, [string]$Dest, [string]$Label)
  [System.IO.File]::AppendAllText($env:EZ_TEST_DOWNLOAD_MARKER, $Dest + [Environment]::NewLine)

  switch ($env:EZ_TEST_DOWNLOAD_MODE) {
    'fail-after-partial' {
      [System.IO.File]::WriteAllText($Dest, 'partial stale bytes')
      throw 'simulated downloader failure'
    }
    'altered' {
      [System.IO.File]::WriteAllText($Dest, 'altered bytes')
      return
    }
    'verified' {
      [System.IO.File]::WriteAllText($Dest, $env:EZ_TEST_VERIFIED_PAYLOAD)
      return
    }
    default {
      throw 'unexpected downloader mode'
    }
  }
}

function Start-Process {
  param(
    [string]$FilePath,
    [string[]]$ArgumentList,
    [switch]$Wait,
    [switch]$PassThru
  )
  $writeDenied = $false
  try {
    [System.IO.File]::WriteAllText($FilePath, 'replacement during launch')
  } catch {
    $writeDenied = $true
  }
  $deleteDenied = $false
  try {
    [System.IO.File]::Delete($FilePath)
  } catch {
    $deleteDenied = $true
  }
  Add-Check 'the verified file denies write sharing through launch' $writeDenied
  Add-Check 'the verified file denies delete sharing through launch' $deleteDenied
  $script:launchObserved = $true
  $script:launchedFile = $FilePath
  $script:launchedFileExisted = Test-Path -LiteralPath $FilePath -PathType Leaf
  [System.IO.File]::AppendAllText($env:EZ_TEST_LAUNCH_MARKER, $FilePath + [Environment]::NewLine)
  return [PSCustomObject]@{ ExitCode = 0 }
}

$stalePath = Join-Path $env:TEMP 'nvm-setup.exe'
$staleValue = 'STALE SENTINEL - MUST NOT RUN'
[System.IO.File]::WriteAllText($stalePath, $staleValue)

Reset-Markers
$emptyDigestResult = Install-NvmWindowsVerified -Url 'https://example.invalid/nvm-setup.exe' -ExpectedSha256 ''
Add-Check 'empty production digest fails before download' (-not $emptyDigestResult)
Add-Check 'empty digest calls no downloader' (-not (Test-Path -LiteralPath $env:EZ_TEST_DOWNLOAD_MARKER))
Add-Check 'empty digest starts no process' (-not $script:launchObserved)
Add-Check 'empty digest creates no attempt directory' (@(Get-AttemptDirs).Count -eq 0)

Reset-Markers
$env:EZ_TEST_DOWNLOAD_MODE = 'fail-after-partial'
$partialResult = Install-NvmWindowsVerified -Url 'https://example.invalid/nvm-setup.exe' -ExpectedSha256 $env:EZ_TEST_VALID_SHA256
Add-Check 'download failure returns false' (-not $partialResult)
Add-Check 'download failure never starts the partial file' (-not $script:launchObserved)
Add-Check 'download failure leaves the stale sentinel untouched' (([System.IO.File]::ReadAllText($stalePath)) -eq $staleValue)
Add-Check 'download failure removes its private attempt directory' (@(Get-AttemptDirs).Count -eq 0)

Reset-Markers
$env:EZ_TEST_DOWNLOAD_MODE = 'altered'
$alteredResult = Install-NvmWindowsVerified -Url 'https://example.invalid/nvm-setup.exe' -ExpectedSha256 $env:EZ_TEST_VALID_SHA256
Add-Check 'altered bytes return false' (-not $alteredResult)
Add-Check 'altered bytes never start a process' (-not $script:launchObserved)
Add-Check 'altered bytes leave no attempt directory' (@(Get-AttemptDirs).Count -eq 0)

Reset-Markers
$env:EZ_TEST_DOWNLOAD_MODE = 'verified'
$verifiedResult = Install-NvmWindowsVerified -Url 'https://example.invalid/nvm-setup.exe' -ExpectedSha256 $env:EZ_TEST_VALID_SHA256
Add-Check 'matching bytes return true' $verifiedResult
Add-Check 'matching bytes launch the downloaded file' ($script:launchObserved -and $script:launchedFileExisted)
Add-Check 'matching bytes leave no attempt directory' (@(Get-AttemptDirs).Count -eq 0)

$nonEmptyDir = Join-Path $env:TEMP 'easy-devops-nvm-nonempty'
$null = New-Item -ItemType Directory -Path $nonEmptyDir
$unrelated = Join-Path $nonEmptyDir 'unrelated.txt'
[System.IO.File]::WriteAllText($unrelated, 'must remain')
$nonEmptyRefused = $false
try {
  Remove-NvmAttempt -TempRoot $env:TEMP -TempDir $nonEmptyDir
} catch {
  $nonEmptyRefused = $true
}
Add-Check 'cleanup refuses a directory with an unrelated file' $nonEmptyRefused
Add-Check 'cleanup leaves the unrelated file intact' ([System.IO.File]::ReadAllText($unrelated) -eq 'must remain')
[System.IO.Directory]::Delete($nonEmptyDir, $true)

$junctionTarget = Join-Path $env:TEMP 'easy-devops-nvm-junction-target'
$junctionPath = Join-Path $env:TEMP 'easy-devops-nvm-junction'
$null = New-Item -ItemType Directory -Path $junctionTarget
$junctionPayload = Join-Path $junctionTarget 'must-remain.txt'
[System.IO.File]::WriteAllText($junctionPayload, 'outside the attempt')
$null = New-Item -ItemType Junction -Path $junctionPath -Target $junctionTarget
$junctionRefused = $false
try {
  Remove-NvmAttempt -TempRoot $env:TEMP -TempDir $junctionPath
} catch {
  $junctionRefused = $true
}
Add-Check 'cleanup refuses a replaced junction directory' $junctionRefused
Add-Check 'cleanup does not follow the junction during refusal' ([System.IO.File]::ReadAllText($junctionPayload) -eq 'outside the attempt')
[System.IO.Directory]::Delete($junctionPath, $false)
[System.IO.Directory]::Delete($junctionTarget, $true)

$launchPath = ''
$downloadPath = ''
if (Test-Path -LiteralPath $env:EZ_TEST_LAUNCH_MARKER) {
  $launchPath = ([System.IO.File]::ReadAllLines($env:EZ_TEST_LAUNCH_MARKER))[0]
}
if (Test-Path -LiteralPath $env:EZ_TEST_DOWNLOAD_MARKER) {
  $downloadPath = ([System.IO.File]::ReadAllLines($env:EZ_TEST_DOWNLOAD_MARKER))[0]
}

$output = [PSCustomObject]@{
  checks = @($script:checks)
  launchPath = $launchPath
  downloadPath = $downloadPath
}
[System.IO.File]::WriteAllText(
  $env:EZ_TEST_RESULTS,
  (ConvertTo-Json -InputObject $output -Depth 5 -Compress)
)

$failed = @($script:checks | Where-Object { -not $_.passed })
if ($failed.Count -gt 0) {
  exit 1
}
`);

  const result = await runBashCommand(powerShell, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', harness,
  ], {
    cwd: dir,
    env: {
      TEMP: dir,
      TMP: dir,
      EZ_INSTALLER_TEST_FUNCTIONS_ONLY: '1',
      EZ_INSTALLER_SCRIPT: PS_SCRIPT,
      EZ_TEST_DOWNLOAD_MARKER: downloadMarker,
      EZ_TEST_LAUNCH_MARKER: launchMarker,
      EZ_TEST_RESULTS: resultsFile,
      EZ_TEST_VALID_SHA256: expectedSha256,
      EZ_TEST_VERIFIED_PAYLOAD: payload,
    },
  });

  let observed = null;
  try {
    observed = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  } catch {
    // The process result below carries the useful failure text.
  }

  check('the PowerShell security harness exits cleanly', result.code === 0 && observed !== null,
    `exit ${result.code}: ${(result.stderr || result.stdout).slice(0, 260)}`);
  for (const item of observed?.checks ?? []) {
    check(item.name, item.passed, item.detail);
  }

  const downloadPath = observed?.downloadPath ?? '';
  const launchPath = observed?.launchPath ?? '';
  check('the launch source is inside a GUID-named attempt directory',
    launchPath && path.dirname(launchPath) !== dir
      && path.basename(path.dirname(launchPath)).startsWith('easy-devops-nvm-'),
    launchPath);
  check('the launched file is the file downloaded by this attempt',
    launchPath && downloadPath && path.resolve(launchPath) === path.resolve(downloadPath),
    `${downloadPath} -> ${launchPath}`);
  check('the launched temporary file is removed after completion',
    launchPath !== '' && !fs.existsSync(launchPath), launchPath);
  check('the stale predictable TEMP sentinel is still untouched',
    fs.readFileSync(path.join(dir, 'nvm-setup.exe'), 'utf8') === 'STALE SENTINEL - MUST NOT RUN');
}

// ─── 12. Windows PM2 offer: standard install, flags, default No ─────────────

async function testWindowsPm2(powerShell) {
  setGroup('12. install.ps1 offers standard PM2 and never installs without an answer');

  const dir = scratch('inst-windows-pm2');
  const withPm2 = path.join(dir, 'bin-with-pm2');
  const withoutPm2 = path.join(dir, 'bin-without-pm2');
  const rootWithPm2 = path.join(dir, 'npm-root-with-pm2');
  const rootWithoutPm2 = path.join(dir, 'npm-root-without-pm2');
  fs.mkdirSync(withPm2, { recursive: true });
  fs.mkdirSync(withoutPm2, { recursive: true });
  fs.mkdirSync(path.join(rootWithPm2, 'pm2'), { recursive: true });
  fs.mkdirSync(rootWithoutPm2, { recursive: true });
  fs.writeFileSync(path.join(rootWithPm2, 'pm2', 'package.json'),
    JSON.stringify({ name: 'pm2', version: '9.9.9' }));

  // `pm2 --version` is itself a PM2 command and starts the daemon, so the npm
  // stub answers `root -g` with a fake global root and writes the PM2 package
  // there when PM2 is installed. The pm2 stub is a tripwire.
  const npmStub = [
    '@echo off',
    'echo %*>>"%EZ_TEST_NPM_CALLS%"',
    'if /i "%*"=="root -g" (',
    '  echo %EZ_TEST_NPM_ROOT%',
    '  exit /b 0',
    ')',
    'if /i "%*"=="i -g pm2" (',
    '  if not "%EZ_TEST_NPM_EXIT%"=="0" (',
    '    echo npm ERR! code EACCES, permission denied 1>&2',
    '    exit /b %EZ_TEST_NPM_EXIT%',
    '  )',
    '  if not exist "%EZ_TEST_NPM_ROOT%\\pm2" mkdir "%EZ_TEST_NPM_ROOT%\\pm2"',
    '  > "%EZ_TEST_NPM_ROOT%\\pm2\\package.json" echo {"name":"pm2","version":"9.9.9"}',
    ')',
    'exit /b 0',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(withPm2, 'npm.cmd'), npmStub);
  fs.writeFileSync(path.join(withoutPm2, 'npm.cmd'), npmStub);
  fs.writeFileSync(path.join(withPm2, 'pm2.cmd'), [
    '@echo off',
    'echo ran>>"%EZ_TEST_PM2_MARKER%"',
    'echo 9.9.9',
    'exit /b 0',
    '',
  ].join('\r\n'));

  const pm2Marker = path.join(dir, 'pm2-ran.txt');
  const resultsFile = path.join(dir, 'results.json');
  const harness = path.join(dir, 'harness.ps1');
  fs.writeFileSync(harness, String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$script:checks = [System.Collections.Generic.List[object]]::new()

function Add-Check {
  param([string]$Name, [bool]$Passed, [string]$Detail = '')
  $script:checks.Add([PSCustomObject]@{ name = $Name; passed = $Passed; detail = $Detail })
}

$env:EZ_INSTALLER_TEST_FUNCTIONS_ONLY = '1'
. $env:EZ_TEST_INSTALLER_SCRIPT

function Invoke-Case {
  param([string]$Name, [string]$Bin, [string]$Root, [string]$NpmExit, [scriptblock]$Action)
  $env:Path = $Bin
  $env:EZ_TEST_NPM_ROOT = $Root
  $env:EZ_TEST_NPM_EXIT = $NpmExit
  $callsFile = Join-Path $env:EZ_TEST_SCRATCH ("npm-calls-{0}.txt" -f $Name)
  $env:EZ_TEST_NPM_CALLS = $callsFile
  if (Test-Path -LiteralPath $callsFile) { Remove-Item -LiteralPath $callsFile -Force }
  $output = ''
  $threw = $null
  try {
    $output = (& $Action *>&1 | Out-String)
  } catch {
    $threw = $_.Exception.Message
  }
  $calls = ''
  if (Test-Path -LiteralPath $callsFile) { $calls = [System.IO.File]::ReadAllText($callsFile) }
  return [PSCustomObject]@{ output = $output; calls = $calls; threw = $threw }
}

$presentBin = $env:EZ_TEST_BIN_WITH_PM2
$missingBin = $env:EZ_TEST_BIN_WITHOUT_PM2
$rootWithPm2 = $env:EZ_TEST_ROOT_WITH_PM2
$rootWithoutPm2 = $env:EZ_TEST_ROOT_WITHOUT_PM2

$present = Invoke-Case 'present' $presentBin $rootWithPm2 '0' { Invoke-Pm2Offer -Install -NoPrompt }
Add-Check 'a present PM2 prints its version' ($present.output -match 'PM2 9\.9\.9 .*already installed') $present.output
Add-Check 'a present PM2 is never installed again' (-not ($present.calls -match 'i -g pm2')) $present.calls

$forced = Invoke-Case 'forced' $missingBin $rootWithoutPm2 '0' { Invoke-Pm2Offer -Install -NoPrompt }
Add-Check 'the install switch runs npm i -g pm2 exactly once' (
  (@($forced.calls -split '\r?\n' | Where-Object { $_ -eq 'i -g pm2' }).Count -eq 1)) $forced.calls
Add-Check 'and never throws' ($null -eq $forced.threw) $forced.threw
Add-Check 'and says PM2 was installed' ($forced.output -match 'PM2 9\.9\.9 installed|PM2 was installed') $forced.output

$skipped = Invoke-Case 'skipped' $missingBin $rootWithoutPm2 '0' { Invoke-Pm2Offer -Skip }
Add-Check 'the skip switch never calls npm' ($skipped.calls -eq '') $skipped.calls
Add-Check 'and says how to install it later' (
  ($skipped.output -match 'Skipping PM2 \(-NoPm2\)') -and ($skipped.output -match 'npm i -g pm2')) $skipped.output

$noPrompt = Invoke-Case 'noprompt' $missingBin $rootWithoutPm2 '0' { Invoke-Pm2Offer -NoPrompt }
Add-Check 'no terminal and no switch installs nothing' ($noPrompt.calls -eq '') $noPrompt.calls
Add-Check 'and prints the exact command' (
  ($noPrompt.output -match 'No terminal is available') -and ($noPrompt.output -match 'npm i -g pm2')) $noPrompt.output

$failed = Invoke-Case 'failed' $missingBin $rootWithoutPm2 '1' { Invoke-Pm2Offer -Install -NoPrompt }
Add-Check 'a failed PM2 install does not throw' ($null -eq $failed.threw) $failed.threw
Add-Check 'a failed PM2 install prints the command to run' (
  ($failed.output -match 'PM2 was not installed') -and ($failed.output -match 'npm i -g pm2')) $failed.output
Add-Check 'a failed PM2 install says Easy DevOps still works' (
  $failed.output -match 'works without it') $failed.output

Add-Check 'only y and yes are accepted, in any case' (
  (Test-Pm2AnswerAccepted -Answer 'y') -and
  (Test-Pm2AnswerAccepted -Answer 'Y') -and
  (Test-Pm2AnswerAccepted -Answer 'yes') -and
  (Test-Pm2AnswerAccepted -Answer 'YES') -and
  -not (Test-Pm2AnswerAccepted -Answer '') -and
  -not (Test-Pm2AnswerAccepted -Answer 'n') -and
  -not (Test-Pm2AnswerAccepted -Answer 'no') -and
  -not (Test-Pm2AnswerAccepted -Answer 'x'))

Add-Check 'the pm2 command was never executed' (
  -not (Test-Path -LiteralPath $env:EZ_TEST_PM2_MARKER))

[System.IO.File]::WriteAllText(
  $env:EZ_TEST_RESULTS,
  (ConvertTo-Json -InputObject ([PSCustomObject]@{ checks = @($script:checks) }) -Depth 5 -Compress)
)

$failedChecks = @($script:checks | Where-Object { -not $_.passed })
if ($failedChecks.Count -gt 0) { exit 1 }
`);

  const result = await runBashCommand(powerShell, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', harness,
  ], {
    cwd: dir,
    env: {
      TEMP: dir,
      TMP: dir,
      EZ_TEST_INSTALLER_SCRIPT: PS_SCRIPT,
      EZ_TEST_BIN_WITH_PM2: withPm2,
      EZ_TEST_BIN_WITHOUT_PM2: withoutPm2,
      EZ_TEST_ROOT_WITH_PM2: rootWithPm2,
      EZ_TEST_ROOT_WITHOUT_PM2: rootWithoutPm2,
      EZ_TEST_PM2_MARKER: pm2Marker,
      EZ_TEST_SCRATCH: dir,
      EZ_TEST_RESULTS: resultsFile,
    },
  });

  let observed = null;
  try {
    observed = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  } catch {
    // The process result below carries the useful failure text.
  }

  check('the PowerShell PM2 harness exits cleanly', result.code === 0 && observed !== null,
    `exit ${result.code}: ${(result.stderr || result.stdout).slice(0, 320)}`);
  for (const item of observed?.checks ?? []) {
    check(item.name, item.passed, item.detail);
  }
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write('\nInstaller: release integrity, fail-closed downloads and launch isolation\n');
  process.stdout.write(`data dir: ${TEST_DATA_DIR}\n`);

  // Static assertions need no shell at all.
  await testStaticHardening();

  const bash = await findBash();
  if (!bash) {
    check('the shell cases are skipped', true, 'no bash on this machine; the static checks above still ran');
  } else {
    process.stdout.write(`\nbash: ${bash}\n`);
    await testHelp(bash);
    await testCloneLayout(bash);
    await testPiped(bash);
    await testLegacyLayout(bash);
    await testAlteredModule(bash);
    await testNvmBootstrap(bash);
    await testPm2Offer(bash);
    await testPm2Prompt(bash);
  }

  const powerShell = await findPowerShell();
  if (!powerShell) {
    check('the PowerShell cases are skipped', true, 'no PowerShell on this machine; the static checks above still ran');
  } else {
    process.stdout.write(`\nPowerShell: ${powerShell}\n`);
    await testWindowsInstaller(powerShell);
    await testWindowsPm2(powerShell);
  }

  const failed = results.filter((r) => !r.passed);
  process.stdout.write(`\n${'-'.repeat(62)}\n`);
  process.stdout.write(`TOTAL ${results.length}   PASS ${results.length - failed.length}   FAIL ${failed.length}\n`);
  if (failed.length) {
    process.stdout.write('\nFailures:\n');
    for (const f of failed) process.stdout.write(`  [${f.group}] ${f.label}${f.detail ? ` - ${f.detail}` : ''}\n`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(String(e.stack || e) + '\n');
  process.exit(1);
});
