/**
 * Tests for deploy cluster mode: instances, execMode, PM2 reloads and the
 * per-instance boot-crash check.
 *
 * Run with:  npm run test:e2e -- deploy-cluster
 *
 * Plain Node, no framework. Everything external is stubbed on purpose: git is
 * "write these files into the release directory", commands are recorded, and
 * the PM2 stand-in is a state machine with one entry per worker. The
 * assertions check that the STUB is what ran — the PM2 calls in particular —
 * so no real repository, PM2 daemon, process or port is touched.
 *
 * Writes only inside the temporary data directory the runner provides.
 */

// MUST be the first import: ESM evaluates the static import graph before any
// line of this file runs, so only an import can act before the rest load. It
// refuses to run unless EZ_TEST and a throwaway EASY_DEVOPS_DATA_DIR are set.
// Run the suites with `npm run test:e2e` (see e2e/run.mjs).
import './lib/guard.mjs';
import { TEST_DATA_DIR } from './lib/guard.mjs';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const srcUrl = (rel) => pathToFileURL(path.join(ROOT, 'src', rel)).href;

const results = [];
let group = '';
function setGroup(g) { group = g; process.stdout.write(`\n── ${g}\n`); }
function check(label, passed, detail = '') {
  results.push({ group, label, passed: Boolean(passed), detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}

const ok = (stdout = '') => ({ success: true, stdout, stderr: '', exitCode: 0 });

// ─── The stubs ───────────────────────────────────────────────────────────────

/** Git: create the release directory from the files the scenario provides. */
function makeGitStub() {
  const calls = [];
  let files = {};
  let sha = 'b'.repeat(40);

  const run = async (command) => {
    calls.push(command);
    if (command === 'git --version') return ok('git version 2.43.0');

    const init = /^git init -q "(.+)"$/.exec(command);
    if (init) {
      const dir = init[1];
      fs.mkdirSync(dir, { recursive: true });
      for (const [rel, content] of Object.entries(files)) {
        const file = path.join(dir, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
      }
      return ok('');
    }

    if (/rev-parse HEAD/.test(command)) return ok(`${sha}\n`);
    return ok('');
  };

  return {
    run,
    calls,
    setFiles(next) { files = next; },
    setSha(next) { sha = next; },
  };
}

function makeCommandStub() {
  const calls = [];
  const runCommandLine = async (command, opts = {}) => {
    calls.push({ command, cwd: opts.cwd, env: opts.env });
    opts.onData?.(`ran: ${command}\n`);
    return { success: true, stdout: '', stderr: '', exitCode: 0 };
  };
  return { calls, runCommandLine };
}

/**
 * PM2 as a state machine. Each name has one entry in fork mode, or
 * `instances` entries in cluster mode. A CRASH file in the release makes the
 * first worker restart and eventually error while the others stay online —
 * the exact "one bad worker among several" case.
 */
function makePm2Stub() {
  const calls = [];
  const procs = new Map();

  const workerCount = (p) => (p.execMode === 'cluster'
    ? (p.instances === 'max' ? 2 : Number(p.instances) || 1)
    : 1);

  const entriesFor = (p) => {
    const out = [];
    const count = workerCount(p);
    for (let i = 0; i < count; i++) {
      let status = 'online';
      let restarts = 0;
      if (p.crash) {
        p.crashReads += 1;
        if (i === 0) {
          restarts = p.crashReads <= 1 ? 0 : (p.crashReads - 1) * 2;
          status = p.crashReads >= 3 ? 'errored' : 'online';
        }
      }
      out.push({
        name: p.name,
        pmId: i,
        status,
        restarts,
        execMode: p.execMode,
      });
    }
    return out;
  };

  const setFromConfig = (file) => {
    const config = JSON.parse(fs.readFileSync(file, 'utf8')).apps[0];
    const p = {
      name: config.name,
      dir: config.cwd,
      execMode: config.exec_mode === 'cluster' ? 'cluster' : 'fork',
      instances: config.instances ?? 1,
      crash: fs.existsSync(path.join(config.cwd, 'CRASH')),
      crashReads: 0,
    };
    procs.set(config.name, p);
    return { config, p };
  };

  return {
    calls,
    procs,
    installed: true,
    isDaemonRunning: () => true,

    async detect() {
      return { installed: this.installed, version: null, path: this.installed ? 'pm2' : null, error: null };
    },

    async list() {
      calls.push({ type: 'list' });
      const apps = [];
      for (const p of procs.values()) apps.push(...entriesFor(p));
      return { ok: true, error: null, apps };
    },

    async statusAll(name) {
      calls.push({ type: 'statusAll', name });
      const apps = [];
      for (const p of procs.values()) if (p.name === name) apps.push(...entriesFor(p));
      return { ok: true, daemonRunning: true, error: null, apps };
    },

    async status(name) {
      const all = await this.statusAll(name);
      return { ok: true, daemonRunning: true, error: null, app: all.apps[0] ?? null, apps: all.apps };
    },

    async del(name) {
      calls.push({ type: 'delete', name });
      procs.delete(name);
      return { ok: true, output: '' };
    },

    async startConfig(file) {
      calls.push({ type: 'start', file });
      setFromConfig(file);
      return { ok: true, output: '' };
    },

    async reloadConfig(file) {
      calls.push({ type: 'reload', file });
      setFromConfig(file);
      return { ok: true, output: '' };
    },

    async logs(name) {
      calls.push({ type: 'logs', name });
      return { ok: true, lines: [], output: '' };
    },

    async save() {
      calls.push({ type: 'save' });
      return { ok: true, output: '' };
    },
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const ez = await import(srcUrl('core/deploy/ezfile.js'));
  const apps = await import(srcUrl('core/deploy/apps.js'));
  const store = await import(srcUrl('core/deploy/store.js'));
  const engine = await import(srcUrl('core/deploy/engine.js'));
  const statusModule = await import(srcUrl('core/deploy/status.js'));
  const { dbSet } = await import(srcUrl('core/db.js'));

  dbSet('deployApps', []);

  const git = makeGitStub();
  const commands = makeCommandStub();
  const pm2 = makePm2Stub();

  let clock = Date.UTC(2026, 10, 18, 12, 0, 0);
  const deps = {
    run: git.run,
    runCommandLine: commands.runCommandLine,
    runner: pm2,
    probe: async () => ({ ok: true, status: 200, error: null }),
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    sendNotification: async () => ({ ok: true }),
    syncDomain: async () => null,
  };

  const deploy = async (id) => {
    const started = engine.startDeployment(id, { deps });
    if (!started.ok) return started;
    const run = await started.done;
    clock += 60_000;
    return run;
  };

  const register = (id, overrides = {}) => {
    const created = apps.createApp({
      id,
      repoUrl: `https://github.com/me/${id}.git`,
      branch: 'main',
      env: {},
      settings: {},
      notifyChannelIds: [],
      ...overrides,
    });
    if (!created.ok) throw new Error(`could not register ${id}: ${created.errors.join('; ')}`);
    return created.app;
  };

  const ezJson = (extra = {}) => JSON.stringify({
    install: false,
    build: false,
    start: 'node server.js',
    ...extra,
  });

  const files = (version, extra = {}) => ({
    'ez.json': ezJson(extra.ez ?? {}),
    'package.json': JSON.stringify({ name: 'demo', scripts: { start: 'node server.js' } }),
    VERSION: version,
    ...(extra.files ?? {}),
  });

  const configOf = (id, run) => JSON.parse(
    fs.readFileSync(path.join(store.releaseDir(id, run.releaseId), engine.PM2_CONFIG_FILE), 'utf8'),
  ).apps[0];

  const callsSince = (mark) => pm2.calls.slice(mark);
  const kinds = (calls) => calls.map((c) => c.type);

  try {
    // ── 1. Parsing and validation ────────────────────────────────────────────
    setGroup('1. instances and execMode validation');
    {
      const cpu = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
      const parse = (extra) => ez.parseEzFile(JSON.stringify({ start: 'node server.js', ...extra }));

      check('instances accepts 1', parse({ instances: 1 }).ok && parse({ instances: 1 }).value.instances === 1);
      check('instances accepts "max"', parse({ instances: 'max' }).ok && parse({ instances: 'max' }).value.instances === 'max');
      check('instances accepts a numeric string', parse({ instances: '2' }).ok || cpu < 2,
        `cpu=${cpu}`);
      check('instances 0 is refused and names the CPU count',
        !parse({ instances: 0 }).ok && new RegExp(`1 to ${cpu}`).test(parse({ instances: 0 }).errors.join(' ')),
        parse({ instances: 0 }).errors.join(' '));
      check('instances above the CPU count is refused, naming the count',
        !parse({ instances: cpu + 1 }).ok && parse({ instances: cpu + 1 }).errors.join(' ').includes(String(cpu)),
        parse({ instances: cpu + 1 }).errors.join(' '));
      check('a non-integer instance count is refused',
        !parse({ instances: 1.5 }).ok && /whole number/.test(parse({ instances: 1.5 }).errors.join(' ')),
        parse({ instances: 1.5 }).errors.join(' '));
      check('a non-numeric instance count is refused', !parse({ instances: 'abc' }).ok);

      const forkTwo = parse({ instances: 2, execMode: 'fork' });
      check('fork mode with more than one instance is an error that says to choose cluster',
        !forkTwo.ok && /cluster/.test(forkTwo.errors.join(' ')), forkTwo.errors.join(' '));

      const npmCluster = parse({ execMode: 'cluster', start: 'npm start' });
      check('cluster with "npm start" is refused and names the direct node form',
        !npmCluster.ok && /node <file>/.test(npmCluster.errors.join(' ')), npmCluster.errors.join(' '));

      const nodeCluster = parse({ execMode: 'cluster', start: 'node server.js', instances: 2 });
      check('cluster with a direct node start is accepted', nodeCluster.ok, nodeCluster.errors.join(' '));
      check('cluster settings carry the stateless warning',
        nodeCluster.warnings.includes(ez.CLUSTER_STATELESS_WARNING),
        nodeCluster.warnings.join(' | '));

      check('an app settings form with instances 2 and no cluster mode is refused',
        !ez.normalizeOverrides({ instances: 2 }).ok);
      check('an app settings form with cluster carries the same warning',
        ez.normalizeOverrides({ execMode: 'cluster' }).warnings.includes(ez.CLUSTER_STATELESS_WARNING));
    }

    // ── 2. The PM2 config: fork unchanged, cluster adds both fields ─────────
    setGroup('2. PM2 config contents');
    {
      register('forkcfg');
      register('clustercfg', { settings: { execMode: 'cluster', instances: 3 } });
      register('maxcfg', { settings: { execMode: 'cluster', instances: 'max' } });

      git.setFiles(files('f1'));
      const forkRun = await deploy('forkcfg');
      const forkConfig = configOf('forkcfg', forkRun);
      check('a fork deployment still succeeds', forkRun.status === 'success', forkRun.error ?? '');
      check('fork writes neither exec_mode nor instances — exactly as before',
        forkConfig.exec_mode === undefined && forkConfig.instances === undefined,
        JSON.stringify({ exec_mode: forkConfig.exec_mode, instances: forkConfig.instances }));

      git.setFiles(files('c1'));
      const clusterRun = await deploy('clustercfg');
      const clusterConfig = configOf('clustercfg', clusterRun);
      check('a cluster deployment succeeds', clusterRun.status === 'success', clusterRun.error ?? '');
      check('cluster writes exec_mode "cluster" and the instance count',
        clusterConfig.exec_mode === 'cluster' && clusterConfig.instances === 3,
        JSON.stringify({ exec_mode: clusterConfig.exec_mode, instances: clusterConfig.instances }));

      git.setFiles(files('m1'));
      const maxRun = await deploy('maxcfg');
      const maxConfig = configOf('maxcfg', maxRun);
      check('"max" is passed through to PM2 unchanged',
        maxRun.status === 'success' && maxConfig.instances === 'max', maxRun.error ?? '');
    }

    // ── 3. A second cluster deployment reloads; fork still restarts ─────────
    setGroup('3. reload for a running cluster app');
    {
      const before = pm2.calls.length;
      git.setFiles(files('c2'));
      const second = await deploy('clustercfg');
      const calls = callsSince(before);
      const kindsSeen = kinds(calls);
      check('the second cluster deployment succeeds', second.status === 'success', second.error ?? '');
      check('it reloads instead of delete + start',
        kindsSeen.includes('reload') && !kindsSeen.includes('delete') && !kindsSeen.includes('start'),
        kindsSeen.join(','));
      check('the stub is what ran: a reload of the release config',
        calls.some((c) => c.type === 'reload' && c.file.endsWith(engine.PM2_CONFIG_FILE)),
        JSON.stringify(calls.filter((c) => c.type === 'reload')));

      const forkBefore = pm2.calls.length;
      git.setFiles(files('f2'));
      const forkAgain = await deploy('forkcfg');
      const forkCalls = kinds(callsSince(forkBefore));
      check('a fork app still uses delete + start on every deployment',
        forkAgain.status === 'success' && forkCalls.includes('delete') && forkCalls.includes('start')
        && !forkCalls.includes('reload'), forkCalls.join(','));
    }

    // ── 4. Switching fork → cluster restarts ────────────────────────────────
    setGroup('4. switching modes uses delete + start');
    {
      register('switcher');
      git.setFiles(files('s1'));
      const first = await deploy('switcher');
      check('the app starts in fork mode', first.status === 'success' && configOf('switcher', first).exec_mode === undefined,
        first.error ?? '');

      const before = pm2.calls.length;
      git.setFiles(files('s2', { ez: { execMode: 'cluster', instances: 2 } }));
      const second = await deploy('switcher');
      const calls = kinds(callsSince(before));
      check('fork → cluster is a delete + start, not a reload',
        second.status === 'success' && calls.includes('delete') && calls.includes('start')
        && !calls.includes('reload'), calls.join(','));
      check('the new config is cluster mode',
        configOf('switcher', second).exec_mode === 'cluster' && configOf('switcher', second).instances === 2);
    }

    // ── 5. Rollback of a cluster app reloads ────────────────────────────────
    setGroup('5. rollback follows the same rule');
    {
      const before = pm2.calls.length;
      const started = engine.startRollback('clustercfg', { deps });
      const run = await started.done;
      const calls = kinds(callsSince(before));
      check('the cluster rollback succeeds', run.status === 'success' && run.trigger === 'rollback', run.error ?? '');
      check('it reloads the older release instead of delete + start',
        calls.includes('reload') && !calls.includes('delete') && !calls.includes('start'),
        calls.join(','));
    }

    // ── 6. One crashing worker triggers the boot-crash rollback ─────────────
    setGroup('6. every instance is watched');
    {
      register('crasher', { settings: { execMode: 'cluster', instances: 3 } });
      git.setFiles(files('r1'));
      const first = await deploy('crasher');
      check('the cluster app is healthy before the crash', first.status === 'success', first.error ?? '');

      git.setFiles(files('r2', { files: { CRASH: '1' } }));
      const crashed = await deploy('crasher');
      check('one restarting worker among three is a boot crash at the health step',
        crashed.status === 'failed' && crashed.step === 'health', `${crashed.status} ${crashed.step}`);
      check('the reason names the restart loop',
        /^crashed at boot: restarting \d+ times$/.test(crashed.reason ?? ''), crashed.reason ?? '');
      check('the previous cluster release was rolled back and is live',
        crashed.rollbackSucceeded === true && store.readState('crasher').current === first.releaseId
        && crashed.rolledBackTo === first.releaseId);
    }

    // ── 7. Status carries the configured and online counts ──────────────────
    setGroup('7. status reports cluster fields');
    {
      const processes = await statusModule.pm2Statuses({ runner: pm2 });
      const cluster = statusModule.describeApp(apps.getApp('clustercfg'), processes);
      const fork = statusModule.describeApp(apps.getApp('forkcfg'), processes);

      check('a cluster app reports execMode, configured instances and instances online',
        cluster.execMode === 'cluster' && cluster.instances === 3 && cluster.instancesOnline === 3,
        JSON.stringify({ execMode: cluster.execMode, instances: cluster.instances, instancesOnline: cluster.instancesOnline }));
      check('a fork app from before the fields reports fork / 1 / 1',
        fork.execMode === 'fork' && fork.instances === 1 && fork.instancesOnline === 1,
        JSON.stringify({ execMode: fork.execMode, instances: fork.instances, instancesOnline: fork.instancesOnline }));
      check('the status warning is the stateless text',
        cluster.warnings.includes(ez.CLUSTER_STATELESS_WARNING), cluster.warnings.join(' | '));

      const dashboardWarnings = apps.dashboardApp(apps.getApp('clustercfg')).warnings;
      check('the app view carries the warning for the UI',
        dashboardWarnings.includes(ez.CLUSTER_STATELESS_WARNING), dashboardWarnings.join(' | '));
      check('a fork app has no cluster warning',
        apps.dashboardApp(apps.getApp('forkcfg')).warnings.length === 0);
    }
  } catch (err) {
    check('the suite completed without an unexpected error', false, err?.message ?? String(err));
  }

  // ─── Summary ────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.passed);
  process.stdout.write(`\n${'─'.repeat(62)}\n`);
  process.stdout.write(`TOTAL ${results.length}   PASS ${results.length - failed.length}   FAIL ${failed.length}\n`);
  if (failed.length) {
    process.stdout.write('\nFailures:\n');
    for (const f of failed) process.stdout.write(`  [${f.group}] ${f.label} ${f.detail}\n`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(String(e.stack || e) + '\n');
  process.exit(1);
});
