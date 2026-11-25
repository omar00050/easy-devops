/**
 * Standalone-installer tests: the documented one-line install commands.
 *
 * A one-line install has no repository beside it. These cases prove that:
 *   - the helper bundle is downloaded into a private 0700 directory and every
 *     byte is checked against the SHA-256 pinned in install.sh before it runs;
 *   - a tampered or missing helper stops the install with a clear message and
 *     nothing unverified is sourced;
 *   - local helpers beside the script still win over the download;
 *   - nvm is installed only from a pinned, verified release, and never when the
 *     owner has not pinned a digest yet;
 *   - install.ps1 resolves the installed package from `npm root -g` when it was
 *     downloaded alone, and offers Node.js LTS with winget when Node is absent;
 *   - install.bat maps the documented flags to install.ps1 parameter names.
 *
 * Run with:  node e2e/run.mjs installer-standalone
 *
 * No network request is made. Helpers and the nvm installer are served from a
 * temporary fixture with a file:// URL; PowerShell runs with a stub npm/winget
 * and no real install path is touched.
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
const SCRIPT = path.join(ROOT, 'install.sh');
const PS_SCRIPT = path.join(ROOT, 'install.ps1');
const BAT_SCRIPT = path.join(ROOT, 'install.bat');
const MODULES = ['progress.sh', 'detect.sh', 'node-versions.sh', 'picker.sh', 'nvm-bootstrap.sh'];

const results = [];
let group = '';
function setGroup(g) { group = g; process.stdout.write(`\n-- ${g}\n`); }
function check(label, passed, detail = '') {
  results.push({ group, label, passed, detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}
function skip(label, why) {
  process.stdout.write(`   SKIP  ${label}  (${why})\n`);
}

function scratch(name) {
  const dir = path.join(TEST_DATA_DIR, 'scratch', name);
  assertInsideTestDataDir(dir, `create the scratch dir ${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sha256Normalized(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function fileUrl(p) {
  return pathToFileURL(p).href;
}

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

async function findPowerShell() {
  const candidates = process.platform === 'win32' ? ['powershell.exe', 'pwsh'] : ['pwsh', 'powershell'];
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

function run(command, args, { cwd, env = {}, timeout = 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { child.kill(); resolve({ code: 124, stdout, stderr, timedOut: true }); }, timeout);
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(err), error: true }); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** <base>/src/lib/installer/<module>, exactly what install.sh downloads from. */
function helperFixture(name) {
  const dir = scratch(name);
  const target = path.join(dir, 'src', 'lib', 'installer');
  fs.mkdirSync(target, { recursive: true });
  for (const module of MODULES) {
    fs.copyFileSync(path.join(ROOT, 'src', 'lib', 'installer', module), path.join(target, module));
  }
  return { dir, baseUrl: fileUrl(dir).replace(/\/$/, '') };
}

// ─── 1. Pinned hashes ────────────────────────────────────────────────────────

function testPinnedHashes() {
  setGroup('1. every helper matches the SHA-256 pinned in the installers');

  const shell = fs.readFileSync(SCRIPT, 'utf8');
  const ps = fs.readFileSync(PS_SCRIPT, 'utf8');

  const listed = shell.match(/_LIB_MODULES="([^"]+)"/)?.[1]?.split(/\s+/) ?? [];
  const pinned = new Map(
    [...shell.matchAll(/([A-Za-z0-9.-]+\.sh)\)\s+printf '%s\\n' '([0-9a-f]{64})'/g)]
      .map((m) => [m[1], m[2]]),
  );

  const mismatched = [];
  for (const module of listed) {
    const actual = sha256Normalized(path.join(ROOT, 'src', 'lib', 'installer', module));
    if (pinned.get(module) !== actual) mismatched.push(`${module}: ${pinned.get(module)} != ${actual}`);
  }
  check('the module list is not empty and every entry is pinned',
    listed.length > 0 && listed.every((m) => pinned.has(m)), listed.join(', '));
  check('every pinned helper hash still matches its file (editing one without the pin fails CI)',
    mismatched.length === 0, mismatched.join('; '));

  const shellFiles = fs.readdirSync(path.join(ROOT, 'src', 'lib', 'installer'))
    .filter((f) => f.endsWith('.sh') && !f.startsWith('.'));
  const unpinned = shellFiles.filter((f) => !pinned.has(f));
  check('no shell helper is shipped without a pin', unpinned.length === 0, unpinned.join(', '));

  const wingetPin = /\$WINGET_INSTALL_PS1_SHA256\s*=\s*'([0-9a-f]{64})'/.exec(ps)?.[1] ?? '';
  const wingetActual = sha256Normalized(path.join(ROOT, 'src', 'lib', 'installer', 'winget-install.ps1'));
  check('winget-install.ps1 matches the digest pinned in install.ps1',
    wingetPin !== '' && wingetPin === wingetActual, `${wingetPin} vs ${wingetActual}`);
}

// ─── 2. install.sh standalone, with a local fixture ─────────────────────────

async function testShellStandalone(bash) {
  setGroup('2. install.sh alone downloads, verifies and sources the helper bundle');

  const dir = scratch('standalone-shell');
  fs.copyFileSync(SCRIPT, path.join(dir, 'install.sh'));
  const tmp = path.join(dir, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const fixture = helperFixture('standalone-shell-fixture');
  const before = snapshot(dir);

  const result = await run(bash, ['install.sh', '--check-helpers'], {
    cwd: dir,
    env: { EZ_INSTALLER_BASE_URL: fixture.baseUrl, TMPDIR: tmp },
  });
  const output = result.stdout + result.stderr;

  check('a standalone --check-helpers run exits 0', result.code === 0,
    `exit ${result.code}: ${output.slice(0, 300)}`);
  check('all five helpers were downloaded and verified',
    /check-helpers: verified 5 helper module\(s\)/.test(output), output.slice(0, 300));
  check('they lived in a private directory requested as 0700',
    /in a private directory \(requested 0700/.test(output), output.slice(0, 300));
  if (process.platform !== 'win32') {
    check('and the directory actually has mode 700 on this platform',
      /requested 0700, mode 700/.test(output), output.slice(0, 300));
  }
  check('the record names the download source',
    /downloaded from file:\/\//.test(output), output.slice(0, 300));

  const created = snapshot(dir).filter((f) => !before.includes(f)).filter((f) => f !== 'tmp/');
  check('nothing is written beside the script', created.length === 0, created.join(', '));
  check('the private helper directory is removed on exit',
    fs.readdirSync(tmp).length === 0, fs.readdirSync(tmp).join(', '));

  // A tampered helper must stop before anything is sourced.
  setGroup('3. a tampered helper is refused before it runs');
  const tampered = helperFixture('standalone-shell-tampered');
  fs.appendFileSync(path.join(tampered.dir, 'src', 'lib', 'installer', 'progress.sh'), '\n# tampered\n');

  const tamperedTmp = path.join(dir, 'tmp-tampered');
  fs.mkdirSync(tamperedTmp, { recursive: true });
  const bad = await run(bash, ['install.sh', '--check-helpers'], {
    cwd: dir,
    env: { EZ_INSTALLER_BASE_URL: tampered.baseUrl, TMPDIR: tamperedTmp },
  });
  const badOutput = bad.stdout + bad.stderr;
  check('the tampered helper exits non-zero', bad.code === 1, `exit ${bad.code}`);
  check('the message names the file and both hashes',
    /progress\.sh does not match the reviewed release/.test(badOutput)
      && /expected: [0-9a-f]{64}/.test(badOutput)
      && /actual:\s+[0-9a-f]{64}/.test(badOutput),
    badOutput.slice(0, 400));
  check('it says what to do next',
    /Download the installer again/.test(badOutput) && /issues/.test(badOutput), badOutput.slice(0, 400));
  check('nothing was sourced or run from the tampered bundle',
    !/check-helpers: verified/.test(badOutput) && !/Easy DevOps -- Bootstrap Installer/.test(badOutput),
    badOutput.slice(0, 300));
  check('the refused run still cleans its private directory',
    fs.readdirSync(tamperedTmp).length === 0, fs.readdirSync(tamperedTmp).join(', '));

  // Local helpers beside the script beat the URL, even a bad one.
  setGroup('4. local helpers beside the script take priority');
  const local = scratch('standalone-shell-local');
  fs.copyFileSync(SCRIPT, path.join(local, 'install.sh'));
  const localModules = path.join(local, 'src', 'lib', 'installer');
  fs.mkdirSync(localModules, { recursive: true });
  for (const module of MODULES) {
    fs.copyFileSync(path.join(ROOT, 'src', 'lib', 'installer', module), path.join(localModules, module));
  }
  const localTmp = path.join(local, 'tmp');
  fs.mkdirSync(localTmp, { recursive: true });

  const localRun = await run(bash, ['install.sh', '--check-helpers'], {
    cwd: local,
    env: { EZ_INSTALLER_BASE_URL: tampered.baseUrl, TMPDIR: localTmp },
  });
  const localOutput = localRun.stdout + localRun.stderr;
  check('the local bundle wins over the configured URL', localRun.code === 0,
    `exit ${localRun.code}: ${localOutput.slice(0, 300)}`);
  check('the record says it used local files',
    /from local files beside the installer/.test(localOutput), localOutput.slice(0, 300));
  check('so a broken download source cannot break a clone', !/does not match/.test(localOutput));

  // A missing helper is a clear download failure, never a silent skip.
  setGroup('5. a failed helper download stops with the file and URL');
  const empty = scratch('standalone-shell-empty');
  const emptyTmp = path.join(empty, 'tmp');
  fs.mkdirSync(emptyTmp, { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(empty, 'install.sh'));
  const missing = await run(bash, ['install.sh', '--check-helpers'], {
    cwd: empty,
    env: { EZ_INSTALLER_BASE_URL: fileUrl(empty), TMPDIR: emptyTmp },
  });
  const missingOutput = missing.stdout + missing.stderr;
  check('a missing helper exits non-zero', missing.code === 1, `exit ${missing.code}`);
  check('it names the file and the URL it tried',
    /could not download installer helper progress\.sh from/.test(missingOutput),
    missingOutput.slice(0, 400));
  check('and points at the official release',
    /Easy-DevOps\/releases/.test(missingOutput), missingOutput.slice(0, 400));
}

// ─── 6. nvm-bootstrap: pinned digest or exact manual commands ───────────────

async function testNvmBootstrap(bash) {
  setGroup('6. nvm is downloaded only from a pinned release');

  const helper = path.join(ROOT, 'src', 'lib', 'installer', 'nvm-bootstrap.sh');

  // Empty pinned digest: nothing may be fetched.
  const dir = scratch('standalone-nvm-empty');
  const home = path.join(dir, 'home');
  const nvmDir = path.join(home, '.nvm');
  fs.mkdirSync(home, { recursive: true });
  const downloaders = scratch('standalone-nvm-downloaders');
  for (const tool of ['curl', 'wget']) {
    const file = path.join(downloaders, tool);
    fs.writeFileSync(file, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "\${0}.called"\nexit 1\n`);
    fs.chmodSync(file, 0o755);
  }

  const emptyRun = await run(bash, [
    '-c', '. "$1"; HOME="$2"; NVM_DIR="$3"; bootstrap_nvm',
    'harness', helper, home, nvmDir,
  ], {
    cwd: dir,
    env: { PATH: `${downloaders}${path.delimiter}${process.env.PATH}` },
  });
  const emptyOutput = emptyRun.stdout + emptyRun.stderr;
  check('an empty pinned digest stops the install', emptyRun.code === 1, `exit ${emptyRun.code}`);
  check('it prints the exact official nvm install command for NVM_VERSION',
    /curl -o- https:\/\/raw\.githubusercontent\.com\/nvm-sh\/nvm\/v0\.40\.\d+\/install\.sh \| bash/.test(emptyOutput),
    emptyOutput.slice(0, 320));
  check('then source ~/.nvm/nvm.sh and bash install.sh',
    /source ~\/\.nvm\/nvm\.sh/.test(emptyOutput) && /bash install\.sh/.test(emptyOutput),
    emptyOutput.slice(0, 360));
  check('and offers --keep-node with a distro Node.js 18+',
    /--keep-node/.test(emptyOutput), emptyOutput.slice(0, 360));
  check('nothing was downloaded', !fs.existsSync(path.join(downloaders, 'curl.called'))
    && !fs.existsSync(path.join(downloaders, 'wget.called')));
  check('no nvm.sh was created', !fs.existsSync(path.join(nvmDir, 'nvm.sh')));

  // A pinned digest (test hook only) with a fixture installer.
  const fixtureDir = scratch('standalone-nvm-fixture');
  const fixtureInstaller = path.join(fixtureDir, 'nvm-install.sh');
  fs.writeFileSync(fixtureInstaller, [
    '#!/usr/bin/env bash',
    'set -e',
    'mkdir -p "$NVM_DIR"',
    'cat > "$NVM_DIR/nvm.sh" <<\'NVM\'',
    'nvm() { :; }',
    'NVM',
    'chmod 644 "$NVM_DIR/nvm.sh"',
    'printf ran > "$NVM_DIR/fixture-ran"',
    '',
  ].join('\n'));
  const fixtureHash = sha256Normalized(fixtureInstaller);

  const goodHome = path.join(dir, 'home-good');
  const goodNvm = path.join(goodHome, '.nvm');
  fs.mkdirSync(goodHome, { recursive: true });
  const goodRun = await run(bash, [
    '-c', '. "$1"; HOME="$2"; NVM_DIR="$3"; bootstrap_nvm',
    'harness', helper, goodHome, goodNvm,
  ], {
    cwd: dir,
    env: {
      EZ_TEST: '1',
      EZ_TEST_NVM_SHA256: fixtureHash,
      EZ_TEST_NVM_INSTALL_URL: fileUrl(fixtureInstaller),
    },
  });
  const goodOutput = goodRun.stdout + goodRun.stderr;
  check('a matching pinned digest runs the verified installer', goodRun.code === 0,
    `exit ${goodRun.code}: ${goodOutput.slice(0, 320)}`);
  check('the verified installer actually ran', fs.existsSync(path.join(goodNvm, 'fixture-ran')));
  check('nvm.sh was created and sourced', fs.existsSync(path.join(goodNvm, 'nvm.sh'))
    && /nvm is active in this session/.test(goodOutput));

  // Wrong digest: refused, nothing run.
  const badHome = path.join(dir, 'home-bad');
  const badNvm = path.join(badHome, '.nvm');
  fs.mkdirSync(badHome, { recursive: true });
  const badRun = await run(bash, [
    '-c', '. "$1"; HOME="$2"; NVM_DIR="$3"; bootstrap_nvm',
    'harness', helper, badHome, badNvm,
  ], {
    cwd: dir,
    env: {
      EZ_TEST: '1',
      EZ_TEST_NVM_SHA256: '0'.repeat(64),
      EZ_TEST_NVM_INSTALL_URL: fileUrl(fixtureInstaller),
    },
  });
  const badOutput = badRun.stdout + badRun.stderr;
  check('a wrong digest is refused', badRun.code === 1, `exit ${badRun.code}`);
  check('the refusal names the expected and actual hashes',
    /does not match the pinned release/.test(badOutput)
      && /expected: 0{64}/.test(badOutput)
      && /actual:\s+[0-9a-f]{64}/.test(badOutput),
    badOutput.slice(0, 400));
  check('nothing from the refused installer ran', !fs.existsSync(path.join(badNvm, 'fixture-ran'))
    && !fs.existsSync(path.join(badNvm, 'nvm.sh')));
}

// ─── 7. install.ps1 resolves the installed package when downloaded alone ────

async function testPowerShellStandalone(powerShell) {
  setGroup('7. install.ps1 standalone resolves the installed package');

  const dir = scratch('standalone-ps');
  const psDir = path.join(dir, 'installer');
  fs.mkdirSync(psDir, { recursive: true });
  fs.copyFileSync(PS_SCRIPT, path.join(psDir, 'install.ps1'));

  const goodRoot = path.join(dir, 'npm-root');
  const entryExpected = path.join(goodRoot, 'easy-devops', 'src', 'cli', 'index.js');
  fs.mkdirSync(path.dirname(entryExpected), { recursive: true });
  fs.writeFileSync(entryExpected, '// installed entry point\n');

  const emptyRoot = path.join(dir, 'empty-npm-root');
  fs.mkdirSync(emptyRoot, { recursive: true });

  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'npm.cmd'), '@echo off\r\necho %EZ_TEST_NPM_OUT%\r\n');
  fs.writeFileSync(path.join(bin, 'winget.cmd'),
    '@echo off\r\necho ran>"%EZ_TEST_WINGET_MARKER%"\r\nexit /b 0\r\n');

  const wingetMarker = path.join(dir, 'winget-ran.txt');
  const resultsFile = path.join(dir, 'results.json');

  // The resolved-package scenarios need a real node.exe (this test runs on
  // Node), but must not find the real winget or node in the fallback case.
  const realPath = `${bin}${path.delimiter}${process.env.PATH}`;
  const bareDirs = (process.env.PATH || '').split(path.delimiter)
    .filter((d) => d && !fs.existsSync(path.join(d, 'node.exe')) && !fs.existsSync(path.join(d, 'winget.exe')));
  const barePath = [bin, ...bareDirs].join(path.delimiter);

  const harness = path.join(dir, 'harness.ps1');
  fs.writeFileSync(harness, String.raw`
$ErrorActionPreference = 'Stop'
$env:EZ_INSTALLER_TEST_FUNCTIONS_ONLY = '1'
. $env:EZ_TEST_INSTALLER_SCRIPT

$env:Path = $env:EZ_TEST_REAL_PATH
$env:EZ_TEST_NPM_OUT = $env:EZ_TEST_GOOD_ROOT
$resolved = Get-EzServiceInvocation

$env:EZ_TEST_NPM_OUT = $env:EZ_TEST_EMPTY_ROOT
$missingInv = $null
$missingOutput = (& { $script:missingInv = Get-EzServiceInvocation } *>&1 | Out-String)

$env:Path = $env:EZ_TEST_BARE_PATH
$fallbackOutput = (& { Invoke-NodeLtsFallback -NonInteractive } *>&1 | Out-String)
$wingetRan = Test-Path -LiteralPath $env:EZ_TEST_WINGET_MARKER

$output = [PSCustomObject]@{
  resolved = if ($resolved) {
    [PSCustomObject]@{
      exec = $resolved.ExecPath
      args = @($resolved.Args)
      firstArg = @($resolved.Args)[0]
      cwd = $resolved.Cwd
    }
  } else { $null }
  missingIsNull = ($null -eq $missingInv)
  missingOutput = $missingOutput
  fallbackOutput = $fallbackOutput
  wingetRan = $wingetRan
}
[System.IO.File]::WriteAllText(
  $env:EZ_TEST_RESULTS,
  (ConvertTo-Json -InputObject $output -Depth 5 -Compress)
)
`);

  const result = await run(powerShell, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness,
  ], {
    cwd: dir,
    env: {
      TEMP: dir,
      TMP: dir,
      EZ_TEST_INSTALLER_SCRIPT: path.join(psDir, 'install.ps1'),
      EZ_TEST_GOOD_ROOT: goodRoot,
      EZ_TEST_EMPTY_ROOT: emptyRoot,
      EZ_TEST_REAL_PATH: realPath,
      EZ_TEST_BARE_PATH: barePath,
      EZ_TEST_WINGET_MARKER: wingetMarker,
      EZ_TEST_RESULTS: resultsFile,
    },
  });

  let observed = null;
  try { observed = JSON.parse(fs.readFileSync(resultsFile, 'utf8')); } catch { /* reported below */ }

  check('the PowerShell harness exits cleanly', result.code === 0 && observed !== null,
    `exit ${result.code}: ${(result.stderr || result.stdout).slice(0, 300)}`);
  check('a standalone install.ps1 resolves npm root -g\\easy-devops\\src\\cli\\index.js',
    observed?.resolved?.firstArg
      && path.resolve(observed.resolved.firstArg) === path.resolve(entryExpected),
    observed?.resolved?.firstArg ?? 'null');
  check('the invocation calls the service install action',
    JSON.stringify(observed?.resolved?.args ?? []) ===
      JSON.stringify([entryExpected, 'service', 'install']),
    JSON.stringify(observed?.resolved?.args ?? null));

  check('a missing installed package returns null with a clear message',
    observed?.missingIsNull === true
      && /Could not find the installed Easy DevOps package/.test(observed?.missingOutput ?? '')
      && /npm install -g easy-devops/.test(observed?.missingOutput ?? ''),
    (observed?.missingOutput ?? '').slice(0, 240));

  const fallbackText = observed?.fallbackOutput ?? '';
  check('no Node and no pin prints the exact winget command',
    /winget install --id OpenJS\.NodeJS\.LTS -e/.test(fallbackText), fallbackText.slice(0, 300));
  check('and the nodejs.org LTS installer link',
    /https:\/\/nodejs\.org\/en\/download/.test(fallbackText), fallbackText.slice(0, 300));
  check('a non-interactive run does not execute winget', observed?.wingetRan === false);
}

// ─── 8. install.bat maps the documented flags ───────────────────────────────

async function testBatchMapping() {
  setGroup('8. install.bat maps long options to install.ps1 parameters');

  const dir = scratch('standalone-bat');
  fs.copyFileSync(BAT_SCRIPT, path.join(dir, 'install.bat'));
  // The stub powershell never reads this; it only has to exist beside the bat.
  fs.writeFileSync(path.join(dir, 'install.ps1'), '# stub install.ps1\n');

  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'powershell.cmd'), [
    '@echo off',
    'setlocal',
    'if /i "%~1"=="-NoProfile" if /i "%~2"=="-Command" (',
    '  echo 5.1',
    '  exit /b 0',
    ')',
    'echo %*>>"%EZ_TEST_PS_ARGS%"',
    'exit /b 0',
    '',
  ].join('\r\n'));

  const argsFile = path.join(dir, 'ps-args.txt');
  const result = await run('cmd.exe', [
    '/d', '/c', path.join(dir, 'install.bat'),
    '--help', '--version', '20', '--keep-node', '--service', '--no-service',
    '--yes', '--non-interactive', '--custom-flag',
  ], {
    cwd: dir,
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      EZ_TEST_PS_ARGS: argsFile,
    },
  });

  let line = '';
  try {
    line = (fs.readFileSync(argsFile, 'utf8').split(/\r?\n/).find((l) => l.includes('-File')) ?? '').trim();
  } catch { /* reported below */ }

  check('install.bat runs', result.code === 0, `exit ${result.code}: ${(result.stderr || result.stdout).slice(0, 240)}`);
  check('--help becomes -Help and --version 20 becomes -Version 20',
    /\s-Help(\s|$)/.test(line) && /\s-Version 20(\s|$)/.test(line) && !/--help|--version/.test(line), line);
  check('--keep-node, --service and --no-service are mapped',
    /\s-KeepNode(\s|$)/.test(line) && /\s-Service(\s|$)/.test(line) && /\s-NoService(\s|$)/.test(line), line);
  check('--yes and --non-interactive are mapped',
    /\s-Yes(\s|$)/.test(line) && /\s-NonInteractive(\s|$)/.test(line), line);
  check('anything else is passed through unchanged', /\s--custom-flag(\s|$)/.test(line), line);
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write('\nInstaller (standalone): pinned helpers, nvm, npm-root resolution and flag mapping\n');
  process.stdout.write(`data dir: ${TEST_DATA_DIR}\n`);

  testPinnedHashes();

  const bash = await findBash();
  if (!bash) {
    skip('install.sh standalone cases', 'SKIP: no bash on this machine');
  } else {
    process.stdout.write(`\nbash: ${bash}\n`);
    await testShellStandalone(bash);
    await testNvmBootstrap(bash);
  }

  if (process.platform !== 'win32') {
    skip('install.ps1 / install.bat cases', 'not Windows');
  } else {
    const powerShell = await findPowerShell();
    if (!powerShell) {
      skip('install.ps1 standalone cases', 'SKIP: no PowerShell on this machine');
    } else {
      process.stdout.write(`\nPowerShell: ${powerShell}\n`);
      await testPowerShellStandalone(powerShell);
    }
    await testBatchMapping();
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
