/**
 * Which bytes a captured command result keeps, said out loud.
 *
 * core/shell.js used to keep only the newest 64 KiB of stdout/stderr with no
 * sign that anything was dropped. Two callers then read the tail as if it were
 * the whole output: `pm2 jlist` lost its leading `[{` (so every list consumer
 * saw "no processes"), and `git ls-remote` lost its first branches (so an
 * existing branch looked missing).
 *
 * This suite proves the three explicit modes, the exact `truncated` counts, the
 * hard failure when `full` hits its cap, and both real consumers against
 * stubs. Nothing here runs PM2, git, ssh or any network command: children are
 * `process.execPath -e ...` scripts, and the pm2/git stand-ins are ours.
 *
 * Run with:  npm run test:e2e -- shell-output
 */

// MUST be the first import (see e2e/lib/guard.mjs).
import './lib/guard.mjs';
import { TEST_DATA_DIR, assertInsideTestDataDir } from './lib/guard.mjs';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const srcUrl = (relative) => pathToFileURL(path.join(ROOT, 'src', relative)).href;
const isWin = process.platform === 'win32';

const results = [];
let group = '';

function setGroup(name) {
  group = name;
  process.stdout.write(`\n-- ${group}\n`);
}

function check(label, passed, detail = '') {
  results.push({ group, label, passed: Boolean(passed), detail });
  process.stdout.write(
    `   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`,
  );
}

function scratch(name) {
  const dir = path.join(TEST_DATA_DIR, 'scratch', name);
  assertInsideTestDataDir(dir, `create ${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A child that writes a fixed number of ASCII bytes around two markers. */
function floodSource({ outBytes, errBytes }) {
  return `
    function body(label, total) {
      const head = 'HEAD-' + label + '-MARKER|';
      const tail = '|TAIL-' + label + '-MARKER';
      const fill = Math.max(0, total - head.length - tail.length);
      return head + 'x'.repeat(fill) + tail;
    }
    process.stdout.write(body('STDOUT', ${outBytes}));
    process.stderr.write(body('STDERR', ${errBytes}));
  `;
}

async function testTailMode(shell) {
  setGroup('tail mode keeps the newest bytes and counts the rest');
  const limit = shell.SHELL_CAPTURE_TAIL_BYTES;
  const outBytes = 100 * 1024;
  const errBytes = 90 * 1024;

  check('the tail budget is still 64 KiB', limit === 64 * 1024, String(limit));
  check('the mode names are exported and frozen',
    Object.isFrozen(shell.SHELL_OUTPUT_MODES)
      && shell.SHELL_OUTPUT_MODES.join(',') === 'tail,full,stream',
    shell.SHELL_OUTPUT_MODES.join(','));

  const result = await shell.runFile(process.execPath, ['-e', floodSource({ outBytes, errBytes })]);

  check('a default run is a successful tail capture', result.success === true && result.exitCode === 0);
  check('stdout is exactly the newest 64 KiB, head dropped',
    Buffer.byteLength(result.stdout, 'utf8') === limit
      && result.stdout.endsWith('|TAIL-STDOUT-MARKER')
      && !result.stdout.includes('HEAD-STDOUT-MARKER'),
    `${Buffer.byteLength(result.stdout, 'utf8')} bytes`);
  check('truncated.stdout is the exact number of bytes dropped',
    result.truncated?.stdout === outBytes - limit,
    `${result.truncated?.stdout} = ${outBytes - limit}`);
  check('stderr is counted separately from stdout',
    result.truncated?.stderr === errBytes - limit
      && result.truncated.stderr !== result.truncated.stdout
      && result.stderr.endsWith('|TAIL-STDERR-MARKER'),
    `${result.truncated?.stderr} = ${errBytes - limit}`);
}

async function testFullMode(shell) {
  setGroup('full mode returns every byte, or refuses loudly over its cap');

  const payload = '0123456789abcdef'.repeat(64 * 1024); // exactly 1 MiB, no whitespace
  const whole = await shell.runFile(
    process.execPath,
    ['-e', "process.stdout.write('0123456789abcdef'.repeat(65536));"],
    { output: 'full' },
  );

  check('full mode succeeds below its default cap', whole.success === true);
  check('full mode returns the whole 1 MB output byte for byte',
    whole.stdout === payload && Buffer.byteLength(whole.stdout, 'utf8') === 1024 * 1024,
    `${Buffer.byteLength(whole.stdout, 'utf8')} bytes`);
  check('full mode reports nothing dropped',
    whole.truncated?.stdout === 0 && whole.truncated?.stderr === 0,
    JSON.stringify(whole.truncated));

  // A 100 KB cap, an unbounded writer, and the child's pid so we can prove it
  // is gone rather than merely detached.
  const cap = 100 * 1024;
  const cappedSource = `
    process.stdout.write('PID:' + process.pid + '\\n');
    process.stdout.write('y'.repeat(300 * 1024));
    setInterval(() => {}, 1000);
  `;

  const capped = await shell.runFile(process.execPath, ['-e', cappedSource], {
    output: 'full',
    maxBytes: cap,
    timeout: 20_000,
  });

  check('full mode over the cap fails instead of cutting silently',
    capped.success === false && capped.exitCode === null,
    `${capped.success}/${capped.exitCode}`);
  check('the failure names the cap',
    capped.error === `output exceeded ${cap} bytes`,
    capped.error);
  check('the over-cap result says bytes were dropped',
    capped.truncated?.stdout > 0,
    String(capped.truncated?.stdout));
  check('only the bytes that fit are returned',
    Buffer.byteLength(capped.stdout, 'utf8') <= cap,
    `${Buffer.byteLength(capped.stdout, 'utf8')} <= ${cap}`);

  const pid = Number((capped.stdout.match(/^PID:(\d+)/) ?? [])[1]);
  const gone = Number.isInteger(pid) ? await waitFor(() => !isAlive(pid)) : false;
  check('the over-cap child is killed, not left running', gone, `pid ${pid}`);
}

async function testStreamMode(shell) {
  setGroup('stream mode buffers nothing and loses no chunk');

  const smallChunks = ['alpha|', 'BETA-é|', 'gamma|', '🛡-emoji|'];
  const bigChunkSize = 200 * 1024;
  const bigChunk = 'z'.repeat(bigChunkSize);
  const lastChunk = '|omega';
  const expected = `${smallChunks.join('')}${bigChunk}${lastChunk}`;
  const source = `
    const chunks = ${JSON.stringify(smallChunks)};
    (async () => {
      for (const chunk of chunks) {
        process.stdout.write(chunk);
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      process.stdout.write('z'.repeat(${bigChunkSize}));
      await new Promise((resolve) => setTimeout(resolve, 15));
      process.stdout.write(${JSON.stringify(lastChunk)});
    })().catch((err) => { process.stderr.write(String(err)); process.exitCode = 1; });
  `;

  let observed = '';
  let callbacks = 0;
  const result = await shell.runFile(process.execPath, ['-e', source], {
    output: 'stream',
    onData(chunk, stream) {
      if (stream !== 'stdout') return;
      callbacks += 1;
      observed += chunk;
    },
  });

  check('stream mode succeeds', result.success === true, result.stderr.slice(0, 160));
  check('stream mode delivers every byte through onData, in order',
    observed === expected,
    `${Buffer.byteLength(observed, 'utf8')} / ${Buffer.byteLength(expected, 'utf8')} bytes in ${callbacks} callback(s)`);
  check('stream mode keeps no captured text',
    result.stdout === '' && result.stderr === ''
      && result.truncated?.stdout === 0 && result.truncated?.stderr === 0);

  let thrown = null;
  try {
    shell.runFile(process.execPath, ['-e', 'process.stdout.write("x")'], { output: 'stream' });
  } catch (err) {
    thrown = err;
  }
  check('stream mode without onData is a clear programming error',
    thrown instanceof TypeError && /onData/.test(thrown.message),
    thrown?.message ?? 'did not throw');

  let badMode = null;
  try {
    shell.run('echo should-not-run', { output: 'everything' });
  } catch (err) {
    badMode = err;
  }
  check('an unknown output mode is refused',
    badMode instanceof TypeError && /Unknown shell output mode/.test(badMode.message),
    badMode?.message ?? 'did not throw');
}

async function testRunWithStdin(shell) {
  setGroup('runWithStdin accepts the same modes and reports truncation');

  const limit = shell.SHELL_CAPTURE_TAIL_BYTES;
  const outBytes = 100 * 1024;
  const errBytes = 90 * 1024;
  const tail = await shell.runWithStdin(
    process.execPath,
    ['-e', floodSource({ outBytes, errBytes })],
    '',
  );

  check('runWithStdin keeps the tail by default',
    tail.success === true
      && tail.stdout.endsWith('|TAIL-STDOUT-MARKER')
      && tail.stdout.length <= limit);
  check('runWithStdin reports the same truncated fields',
    tail.truncated?.stdout === outBytes - limit
      && tail.truncated?.stderr === errBytes - limit,
    JSON.stringify(tail.truncated));

  const payload = '0123456789abcdef'.repeat(64 * 1024);
  const full = await shell.runWithStdin(
    process.execPath,
    ['-e', "process.stdout.write('0123456789abcdef'.repeat(65536));"],
    '',
    { output: 'full' },
  );
  check('runWithStdin full mode returns the whole output',
    full.success === true && full.stdout === payload && full.truncated?.stdout === 0,
    `${Buffer.byteLength(full.stdout, 'utf8')} bytes`);

  let streamed = '';
  const stream = await shell.runWithStdin(
    process.execPath,
    ['-e', "process.stdout.write('one|two|three');"],
    '',
    { output: 'stream', onData: (chunk, name) => { if (name === 'stdout') streamed += chunk; } },
  );
  check('runWithStdin stream mode keeps nothing but delivers everything',
    stream.stdout === '' && streamed === 'one|two|three', streamed);
}

async function testRunnerList() {
  setGroup('runner.list reads a process list larger than the tail');

  const shell = await import(srcUrl('core/shell.js'));
  const runner = await import(srcUrl('core/runner.js'));

  const dir = scratch('shell-output-pm2');
  const scriptPath = path.join(dir, 'pm2-stub.mjs');
  const stubPath = path.join(dir, isWin ? 'pm2.cmd' : 'pm2');
  assertInsideTestDataDir(scriptPath, 'write the pm2 stub');
  assertInsideTestDataDir(stubPath, 'write the pm2 stub');

  const appCount = 150;
  fs.writeFileSync(scriptPath, `
    import process from 'node:process';
    const noise = '[PM2] Spawning PM2 daemon with pm2_home=C:\\\\Users\\\\tester\\\\.pm2';
    const apps = [];
    for (let i = 0; i < ${appCount}; i += 1) {
      apps.push({
        name: 'app-' + String(i).padStart(3, '0'),
        pm_id: i,
        pid: 0,
        monit: { cpu: 0, memory: 0 },
        pm2_env: {
          status: 'stopped', pm_uptime: 0, restart_time: 0, unstable_restarts: 0,
          pm_exec_path: 'C:/apps/app-' + i + '/index.js',
          pm_cwd: 'C:/apps/app-' + i,
          username: 'tester',
          env: {},
        },
        padding: 'p'.repeat(1800),
      });
    }
    process.stdout.write(noise + '\\n' + JSON.stringify(apps) + '\\n');
  `.trimStart());

  if (isWin) {
    fs.writeFileSync(stubPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
  } else {
    fs.writeFileSync(stubPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`);
    fs.chmodSync(stubPath, 0o755);
  }

  const calls = [];
  const guardedRun = async (cmd, options) => {
    if (!cmd.includes(stubPath)) {
      process.stderr.write(
        `\nABORT: refusing a PM2 command that does not point at the stub.\n  command: ${cmd}\n  stub   : ${stubPath}\n`,
      );
      process.exit(1);
    }
    calls.push({ cmd, options });
    return shell.run(cmd, options);
  };

  const listed = await runner.list({ run: guardedRun, pm2Path: stubPath });

  check('the stub pm2 is what ran', calls.length === 1 && calls[0].cmd.includes(stubPath));
  check('list() asks for the full output, not the tail',
    calls[0]?.options?.output === 'full', JSON.stringify(calls[0]?.options));
  check('all 150 processes survive a 300 KB jlist',
    listed.ok === true && listed.apps.length === appCount,
    listed.ok ? `${listed.apps.length}` : listed.error);
  check('the FIRST process is still present, not cut away',
    listed.apps[0]?.name === 'app-000' && listed.apps.at(-1)?.name === 'app-149',
    `${listed.apps[0]?.name ?? '?'} … ${listed.apps.at(-1)?.name ?? '?'}`);
}

async function testDeployKeyBranches() {
  setGroup('a branch printed first survives a 2,000-branch ls-remote');

  const shell = await import(srcUrl('core/shell.js'));
  const apps = await import(srcUrl('core/deploy/apps.js'));
  const deployKey = await import(srcUrl('core/deploy/deployKey.js'));

  const id = 'shell-output-many-branches';
  const branch = 'wanted-first';
  const created = apps.createApp({
    id,
    repoUrl: 'git@github.com:acme/many-branches.git',
    branch,
    authType: 'deployKey',
  });
  if (!created.ok) throw new Error(created.errors.join(', '));
  const generated = deployKey.generateDeployKey(id);
  if (!generated) throw new Error(`could not generate a deploy key for ${id}`);

  const branches = 2000;
  const sha = 'abcdef0123456789abcdef0123456789abcdef01';
  const wantedLine = `${sha}\trefs/heads/${branch}`;
  const otherLine = `${sha}\trefs/heads/other-0000`;
  const expectedBytes = wantedLine.length + ((branches - 1) * otherLine.length) + 1;
  const source = `
    const sha = ${JSON.stringify(sha)};
    const lines = [sha + '\\trefs/heads/' + ${JSON.stringify(branch)}];
    for (let i = 0; i < ${branches} - 1; i += 1) {
      lines.push(sha + '\\trefs/heads/other-' + String(i).padStart(4, '0'));
    }
    process.stdout.write(lines.join('\\n') + '\\n');
  `;

  const gitCalls = [];
  // Every git call goes to our script. The options deployKey passes are
  // forwarded unchanged, so a missing `output: 'full'` would show up as a lost
  // first branch — exactly the bug this covers.
  const stubRun = async (cmd, options) => {
    if (!/^git ls-remote --heads "/.test(cmd)) {
      return {
        success: false, stdout: '', stderr: `unexpected command: ${cmd}`,
        exitCode: 1, command: cmd, truncated: { stdout: 0, stderr: 0 },
      };
    }
    gitCalls.push({ cmd, options });
    return shell.runFile(process.execPath, ['-e', source], options);
  };

  const tested = await deployKey.testDeployKey(id, { run: stubRun });

  check('the git stub is what ran', gitCalls.length === 1);
  check('the connection test asks for the full output',
    gitCalls[0]?.options?.output === 'full', JSON.stringify(gitCalls[0]?.options));
  check('the generated branch list is larger than the tail',
    expectedBytes > shell.SHELL_CAPTURE_TAIL_BYTES,
    `${expectedBytes} > ${shell.SHELL_CAPTURE_TAIL_BYTES}`);
  check('the FIRST branch is found even though the list exceeds 64 KiB',
    tested.ok === true && tested.branchFound === true,
    tested.ok ? `branchFound=${tested.branchFound}` : tested.error);
  check('the result still names the branch',
    /wanted-first/.test(tested.detail ?? '') && tested.fingerprint === generated.fingerprint,
    tested.detail ?? '');
}

async function main() {
  const shell = await import(srcUrl('core/shell.js'));

  await testTailMode(shell);
  await testFullMode(shell);
  await testStreamMode(shell);
  await testRunWithStdin(shell);
  await testRunnerList();
  await testDeployKeyBranches();

  const failed = results.filter((result) => !result.passed);
  process.stdout.write(`\n${'-'.repeat(64)}\n`);
  process.stdout.write(`TOTAL ${results.length}   PASS ${results.length - failed.length}   FAIL ${failed.length}\n`);
  if (failed.length > 0) {
    process.stdout.write('\nFailures:\n');
    for (const result of failed) {
      process.stdout.write(`  [${result.group}] ${result.label}${result.detail ? ` (${result.detail})` : ''}\n`);
    }
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`\nSuite error: ${err.stack || err}\n`);
  process.exit(1);
});
