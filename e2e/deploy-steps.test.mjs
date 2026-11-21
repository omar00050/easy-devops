/**
 * Tests for the ordered `steps` list and the `runtime` field: validation,
 * backward compatibility with install/build/migrate, precedence, order
 * warnings, disabled and failing steps, and the Hub pass-through.
 *
 * Run with:  npm run test:e2e -- deploy-steps
 *
 * Plain Node, no framework — the constitution forbids adding one here.
 *
 * Everything external is stubbed on purpose: git writes the files the scenario
 * names into the release directory, the user's commands are recorded rather
 * than executed, and PM2 is a state machine. The assertions check that the
 * STUB is what ran, so no repository, port, process or PM2 daemon is touched.
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

function makePm2Stub() {
  const calls = [];
  let current = null;

  return {
    calls,
    installed: true,
    isDaemonRunning: () => true,
    get currentDir() { return current?.dir ?? null; },

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
      return { ok: true, output: '' };
    },

    async list() {
      if (!current) return { ok: true, apps: [], error: null };
      return { ok: true, error: null, apps: [{ name: current.name, status: 'online', restarts: 0 }] };
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
  const stages = await import(srcUrl('core/deploy/stages.js'));
  const hub = await import(srcUrl('core/deploy/hubCommands.js'));
  const { dbSet } = await import(srcUrl('core/db.js'));

  dbSet('deployApps', []);

  const git = makeGitStub();
  const commands = makeCommandStub();
  const pm2 = makePm2Stub();

  let clock = Date.UTC(2026, 10, 19, 9, 0, 0);
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

  const files = (version, extra = {}) => ({
    'ez.json': JSON.stringify({
      start: 'node server.js',
      port: 3000,
      health: { path: '/healthz', timeout: 4 },
      ...(extra.ez ?? {}),
    }),
    'server.js': '// started by the PM2 stub\n',
    VERSION: version,
  });

  const logOf = (id, runId) => fs.readFileSync(store.logFile(id, runId), 'utf8');

  try {
    // ── 1. Old fields are read as the same steps list ───────────────────────
    setGroup('1. The old install/build/migrate fields read as steps');
    {
      const parsed = ez.parseEzFile(JSON.stringify({
        install: 'npm ci',
        build: 'npm run build',
        migrate: 'npx prisma migrate deploy',
        start: 'node server.js',
      }));
      check('an old-style ez.json still parses', parsed.ok, parsed.errors.join('; '));

      const resolved = ez.resolveSettings({ ez: parsed.value });
      check('the old fields become install, build, migrate steps',
        resolved.settings.steps.map((s) => `${s.kind}:${s.run}`).join(' | ')
        === 'install:npm ci | build:npm run build | migrate:npx prisma migrate deploy',
        JSON.stringify(resolved.settings.steps));
      check('old fields still read back under their own names',
        resolved.settings.install.join() === 'npm ci' && resolved.settings.build.join() === 'npm run build'
        && resolved.settings.migrate.join() === 'npx prisma migrate deploy');

      const skipped = ez.parseEzFile(JSON.stringify({ install: false, build: 'make', start: 'node x.js' }));
      check('a skipped old field contributes no step (it is omitted, not disabled)',
        ez.resolveSettings({ ez: skipped.value }).settings.steps.length === 1
        && ez.resolveSettings({ ez: skipped.value }).settings.steps[0].kind === 'build');

      const fromApp = ez.resolveSettings({
        ez: null,
        overrides: { start: 'node x.js', install: ['npm install'], migrate: ['npx prisma migrate deploy'] },
      });
      check('an app saved with the old fields is read as steps too',
        fromApp.ok && fromApp.settings.steps.map((s) => s.kind).join() === 'install,migrate');
    }

    // ── 2. The new fields and their validation ──────────────────────────────
    setGroup('2. steps and runtime validation');
    {
      const list = [
        { run: 'npm ci', kind: 'install' },
        { run: 'node scripts/build.js', kind: 'build', enabled: false },
        { run: 'sed -i s/x/y/ .env', kind: 'custom' },
      ];
      const parsed = ez.parseEzFile(JSON.stringify({ steps: list, runtime: 'node', start: 'node server.js' }));
      check('a new-style ez.json parses', parsed.ok, parsed.errors.join('; '));
      check('enabled defaults to true and is kept when false',
        parsed.value.steps[0].enabled === true && parsed.value.steps[1].enabled === false
        && parsed.value.steps[2].kind === 'custom');
      check('runtime is recorded', parsed.value.runtime === 'node');

      check('the settings form accepts steps and runtime',
        ez.normalizeOverrides({ steps: list, runtime: 'node' }).ok);
      check('an empty list clears steps',
        ez.normalizeOverrides({ steps: [] }).value.steps.length === 0);
      check('more than five steps are refused',
        !ez.normalizeOverrides({ steps: Array.from({ length: 6 }, (_, i) => ({ run: `x${i}`, kind: 'custom' })) }).ok
        && !ez.parseEzFile(JSON.stringify({ start: 'x', steps: Array.from({ length: 6 }, (_, i) => ({ run: `x${i}`, kind: 'custom' })) })).ok);
      check('an unknown kind is refused',
        !ez.normalizeOverrides({ steps: [{ run: 'x', kind: 'test' }] }).ok);
      check('a step without a non-empty single command is refused',
        !ez.normalizeOverrides({ steps: [{ run: '', kind: 'build' }] }).ok
        && !ez.normalizeOverrides({ steps: [{ run: ['a', 'b'], kind: 'build' }] }).ok
        && !ez.normalizeOverrides({ steps: [{ run: 'a\nb', kind: 'build' }] }).ok);
      check('an unknown runtime is refused and says what is allowed',
        !ez.normalizeOverrides({ runtime: 'python' }).ok
        && /node/.test(ez.normalizeOverrides({ runtime: 'python' }).errors.join(' ')));
      check('cluster is refused for a non-node runtime, with what to do',
        !ez.normalizeOverrides({ runtime: 'python', execMode: 'cluster' }).ok
        && /cluster/i.test(ez.normalizeOverrides({ runtime: 'python', execMode: 'cluster' }).errors.join(' '))
        && /node/.test(ez.normalizeOverrides({ runtime: 'python', execMode: 'cluster' }).errors.join(' ')));
      check('node with cluster is still accepted',
        ez.normalizeOverrides({ runtime: 'node', execMode: 'cluster', start: 'node server.js' }).ok);

      const both = ez.parseEzFile(JSON.stringify({
        steps: [{ run: 'npm ci', kind: 'install' }], install: 'old install', start: 'node x.js',
      }));
      check('steps wins over the old fields and warns that they were ignored',
        both.ok && both.value.install === undefined && both.warnings.some((w) => /steps.*ignored/i.test(w)),
        both.warnings.join(' | '));

      const bothApp = ez.normalizeOverrides({
        steps: [{ run: 'npm ci', kind: 'install' }], install: 'old install',
      });
      check('the form behaves the same way',
        bothApp.ok && bothApp.value.install === undefined && bothApp.warnings.some((w) => /ignored/i.test(w)));

      const withSteps = apps.createApp({
        id: 'saved-steps',
        repoUrl: 'https://github.com/me/saved-steps.git',
        settings: { install: ['npm install'], steps: [{ run: 'npm ci', kind: 'install' }], runtime: 'node' },
      });
      check('saving through the registry stores steps and drops the old fields',
        withSteps.ok && withSteps.app.settings.steps[0].run === 'npm ci'
        && withSteps.app.settings.install === undefined
        && withSteps.warnings.some((w) => /ignored/i.test(w)), withSteps.errors?.join('; ') ?? '');
    }

    // ── 3. Precedence: override → ez.json → defaults, as one field ──────────
    setGroup('3. Precedence for steps and runtime');
    {
      const ezSteps = [{ run: 'from-ez', kind: 'install' }];
      const overrideSteps = [{ run: 'from-app', kind: 'install' }];

      const overridden = ez.resolveSettings({
        ez: { start: 'x', steps: ezSteps },
        overrides: { steps: overrideSteps },
      });
      check('an app setting replaces the whole list from ez.json',
        overridden.settings.steps.map((s) => s.run).join() === 'from-app' && overridden.sources.steps === 'override');

      const fromFile = ez.resolveSettings({ ez: { start: 'x', steps: ezSteps } });
      check('ez.json is used when the app says nothing',
        fromFile.settings.steps.map((s) => s.run).join() === 'from-ez' && fromFile.sources.steps === 'ez.json');

      const cleared = ez.resolveSettings({ ez: { start: 'x', steps: ezSteps }, overrides: { steps: [] } });
      check('an empty app list clears the list from ez.json',
        cleared.settings.steps.length === 0 && cleared.sources.steps === 'override');

      const noDefaultInstall = ez.resolveSettings({
        ez: { start: 'x', steps: [{ run: 'only-this', kind: 'custom' }] },
        pkg: { scripts: { start: 'x', build: 'tsc' } },
        files: { packageLock: true },
      });
      check('package.json defaults do not sneak an install step into an explicit list',
        noDefaultInstall.settings.steps.map((s) => s.run).join() === 'only-this');

      // An older app stores the old fields. They are a higher layer than
      // ez.json, so they must still win over ez.json's steps.
      const oldAppWins = ez.resolveSettings({
        ez: { start: 'x', steps: [{ run: 'ez-install', kind: 'install' }] },
        overrides: { build: ['from-old-app'] },
        pkg: { scripts: { start: 'x', build: 'tsc' } },
        files: { packageLock: true },
      });
      check('old app fields above a steps list win instead of being ignored',
        oldAppWins.ok && oldAppWins.settings.steps.map((s) => `${s.kind}:${s.run}`).join() === 'build:from-old-app'
        && oldAppWins.sources.steps === 'override', JSON.stringify(oldAppWins.settings.steps));
      check('and the warning names both sources',
        oldAppWins.warnings.some((w) => /app's.*install\/build\/migrate.*steps.*ez\.json/i.test(w)),
        oldAppWins.warnings.join(' | '));

      const oldAppFieldsMerged = ez.resolveSettings({
        ez: { start: 'x', steps: [{ run: 'ez-install', kind: 'install' }] },
        overrides: { install: ['app-install'], migrate: ['app-migrate'] },
        pkg: { scripts: { start: 'x', build: 'tsc' } },
        files: { packageLock: true },
      });
      check('the higher layer’s fields are merged per field, with no lower defaults',
        oldAppFieldsMerged.settings.steps.map((s) => `${s.kind}:${s.run}`).join(' | ') === 'install:app-install | migrate:app-migrate',
        JSON.stringify(oldAppFieldsMerged.settings.steps));

      const oldAppSkipped = ez.resolveSettings({
        ez: { start: 'x', steps: [{ run: 'ez-install', kind: 'install' }] },
        overrides: { install: false },
      });
      check('an app skip is an explicit empty list, not a fallback to ez.json',
        oldAppSkipped.ok && oldAppSkipped.settings.steps.length === 0
        && oldAppSkipped.warnings.some((w) => /override the "steps"/.test(w)));

      const runtimeFile = ez.resolveSettings({ ez: { start: 'x', runtime: 'node' } });
      const runtimeOverride = ez.resolveSettings({ ez: { start: 'x' }, overrides: { runtime: 'node' } });
      check('runtime follows the same precedence and defaults to node',
        runtimeFile.settings.runtime === 'node' && runtimeFile.sources.runtime === 'ez.json'
        && runtimeOverride.sources.runtime === 'override'
        && ez.resolveSettings({ ez: { start: 'x' } }).sources.runtime === 'default');
    }

    // ── 4. Order warnings ───────────────────────────────────────────────────
    setGroup('4. Order warnings, never errors');
    {
      const warnFor = (steps) => ez.normalizeOverrides({ steps });
      const migrateFirst = warnFor([{ run: 'migrate', kind: 'migrate' }, { run: 'install', kind: 'install' }]);
      const buildFirst = warnFor([{ run: 'build', kind: 'build' }, { run: 'install', kind: 'install' }]);
      const migrateBeforeBuild = warnFor([{ run: 'migrate', kind: 'migrate' }, { run: 'build', kind: 'build' }]);

      check('migrate before install is a warning with what to do',
        migrateFirst.ok && migrateFirst.warnings.some((w) => /migrate.*before.*install.*Put "install"/i.test(w)),
        migrateFirst.warnings.join(' | '));
      check('build before install is a warning', buildFirst.ok && buildFirst.warnings.some((w) => /build.*before.*install/i.test(w)));
      check('migrate before build is a warning', migrateBeforeBuild.ok && migrateBeforeBuild.warnings.some((w) => /migrate.*before.*build/i.test(w)));

      const disabled = warnFor([
        { run: 'migrate', kind: 'migrate', enabled: false },
        { run: 'install', kind: 'install' },
      ]);
      check('a disabled step does not count for order warnings', disabled.ok && disabled.warnings.length === 0);

      const appWarnings = apps.createApp({
        id: 'order-warn',
        repoUrl: 'https://github.com/me/order-warn.git',
        settings: { steps: [{ run: 'migrate', kind: 'migrate' }, { run: 'install', kind: 'install' }] },
      });
      check('the warning reaches the app response', appWarnings.ok && appWarnings.warnings.length > 0,
        appWarnings.warnings?.join(' | ') ?? '');
      check('and the app listing carries it too',
        apps.dashboardApp(apps.getApp('order-warn')).warnings.some((w) => /before "install"/.test(w)));
    }

    // ── 5. A real run: disabled steps, custom steps, and a failure ──────────
    setGroup('5. The engine runs the list in order');
    {
      register('steps-app');
      git.setFiles(files('v1', {
        ez: {
          steps: [
            { run: 'npm install', kind: 'install' },
            { run: 'npm run build', kind: 'build', enabled: false },
            { run: 'echo custom', kind: 'custom' },
          ],
        },
      }));

      const first = await deploy('steps-app');
      check('a deployment with steps succeeds', first.status === 'success', first.error ?? '');
      check('enabled steps ran in list order and the disabled one did not',
        commands.calls.map((c) => c.command).join() === 'npm install,echo custom',
        commands.calls.map((c) => c.command).join(' → '));

      const log = logOf('steps-app', first.id);
      check('the log says the disabled step was skipped',
        /Skipping step 2 \(build\): disabled/.test(log));
      check('a custom step has its own heading', /── Step 3/.test(log));

      const firstStartCount = pm2.calls.filter((c) => c.type === 'start').length;
      git.setFiles(files('v2', {
        ez: {
          steps: [
            { run: 'npm install', kind: 'install' },
            { run: 'explode', kind: 'custom' },
          ],
        },
      }));
      commands.fail('explode', 'deliberate failure');

      const failed = await deploy('steps-app');
      check('a failing step aborts at that step, named "step N" for a custom one',
        failed.status === 'failed' && failed.step === 'step 2', `${failed.status} ${failed.step}`);
      check('the error names the command and says why', /Step 2 failed/.test(failed.error) && /"explode"/.test(failed.error) && /exit code 1/.test(failed.error), failed.error ?? '');
      check('nothing new was started', pm2.calls.filter((c) => c.type === 'start').length === firstStartCount);
      check('the running release is untouched', store.readState('steps-app').current === first.releaseId);
      check('the half-built release was removed', !fs.existsSync(store.releaseDir('steps-app', failed.releaseId)));
      check('the log says the running release was not touched', /The running release was not touched/.test(logOf('steps-app', failed.id)));
      commands.clearFailures();
    }

    // ── 6. Saving steps removes the old stored fields ────────────────────────
    setGroup('6. Saving with steps removes the stored old fields');
    {
      const oldFields = apps.createApp({
        id: 'old-settings',
        repoUrl: 'https://github.com/me/old-settings.git',
        settings: { install: false, build: 'old build', migrate: ['old migrate'] },
      });
      check('an app can still be saved with the old fields',
        oldFields.ok && oldFields.app.settings.install.length === 0
        && oldFields.app.settings.build[0] === 'old build', oldFields.errors?.join('; ') ?? '');

      const saved = apps.updateApp('old-settings', {
        settings: {
          steps: [{ run: 'npm ci', kind: 'install' }],
          // A form that still posts the old fields with steps: steps must win
          // and none of these may be left in the stored app.
          install: 'old install',
          build: false,
          migrate: ['old migrate'],
        },
      });
      check('saving settings with steps accepts the update', saved.ok, saved.errors?.join('; ') ?? '');
      const stored = apps.getApp('old-settings').settings;
      check('the stored app has steps', Array.isArray(stored.steps) && stored.steps[0].run === 'npm ci');
      check('and none of install, build or migrate — including a skip — is left behind',
        !('install' in stored) && !('build' in stored) && !('migrate' in stored), Object.keys(stored).join());
      check('the warning says the old fields were ignored',
        saved.warnings.some((w) => /ignored/i.test(w)), saved.warnings.join(' | '));
    }

    // ── 7. The Hub passes the fields through unchanged ──────────────────────
    setGroup('7. Hub createApp and updateApp carry steps and runtime');
    {
      const created = await hub.handleHubDeployCommand({
        action: 'create',
        app: {
          id: 'hub-steps',
          repoUrl: 'https://github.com/me/hub-steps.git',
          settings: { runtime: 'node', steps: [{ run: 'npm ci', kind: 'install' }] },
        },
      });
      check('Hub createApp returns the steps unchanged',
        created.settings.runtime === 'node' && created.settings.steps[0].run === 'npm ci'
        && created.settings.steps[0].kind === 'install');

      const updated = await hub.handleHubDeployCommand({
        action: 'update',
        id: 'hub-steps',
        app: { settings: { runtime: 'node', steps: [{ run: 'npm run build', kind: 'build', enabled: false }] } },
      });
      check('Hub updateApp returns the new list unchanged',
        updated.settings.steps.length === 1 && updated.settings.steps[0].enabled === false
        && updated.settings.steps[0].kind === 'build');
      check('the stored app is the same one the dashboard would see',
        apps.dashboardApp(apps.getApp('hub-steps')).settings.steps[0].run === 'npm run build');
      check('the app listing view carries the same fields',
        apps.publicApp(apps.getApp('hub-steps')).settings.runtime === 'node'
        && apps.publicApp(apps.getApp('hub-steps')).settings.steps[0].kind === 'build');

      await hub.handleHubDeployCommand({
        action: 'create',
        app: {
          id: 'hub-old',
          repoUrl: 'https://github.com/me/hub-old.git',
          settings: { build: 'old build' },
        },
      });
      const hubSaved = await hub.handleHubDeployCommand({
        action: 'update',
        id: 'hub-old',
        app: { settings: { steps: [{ run: 'npm ci', kind: 'install' }], build: 'old build' } },
      });
      const hubStored = apps.getApp('hub-old').settings;
      check('Hub updateApp with steps removes the old stored fields too',
        hubSaved.settings.steps[0].run === 'npm ci' && !('build' in hubStored) && !('install' in hubStored),
        Object.keys(hubStored).join());
    }
    // ── 8. The canonical stage bar ──────────────────────────────────────────
    setGroup('8. The canonical stage bar');
    {
      check('RUN_STAGES is the ordered bar and is frozen',
        stages.RUN_STAGES.join(',') === 'fetch,settings,pre,install,build,migrate,start,health,post,finish'
        && Object.isFrozen(stages.RUN_STAGES), stages.RUN_STAGES.join(','));

      check('a canonical step is its own stage',
        ['fetch', 'settings', 'pre', 'install', 'build', 'migrate', 'start', 'health', 'post', 'finish']
          .every((id) => stages.stageForStep(id, null) === id));
      check('done maps to done', stages.stageForStep('done', 'finish') === 'done');
      check('a custom step continues an install/build/migrate stage',
        stages.stageForStep('step 2', 'install') === 'install'
        && stages.stageForStep('step 3', 'migrate') === 'migrate');
      check('a custom step with nothing to continue counts as build',
        stages.stageForStep('step 1', 'pre') === 'build'
        && stages.stageForStep('step 2', null) === 'build'
        && stages.stageForStep('step 4', 'start') === 'build');

      const skipped = (settings) => stages.plannedSkippedStages(settings);
      check('with pre and post hooks and install and build steps, only migrate is skipped',
        skipped({
          pre: ['echo pre'],
          post: ['echo post'],
          steps: [{ run: 'npm ci', kind: 'install', enabled: true }, { run: 'npm run build', kind: 'build', enabled: true }],
        }).join(',') === 'migrate');
      check('no pre or post hook and no migrate step gives pre, migrate, post',
        skipped({
          pre: [],
          post: [],
          steps: [{ run: 'a', kind: 'install' }, { run: 'b', kind: 'build' }],
        }).join(',') === 'pre,migrate,post');
      check('a disabled migrate step counts as skipped',
        skipped({
          pre: ['echo pre'],
          post: ['echo post'],
          steps: [
            { run: 'a', kind: 'install' },
            { run: 'b', kind: 'build' },
            { run: 'c', kind: 'migrate', enabled: false },
          ],
        }).join(',') === 'migrate');
      check('a custom step only uses build, so install and migrate are skipped',
        skipped({
          pre: ['echo pre'], post: ['echo post'], steps: [{ run: 'x', kind: 'custom' }],
        }).join(',') === 'install,migrate');
      check('a custom step after an install step keeps install used and build skipped',
        skipped({
          pre: ['echo pre'], post: ['echo post'],
          steps: [{ run: 'a', kind: 'install' }, { run: 'b', kind: 'custom' }],
        }).join(',') === 'build,migrate');
      check('no steps at all skips all three command stages',
        skipped({ pre: [], post: [], steps: [] }).join(',') === 'pre,install,build,migrate,post');
    }

    // ── 9. A run records its stage and skipped stages ───────────────────────
    setGroup('9. A run records its stage and skipped stages');
    {
      register('stage-app');
      git.setFiles(files('v1', {
        ez: {
          hooks: { pre: 'echo pre', post: 'echo post' },
          steps: [
            { run: 'npm ci', kind: 'install' },
            { run: 'npm run build', kind: 'build' },
          ],
        },
      }));

      const first = await deploy('stage-app');
      check('a successful run ends at stage done',
        first.status === 'success' && first.step === 'done' && first.stage === 'done',
        `${first.status} ${first.step} ${first.stage}`);
      check('it records the stages it does not perform',
        JSON.stringify(first.skippedStages) === JSON.stringify(['migrate']), JSON.stringify(first.skippedStages));
      const stored = store.readRun('stage-app', first.id);
      check('the record on disk carries both fields',
        stored?.stage === 'done' && JSON.stringify(stored?.skippedStages) === JSON.stringify(['migrate']),
        JSON.stringify({ stage: stored?.stage, skippedStages: stored?.skippedStages }));

      git.setFiles(files('v2', {
        ez: {
          hooks: { pre: 'echo pre', post: 'echo post' },
          steps: [
            { run: 'npm ci', kind: 'install' },
            { run: 'npm run build', kind: 'build' },
          ],
        },
      }));
      commands.fail('npm run build', 'deliberate build failure');

      const failed = await deploy('stage-app');
      check('a failed build records stage build',
        failed.status === 'failed' && failed.step === 'build' && failed.stage === 'build',
        `${failed.status} ${failed.step} ${failed.stage}`);
      check('the failed run keeps the skipped stages it planned',
        JSON.stringify(failed.skippedStages) === JSON.stringify(['migrate']), JSON.stringify(failed.skippedStages));
      commands.clearFailures();
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
