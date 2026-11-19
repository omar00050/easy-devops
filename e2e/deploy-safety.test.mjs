/**
 * Tests for deployment safety: the `migrate` step and boot-crash rollback.
 *
 * Run with:  npm run test:e2e -- deploy-safety
 *
 * Plain Node, no framework — the constitution forbids adding one here.
 *
 * Everything is stubbed on purpose: git is a map of files written into the
 * release directory the engine names, the install/build/migrate commands are
 * recorded rather than executed, and the PM2 stand-in reports the status and
 * restart count the scenario asks for. The assertions check that the STUB is
 * what ran (git calls, command order, PM2 calls), so no real repository, PM2
 * daemon, process or port is touched. The clock is fake too, so a 60-second
 * health window costs nothing.
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

/**
 * Git, replaced by "create the release directory from these files".
 * `git rev-parse HEAD` answers with the commit the scenario names.
 */
function makeGitStub() {
  const calls = [];
  let files = {};
  let sha = 'a'.repeat(40);

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

/** The user's commands: recorded, and able to fail with output on demand. */
function makeCommandStub() {
  const calls = [];
  const failures = new Map();

  const runCommandLine = async (command, opts = {}) => {
    calls.push({ command, cwd: opts.cwd, env: opts.env });

    const failure = failures.get(command);
    if (failure) {
      opts.onData?.(`${failure.output}\n`);
      return { success: false, stdout: '', stderr: '', exitCode: failure.exitCode ?? 1 };
    }

    opts.onData?.(`ran: ${command}\n`);
    return { success: true, stdout: '', stderr: '', exitCode: 0 };
  };

  return {
    calls,
    runCommandLine,
    fail(command, output, exitCode = 1) { failures.set(command, { output, exitCode }); },
    clearFailures() { failures.clear(); },
  };
}

/**
 * PM2, replaced by a state machine.
 *
 * The release directory is the truth: a `CRASH` file makes `list` report a
 * rising restart count (and eventually `errored`), an `UNHEALTHY` file makes
 * the HTTP probe fail while PM2 still says `online`. That is exactly the
 * difference between a boot crash and a plain health-check failure.
 */
function makePm2Stub() {
  const calls = [];
  let current = null;
  let crashReads = 0;
  let logLines = [];

  const isCrashing = () => Boolean(current && fs.existsSync(path.join(current.dir, 'CRASH')));

  const list = async () => {
    calls.push({ type: 'list' });
    if (!current) return { ok: true, apps: [], error: null };

    if (isCrashing()) {
      crashReads += 1;
      const restarts = crashReads <= 1 ? 0 : (crashReads - 1) * 2;
      const status = crashReads >= 4 ? 'errored' : 'online';
      return { ok: true, error: null, apps: [{ name: current.name, status, restarts }] };
    }

    return { ok: true, error: null, apps: [{ name: current.name, status: 'online', restarts: 0 }] };
  };

  return {
    calls,
    installed: true,
    isDaemonRunning: () => true,
    get currentDir() { return current?.dir ?? null; },
    get currentName() { return current?.name ?? null; },
    setLogLines(lines) { logLines = lines; },

    async detect() {
      return { installed: this.installed, version: null, path: this.installed ? 'pm2' : null, error: null };
    },

    async del(name) {
      calls.push({ type: 'delete', name });
      if (current?.name === name) current = null;
      return { ok: true, output: '' };
    },

    async startConfig(file) {
      const config = JSON.parse(fs.readFileSync(file, 'utf8')).apps[0];
      calls.push({ type: 'start', file, dir: config.cwd, name: config.name });
      current = { name: config.name, dir: config.cwd };
      crashReads = 0;
      return { ok: true, output: '' };
    },

    async list() { return list(); },

    async status(name) {
      const listed = await list();
      return { ok: true, daemonRunning: true, error: null, app: listed.apps.find((a) => a.name === name) ?? null };
    },

    async logs(name) {
      calls.push({ type: 'logs', name });
      return { ok: true, lines: logLines, output: logLines.join('\n') };
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
  const runner = await import(srcUrl('core/runner.js'));
  const { dbSet } = await import(srcUrl('core/db.js'));

  dbSet('deployApps', []);

  const git = makeGitStub();
  const commands = makeCommandStub();
  const pm2 = makePm2Stub();

  // A clock the health windows advance instead of real time.
  let clock = Date.UTC(2026, 10, 18, 12, 0, 0);

  const deps = {
    run: git.run,
    runCommandLine: commands.runCommandLine,
    runner: pm2,
    probe: async () => {
      const dir = pm2.currentDir;
      if (dir && fs.existsSync(path.join(dir, 'UNHEALTHY'))) {
        return { ok: false, status: null, error: 'ECONNREFUSED' };
      }
      return { ok: true, status: 200, error: null };
    },
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
    install: 'npm install',
    build: 'npm run build',
    migrate: 'npx prisma migrate deploy',
    start: 'node server.js',
    port: 3000,
    health: { path: '/healthz', timeout: 4 },
    ...extra,
  });

  const files = (version, extra = {}) => ({
    'ez.json': ezJson(extra.ez ?? {}),
    'package.json': JSON.stringify({ name: 'demo', scripts: { start: 'node server.js' } }),
    VERSION: version,
    ...(extra.files ?? {}),
  });

  const logOf = (id, runId) => fs.readFileSync(store.logFile(id, runId), 'utf8');

  try {
    // ── 1. The migrate field ────────────────────────────────────────────────    setGroup('1. migrate in ez.json and app settings');
    {
      const parse = (v) => ez.parseEzFile(JSON.stringify({ start: 'x', migrate: v }));

      const asString = parse('npx prisma migrate deploy');
      check('migrate accepts a single command', asString.ok && asString.value.migrate.join() === 'npx prisma migrate deploy');
      check('migrate accepts a list', parse(['a', 'b']).value.migrate.join() === 'a,b');
      check('migrate: false switches the step off', parse(false).ok && parse(false).value.migrate.length === 0);
      check('an empty string is the same as false', parse('').value.migrate.length === 0);
      check('an invalid migrate value is an error',
        !parse(5).ok && !parse({}).ok && !parse('a\nb').ok);

      const resolved = ez.resolveSettings({
        ez: { start: 'x', migrate: ['ez-a'] },
        overrides: { migrate: ['override-a', 'override-b'] },
      });
      check('an app setting overrides ez.json, same as install/build',
        resolved.settings.migrate.join() === 'override-a,override-b' && resolved.sources.migrate === 'override');

      const fromFile = ez.resolveSettings({ ez: { start: 'x', migrate: ['from-file'] } });
      check('ez.json is used when the app does not override it',
        fromFile.settings.migrate.join() === 'from-file' && fromFile.sources.migrate === 'ez.json');

      check('with no migrate anywhere the step is empty, not inherited from package.json',
        ez.resolveSettings({ pkg: { scripts: { start: 'x' } } }).settings.migrate.length === 0
        && ez.resolveSettings({ pkg: { scripts: { start: 'x' } } }).sources.migrate === 'default');

      check('the settings form validates migrate like ez.json',
        ez.normalizeOverrides({ migrate: 'x' }).value.migrate.join() === 'x'
        && !ez.normalizeOverrides({ migrate: 5 }).ok);

      const created = apps.createApp({
        id: 'migrate-set',
        repoUrl: 'https://github.com/me/migrate-set.git',
        settings: { migrate: ['npx prisma migrate deploy'] },
      });
      check('the app registry accepts migrate in settings', created.ok
        && created.app.settings.migrate.join() === 'npx prisma migrate deploy', created.errors?.join('; ') ?? '');
      check('the app registry rejects an invalid migrate setting',
        !apps.createApp({
          id: 'migrate-bad',
          repoUrl: 'https://github.com/me/migrate-bad.git',
          settings: { migrate: 5 },
        }).ok);
    }

    // ── 2. Order: install → build → migrate → start ─────────────────────────
    setGroup('2. migrate runs after build and before start');
    {
      register('ordered');
      git.setFiles(files('v1', {
        ez: { migrate: ['npx prisma generate', 'npx prisma migrate deploy'] },
      }));

      const run = await deploy('ordered');
      check('the deployment succeeds with a migrate step', run.status === 'success', run.error ?? '');

      const order = commands.calls.map((c) => c.command);
      const iInstall = order.indexOf('npm install');
      const iBuild = order.indexOf('npm run build');
      const iGenerate = order.indexOf('npx prisma generate');
      const iMigrate = order.indexOf('npx prisma migrate deploy');
      const starts = pm2.calls.filter((c) => c.type === 'start');

      check('install, build and migrate ran in that order',
        iInstall !== -1 && iBuild > iInstall && iGenerate > iBuild && iMigrate > iGenerate,
        order.join(' → '));
      check('the stub is what ran: git was asked for the version and PM2 was asked to start',
        git.calls.includes('git --version') && starts.length === 1);
      check('the release was started exactly once', starts.length === 1, `${starts.length} start(s)`);

      const buildCall = commands.calls.find((c) => c.command === 'npm run build');
      const migrateCall = commands.calls.find((c) => c.command === 'npx prisma migrate deploy');
      const releaseDir = store.releaseDir('ordered', run.releaseId);
      check('migrate runs in the new release directory', migrateCall?.cwd === releaseDir);
      check('migrate gets exactly the build environment',
        JSON.stringify(migrateCall?.env) === JSON.stringify(buildCall?.env)
        && migrateCall?.env?.GREETING === undefined
        && migrateCall?.env?.EZ_RELEASE === run.releaseId);

      const log = logOf('ordered', run.id);
      const iBuildLog = log.indexOf('── Build');
      const iMigrateLog = log.indexOf('── Migrate');
      const iStartLog = log.indexOf('── Starting the new release');
      check('the run log streams migrate as its own step, in order',
        iBuildLog !== -1 && iMigrateLog > iBuildLog && iStartLog > iMigrateLog);
      check('the log shows migrate came from ez.json',
        /migrate\s+npx prisma generate && npx prisma migrate deploy\s+\[ez\.json\]/.test(log));
    }

    // ── 3. A failing migration aborts before the switch ─────────────────────
    setGroup('3. A failed migration leaves the previous release running');
    {
      register('migrate-fails');
      git.setFiles(files('v1'));

      const first = await deploy('migrate-fails');
      check('the first release is live before the failing migration', first.status === 'success', first.error ?? '');
      const firstStartCount = pm2.calls.filter((c) => c.type === 'start').length;

      git.setFiles(files('v2'));
      commands.fail('npx prisma migrate deploy', 'Error: P3009\nmigrate found failed migrations in the target database\n');

      const failed = await deploy('migrate-fails');
      check('a non-zero migrate exit fails the run at the migrate step',
        failed.status === 'failed' && failed.step === 'migrate', `${failed.status} ${failed.step}`);
      check('the error names the command and its last output lines',
        /Migrate failed/.test(failed.error) && /exit code 1/.test(failed.error) && /P3009/.test(failed.error),
        failed.error ?? '');
      check('the error explains that migrations are forward-only',
        /forward-only/i.test(failed.error) && /cannot undo a migration/i.test(failed.error));

      check('nothing new was started', pm2.calls.filter((c) => c.type === 'start').length === firstStartCount);
      check('the previous release is still the live one', store.readState('migrate-fails').current === first.releaseId);
      check('the half-built release was removed', !fs.existsSync(store.releaseDir('migrate-fails', failed.releaseId)));

      const log = logOf('migrate-fails', failed.id);
      check('the run log has the migrate heading and the hint', /── Migrate/.test(log) && /hint:.*forward-only/i.test(log));
      check('the previous release was not touched, and the log says so', /The running release was not touched/.test(log));
      commands.clearFailures();
    }

    // ── 4. Boot crash: restart loop, rollback, redacted log tail ────────────
    setGroup('4. A release that keeps restarting is rolled back');
    {
      const env = {
        DATABASE_URL: 'postgresql://hub:s3cr3t-password@db:5432/hub',
        API_TOKEN: 'tok_live_ABC123456',
      };
      register('crasher', { env });

      git.setFiles(files('v1'));
      const first = await deploy('crasher');
      check('the first release is healthy before the crash', first.status === 'success', first.error ?? '');

      git.setFiles(files('v2', { files: { CRASH: '1' } }));
      pm2.setLogLines([
        'PrismaClientInitializationError: column "deletedAt" does not exist in the current database',
        `DATABASE_URL=${env.DATABASE_URL}`,
        `API_TOKEN=${env.API_TOKEN}`,
      ]);

      const crashed = await deploy('crasher');
      const state = store.readState('crasher');
      const log = logOf('crasher', crashed.id);

      check('a restart loop is a failed run at the health step',
        crashed.status === 'failed' && crashed.step === 'health', `${crashed.status} ${crashed.step}`);
      check('the reason names the restart count',
        /^crashed at boot: restarting \d+ times$/.test(crashed.reason ?? ''), crashed.reason ?? '');
      check('the run records that the rollback succeeded', crashed.rollbackSucceeded === true);
      check('the previous release is current again and actually started',
        state.current === first.releaseId && crashed.rolledBackTo === first.releaseId
        && pm2.currentDir === store.releaseDir('crasher', first.releaseId));

      check('the last PM2 log lines are in the run record',
        Array.isArray(crashed.logTail) && crashed.logTail.length > 0 && crashed.logTail.length <= 40
        && crashed.logTail.some((l) => /deletedAt/.test(l)), `${crashed.logTail?.length ?? 0} line(s)`);
      const tailText = (crashed.logTail ?? []).join('\n');
      check('secret environment values are redacted with ***',
        !tailText.includes(env.DATABASE_URL) && !tailText.includes(env.API_TOKEN)
        && tailText.includes('***') && tailText.includes('DATABASE_URL=***') && tailText.includes('API_TOKEN=***'));
      check('neither the run log nor the record contains a secret value',
        !log.includes(env.DATABASE_URL) && !log.includes(env.API_TOKEN)
        && !JSON.stringify(crashed).includes(env.API_TOKEN));
      check('the redacted log tail is written to the run log as its own section',
        /PM2 log \(last \d+ lines, secrets redacted\)/.test(log) && /deletedAt/.test(log));

      const logsAt = pm2.calls.findIndex((c) => c.type === 'logs');
      const rollbackStartAt = pm2.calls.map((c) => c.type).lastIndexOf('start');
      check('the PM2 log was read before the rollback reused the app name',
        logsAt !== -1 && rollbackStartAt !== -1 && logsAt < rollbackStartAt);

      const statusModule = await import(srcUrl('core/deploy/status.js'));
      const described = statusModule.describeApp(apps.getApp('crasher'), new Map());
      check('the app status shape carries the boot-crash report on lastRun',
        described.lastRun?.reason === crashed.reason
        && Array.isArray(described.lastRun?.logTail) && described.lastRun.logTail.length > 0
        && described.lastRun?.rollbackSucceeded === true);

      const { token } = apps.rotateHookToken('crasher');
      const hubDeploy = await import(srcUrl('core/deploy/hubCommands.js'));
      const hubStatus = await hubDeploy.handleHubDeployHook({
        action: 'status', appId: 'crasher', token, runId: crashed.id,
      });
      check('the Hub run-status result carries reason, redacted log tail and rollback result',
        hubStatus.found === true && hubStatus.run.reason === crashed.reason
        && hubStatus.run.rollbackSucceeded === true
        && Array.isArray(hubStatus.run.logTail) && hubStatus.run.logTail.length > 0
        && !JSON.stringify(hubStatus).includes(env.API_TOKEN));
    }

    // ── 5. First release crashing: nothing to return to ─────────────────────
    setGroup('5. A first release that crashes is stopped');
    {
      register('first-crash');
      git.setFiles(files('v1', { files: { CRASH: '1' } }));
      pm2.setLogLines(['Error: cannot find module ./dist/index.js']);

      const crashed = await deploy('first-crash');
      const log = logOf('first-crash', crashed.id);

      check('the first release crash is a failed run with a reason',
        crashed.status === 'failed' && crashed.step === 'health'
        && /^crashed at boot:/.test(crashed.reason ?? ''), crashed.reason ?? '');
      check('there is no release to roll back to, so the run says rollback was not attempted',
        crashed.rollbackSucceeded === null && store.readState('first-crash').current === null);
      check('the broken process was stopped and is no longer PM2\'s',
        pm2.calls.some((c) => c.type === 'delete' && c.name === 'ez-first-crash') && pm2.currentName === null);
      check('the log says there was nothing to return to', /no earlier release to roll back to/i.test(log));
    }

    // ── 6. A plain health-check failure still rolls back ────────────────────
    setGroup('6. The health-check failure path still works');
    {
      register('sick');
      git.setFiles(files('v1'));
      const first = await deploy('sick');
      check('the healthy first release is live', first.status === 'success', first.error ?? '');

      git.setFiles(files('v2', {
        ez: { health: { path: '/healthz', timeout: 3 } },
        files: { UNHEALTHY: '1' },
      }));
      pm2.setLogLines([]);

      const sick = await deploy('sick');
      check('a health timeout with the process still online is rolled back',
        sick.status === 'rolled_back' && sick.step === 'health', `${sick.status} ${sick.step}`);
      check('the reason says the health check failed', /^health check failed:/.test(sick.reason ?? ''), sick.reason ?? '');
      check('the previous release is healthy again and recorded as restored',
        sick.rollbackSucceeded === true && store.readState('sick').current === first.releaseId
        && pm2.currentDir === store.releaseDir('sick', first.releaseId));
      check('no crash log is attached to a plain health failure', Array.isArray(sick.logTail) && sick.logTail.length === 0);
    }

    // ── 7. The runner status helper never starts a daemon ───────────────────
    setGroup('7. core/runner.js status reads');
    {
      const calls = [];
      const off = await runner.status('ez-x', {
        isRunning: () => false,
        run: async (command) => { calls.push(command); return ok(''); },
      });
      check('when PM2 is not running, status runs nothing and says so',
        off.ok === false && off.app === null && off.daemonRunning === false && calls.length === 0);

      const jlist = JSON.stringify([{
        name: 'ez-x',
        pm_id: 0,
        pid: 4321,
        pm2_env: { status: 'online', restart_time: 3, pm_uptime: Date.now() },
        monit: { cpu: 1, memory: 4096 },
      }]);
      const on = await runner.status('ez-x', {
        isRunning: () => true,
        run: async (command) => { calls.push(command); return ok(jlist); },
      });
      check('when it is running, status reports the app and its restart count',
        on.ok === true && on.app?.name === 'ez-x' && on.app.status === 'online' && on.app.restarts === 3);
      check('the status read is a plain `pm2 jlist`', calls.some((c) => /jlist/.test(c)));

      check('redaction replaces every env value, longest first',
        engine.redactSecrets('a=s3cret b=s3cret-long', { A: 's3cret', B: 's3cret-long' }) === 'a=*** b=***');
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
