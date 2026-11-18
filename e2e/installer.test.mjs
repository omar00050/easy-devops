/**
 * Tests for install.sh — where it finds its modules, and that it never writes
 * into the directory it happens to be run from.
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
 * Every run here is against a COPY of install.sh inside the temp data
 * directory, with `EZ_INSTALL_NO_DOWNLOAD=1` so nothing is fetched, and with a
 * stub `npm`/`node`/`nvm`/`curl` ahead of PATH so that even a run which gets
 * past module loading cannot install anything. Nothing is ever executed from
 * the repository checkout, and no network request is made.
 */

import './lib/guard.mjs';
import { TEST_DATA_DIR, assertInsideTestDataDir } from './lib/guard.mjs';

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

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
const MODULES = ['progress.sh', 'detect.sh', 'node-versions.sh', 'picker.sh', 'nvm-bootstrap.sh'];

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
      // No network, no matter what.
      EZ_INSTALL_NO_DOWNLOAD: '1',
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
  const before = snapshot(dir);

  const help = await runScript(bash, {
    cwd: dir,
    scriptPath: SCRIPT,
    args: ['--help'],
    piped: true,
  });

  check('--help works when piped', help.code === 0 && /Usage:/.test(help.stdout),
    `exit ${help.code}: ${help.stderr.slice(0, 120)}`);

  // Past the flags, with no modules reachable and downloads disabled, it has
  // to fail with a clear message rather than writing anything.
  const run = await runScript(bash, {
    cwd: dir,
    scriptPath: SCRIPT,
    args: ['--no-service'],
    piped: true,
  });

  const output = run.stdout + run.stderr;
  check('without modules it refuses rather than guessing', run.code === 1, `exit ${run.code}`);
  check('naming where it looked', /src\/lib\/installer/.test(output), output.slice(0, 200));
  check('and how to fix it', /[Cc]lone the repository/.test(output), output.slice(0, 200));

  const created = snapshot(dir).filter((f) => !before.includes(f));
  check('nothing was written into the current directory', created.length === 0, created.join(', '));
  check('specifically no lib/installer', !fs.existsSync(path.join(dir, 'lib')));
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

// ─── 5. The download URL ─────────────────────────────────────────────────────

async function testDownloadUrl() {
  setGroup('5. the download URL points where the files are');

  const text = fs.readFileSync(SCRIPT, 'utf8');
  const base = text.match(/_LIB_BASE="([^"]+)"/)?.[1] ?? '';

  check('the fallback URL includes src/lib/installer', /\/src\/lib\/installer$/.test(base), base);

  // The files it would fetch are the ones that exist in the repository: a URL
  // that is right about the directory and wrong about the names fails just as
  // completely.
  const listed = text.match(/_LIB_MODULES="([^"]+)"/)?.[1]?.split(/\s+/) ?? [];
  const missing = listed.filter((m) => !fs.existsSync(path.join(ROOT, 'src', 'lib', 'installer', m)));
  check('and every module it names exists in src/lib/installer',
    listed.length > 0 && missing.length === 0, missing.join(', '));

  // The published package has to ship them, or an npm install cannot run the
  // installer at all.
  const files = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).files ?? [];
  check('and package.json ships src/, which contains them',
    files.some((f) => f === 'src/' || f === 'src'), files.join(', '));

  // A temporary directory, never the current one. This is the line that
  // created the stray lib/installer.
  check('a download goes to a temporary directory', /mktemp -d/.test(text));
  check('with a trap to clean it up', /trap _cleanup_lib_tmp EXIT/.test(text));
  check('and no mkdir into the working directory remains',
    !/mkdir -p "\$LIB_DIR"/.test(text));
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write('\nInstaller: module resolution for a clone, a package and curl | bash\n');
  process.stdout.write(`data dir: ${TEST_DATA_DIR}\n`);

  // The static assertions need no shell at all.
  await testDownloadUrl();

  const bash = await findBash();
  if (!bash) {
    check('the shell cases are skipped', true, 'no bash on this machine; the static checks above still ran');
  } else {
    process.stdout.write(`\nbash: ${bash}\n`);
    await testHelp(bash);
    await testCloneLayout(bash);
    await testPiped(bash);
    await testLegacyLayout(bash);
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
