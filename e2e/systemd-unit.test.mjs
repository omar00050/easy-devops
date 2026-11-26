/**
 * e2e/systemd-unit.test.mjs — the Linux systemd unit, and `ezz service recover`
 * on Linux.
 *
 * Run with:  node e2e/run.mjs systemd-unit
 *
 * ── The failure this suite exists for ──────────────────────────────────────
 *
 * 1.4.4-1.4.6 inserted `Environment=` lines into the unit by searching for the
 * literal text `[Service]`, which appears inside an explanatory comment in
 * `[Unit]`. The result, seen on a real server, was
 *
 *   Environment=WS_NO_BUFFER_UTIL=1: systemd moved them in v229 and still
 *
 * — a line systemd ignores, so the protections were never applied, and every
 * repair that added them again added a duplicate of an entry it could not
 * remove. So this suite does not assert that a substring appears somewhere in
 * the file. It PARSES the file as systemd reads it: every directive in a
 * section, no directive text inside a comment, `Environment=` only in
 * `[Service]`, and no duplicate the parser would treat as a conflict.
 *
 * ── Nothing real is touched ────────────────────────────────────────────────
 *
 * Every `sudo`, `systemctl`, `journalctl` and `systemd-analyze` call is an
 * injected stub that records argv. The unit under test is a file in this run's
 * temporary directory, never `/etc/systemd/system`. The only real subprocess
 * is the optional `systemd-analyze verify`, run against that temporary file,
 * and only when the tool exists on PATH.
 */

import './lib/guard.mjs';
import { TEST_DATA_DIR, assertInsideTestDataDir } from './lib/guard.mjs';

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const srcUrl = (rel) => pathToFileURL(path.join(ROOT, 'src', rel)).href;

const results = [];
let group = '';
function setGroup(name) { group = name; process.stdout.write(`\n── ${name}\n`); }
function check(label, passed, detail = '') {
  results.push({ group, label, passed, detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}
function skip(label, why) {
  results.push({ group, label, passed: true, skipped: true });
  process.stdout.write(`   SKIP  ${label}  — ${why}\n`);
}

function scratch(name) {
  const dir = path.join(TEST_DATA_DIR, 'scratch', name);
  assertInsideTestDataDir(dir, `create the scratch dir ${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── A small INI parser, written the way systemd reads a unit ────────────────

/** Keys systemd accepts more than once in one section. */
const REPEATABLE = new Set(['Environment', 'EnvironmentFile', 'ExecStartPre', 'ExecStartPost', 'Documentation']);

/**
 * Parses a unit exactly as systemd does for the properties asserted here.
 *
 * Reports what would make systemd misread the file: a `;` comment (systemd
 * does not support it), an indented line (a continuation, not a new value), a
 * line that is neither a section header, a comment nor a directive, a
 * directive outside a section, a repeated section, a comment that looks like
 * an assignment, and a scalar key that appears twice.
 *
 * @param {string} text
 * @returns {{ sections: Array<{name:string, entries:Array<{key:string,value:string,line:string,n:number}>, comments:Array<{line:string,n:number}>, n:number}>, problems: string[] }}
 */
function parseUnit(text) {
  const sections = [];
  const problems = [];
  let current = null;

  text.split('\n').forEach((line, index) => {
    const n = index + 1;
    if (line.trim() === '') return;

    if (line.startsWith(';')) {
      problems.push(`line ${n}: a ';' comment, which systemd does not read as a comment`);
      return;
    }

    if (line.startsWith('#')) {
      if (!current) problems.push(`line ${n}: a comment outside every section`);
      else current.comments.push({ line, n });
      // The 1.4.6 bug in one assertion: a comment that carries an assignment.
      if (/(^|[^A-Za-z0-9_])[A-Za-z][A-Za-z0-9]*=/.test(line)) {
        problems.push(`line ${n}: a comment contains a Key=value pattern: ${line}`);
      }
      return;
    }

    if (/^\s/.test(line)) {
      problems.push(`line ${n}: an indented line, which systemd joins to the one before it: ${line}`);
      return;
    }

    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      if (sections.some((section) => section.name === header[1])) {
        problems.push(`line ${n}: the section [${header[1]}] appears twice`);
      }
      current = { name: header[1], entries: [], comments: [], n };
      sections.push(current);
      return;
    }

    const equals = line.indexOf('=');
    if (equals <= 0) {
      problems.push(`line ${n}: not a section header, a comment or a directive: ${line}`);
      return;
    }
    if (!current) {
      problems.push(`line ${n}: a directive outside every section: ${line}`);
      return;
    }

    const entry = { key: line.slice(0, equals), value: line.slice(equals + 1), line, n };
    current.entries.push(entry);

    if (!REPEATABLE.has(entry.key)) {
      const earlier = current.entries.filter((other) => other !== entry && other.key === entry.key);
      if (earlier.length > 0) {
        problems.push(`line ${n}: ${entry.key} appears twice in [${current.name}], which systemd rejects`);
      }
    }
  });

  return { sections, problems };
}

/** Every value of one key in one section. */
function values(parsed, section, key) {
  return (parsed.sections.find((entry) => entry.name === section)?.entries ?? [])
    .filter((entry) => entry.key === key)
    .map((entry) => entry.value);
}

/** The single value of a key that must appear once; returns null when it does not. */
function single(parsed, section, key) {
  const all = values(parsed, section, key);
  return all.length === 1 ? all[0] : null;
}

const allKeys = (parsed) => parsed.sections.map((section) => section.name);

// ─── A `sudo` runner that really writes the unit ─────────────────────────────

/**
 * Stands in for core/shell.js `runFile`.
 *
 * Records the step names in `steps` (and the raw argv in `calls`, when given)
 * and, for `install`, copies the staged file where it was told to — that is
 * what makes the file parsed afterwards the file the production code actually
 * produced, not a fixture. Both the sudo form (`sudo systemctl …`) and the
 * direct form used when the process is already root (`systemctl …`) are
 * accepted, and both count as the same step.
 */
function unitFileRunner(steps, { failRestart = false, calls = null } = {}) {
  return async (file, args) => {
    if (calls) calls.push([file, ...args]);

    const verb = file === 'install' || file === 'systemctl'
      ? file
      : file === 'sudo' ? args[0] : null;
    const rest = file === 'sudo' ? args.slice(1) : args;

    if (verb === 'install') {
      steps.push('write-unit');
      fs.copyFileSync(rest.at(-2), rest.at(-1));
      return { success: true, stdout: '', stderr: '', exitCode: 0 };
    }
    if (verb === 'systemctl' && rest[0] === 'daemon-reload') {
      steps.push('daemon-reload');
      return { success: true, stdout: '', stderr: '', exitCode: 0 };
    }
    if (verb === 'systemctl' && rest[0] === 'restart') {
      steps.push('restart');
      return failRestart
        ? { success: false, stdout: '', stderr: 'Job for easy-devops.service failed', exitCode: 1 }
        : { success: true, stdout: '', stderr: '', exitCode: 0 };
    }
    steps.push(`unexpected:${[file, ...args].join(' ')}`);
    return {
      success: false,
      stdout: '',
      stderr: `unexpected command: ${file} ${args.join(' ')}`,
      exitCode: 1,
    };
  };
}

/** A `run` stub for journalctl. */
function journalRunner(lines = '') {
  const calls = [];
  const run = async (command) => {
    calls.push(command);
    return { success: true, stdout: lines, stderr: '', exitCode: 0 };
  };
  run.calls = calls;
  return run;
}

/**
 * A heartbeat stub that must never be reached.
 *
 * It records the fact rather than throwing: an assertion is a clear FAIL line,
 * while a throw would end the suite with a stack instead of a verdict.
 */
const neverCalled = (steps) => async () => {
  steps?.push('heartbeat');
  return { alive: false, waitedMs: 1, lock: null };
};

// The exact unit a 1.4.6 repair left on the Linux server, with the accumulated
// duplicates of every later repair. The `[Service]` inside the comment is what
// both the bad insertion and the bad strip matched.
const BROKEN_146_UNIT = `[Unit]
Description=Easy DevOps background service
Documentation=https://github.com/farghaly/easy-devops
After=network-online.target nginx.service
Wants=network-online.target

# These belong in [Unit], not [Service]
Environment=NODE_OPTIONS=: systemd moved them in v229 and still
Environment=NODE_PATH=: systemd moved them in v229 and still
Environment=WS_NO_BUFFER_UTIL=1: systemd moved them in v229 and still
Environment=WS_NO_UTF_8_VALIDATE=1: systemd moved them in v229 and still
# Stop restarting after 5 failures inside 60s, so a daemon that cannot start
# ends in a state 'systemctl status' reports plainly instead of thrashing.
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=deploy
WorkingDirectory=/opt/easy-devops
ExecStart=/home/deploy/.config/easy-devops/runtime/node --experimental-loader=file:///opt/easy-devops/src/core/service/runtime-loader.mjs /opt/easy-devops/src/cli/index.js daemon
Environment=EASY_DEVOPS_DATA_DIR=/home/deploy/.config/easy-devops

Restart=always
RestartSec=5

TimeoutStopSec=20
KillSignal=SIGTERM
StandardOutput=journal
StandardError=journal
SyslogIdentifier=easy-devops

[Install]
WantedBy=multi-user.target
`;

// A well-formed unit from before the protections were added: no loader, no
// managed Environment= assignments, only the data directory it was installed
// with — plus the resource tuning an operator raised by hand, which a repair
// must not silently reset. Two of the four LimitNOFILE lines below must NOT
// survive: the one outside [Service], the one inside a comment, and the one
// carrying an injected command.
const OLD_143_UNIT = `[Unit]
Description=Easy DevOps background service
After=network-online.target
Wants=network-online.target
LimitNOFILE=131072
# LimitNOFILE=262144

[Service]
Type=simple
User=deploy
WorkingDirectory=/opt/easy-devops
ExecStart=/opt/easy-devops/runtime/node /opt/easy-devops/src/cli/index.js daemon
Environment=EASY_DEVOPS_DATA_DIR=/home/deploy/.config/easy-devops
LimitNOFILE=65536
TasksMax=4096
LimitNOFILE=1;rm -rf /

Restart=always
RestartSec=5

TimeoutStopSec=20
KillSignal=SIGTERM
StandardOutput=journal
StandardError=journal
SyslogIdentifier=easy-devops

[Install]
WantedBy=multi-user.target
`;

// ─── 1. The generated unit ───────────────────────────────────────────────────

async function testGeneratedUnit() {
  setGroup('1. the unit is generated from a template and parses as systemd reads it');

  const sd = await import(srcUrl('core/service/systemd.js'));
  const { runtimeNodePath } = await import(srcUrl('core/service/runtime.js'));
  const platformModule = await import(srcUrl('core/platform.js'));

  const dataDir = '/home/deploy/.config/easy-devops';
  const entry = '/usr/lib/node_modules/easy-devops/src/cli/index.js';
  const unit = sd.buildUnit({ nodeExe: runtimeNodePath(dataDir), entry, user: 'deploy', dataDir });
  const parsed = parseUnit(unit);

  check('the generated unit has no parse problems', parsed.problems.length === 0, parsed.problems.join(' | '));
  check('the sections are [Unit], [Service], [Install] in that order',
    allKeys(parsed).join(',') === 'Unit,Service,Install', allKeys(parsed).join(','));
  check('the file begins with a section header on its own line',
    unit.split('\n')[0] === '[Unit]', unit.split('\n')[0]);

  // Every key in the section systemd reads it from. An exact set, not a
  // substring: a directive added to the wrong section fails here.
  const expected = {
    Unit: ['Description', 'Documentation', 'After', 'Wants', 'StartLimitIntervalSec', 'StartLimitBurst'],
    Service: [
      'Type', 'User', 'WorkingDirectory', 'ExecStart',
      'Environment', 'Restart', 'RestartSec', 'TimeoutStopSec', 'KillSignal',
      'StandardOutput', 'StandardError', 'SyslogIdentifier',
    ],
    Install: ['WantedBy'],
  };
  for (const [section, keys] of Object.entries(expected)) {
    const actualKeys = (parsed.sections.find((s) => s.name === section)?.entries ?? []).map((e) => e.key);
    const distinct = [...new Set(actualKeys)];
    check(`[${section}] holds exactly ${keys.length} distinct directive(s)`,
      distinct.length === keys.length && keys.every((key) => distinct.includes(key)),
      distinct.join(' '));
  }

  const comments = parsed.sections.flatMap((section) => section.comments);
  check('the unit has comments, and none of them contains a Key=value',
    comments.length > 0 && comments.every(({ line }) => !/(^|[^A-Za-z0-9_])[A-Za-z][A-Za-z0-9]*=/.test(line)),
    comments.map((c) => c.line).filter((line) => /(^|[^A-Za-z0-9_])[A-Za-z][A-Za-z0-9]*=/.test(line))[0] ?? '');

  const environmentSections = parsed.sections
    .filter((section) => section.entries.some((entry2) => entry2.key === 'Environment'))
    .map((section) => section.name);
  check('Environment= appears in [Service] and nowhere else',
    environmentSections.length === 1 && environmentSections[0] === 'Service', environmentSections.join(','));

  const environment = values(parsed, 'Service', 'Environment');
  check('every Environment= assignment is distinct, so systemd sees no duplicate',
    new Set(environment).size === environment.length, environment.join(' | '));
  check('the daemon environment carries every managed protection',
    ['NODE_OPTIONS=', 'NODE_PATH=', 'WS_NO_BUFFER_UTIL=1', 'WS_NO_UTF_8_VALIDATE=1', 'NODE_ENV=production']
      .every((setting) => environment.includes(setting)), environment.join(' | '));
  check('a non-default data directory is passed in the environment',
    environment.includes(`EASY_DEVOPS_DATA_DIR=${dataDir}`), environment.join(' | '));

  const execStart = single(parsed, 'Service', 'ExecStart') ?? '';
  // The value is escaped for systemd: a path that needs quoting arrives as a
  // JSON-quoted string. Both forms are the same runtime path.
  const runtime = runtimeNodePath(dataDir);
  check('ExecStart runs the pinned runtime link, the loader and the entry script, then daemon',
    (execStart.startsWith(`${runtime} `) || execStart.startsWith(`${JSON.stringify(runtime)} `))
      && /--experimental-loader=file:\/\/.*runtime-loader\.mjs/.test(execStart)
      && execStart.endsWith(`${entry} daemon`), execStart);
  check('the unit runs as the user it was given', single(parsed, 'Service', 'User') === 'deploy');
  check('the working directory is the package root, not src/cli',
    single(parsed, 'Service', 'WorkingDirectory') === '/usr/lib/node_modules/easy-devops',
    single(parsed, 'Service', 'WorkingDirectory'));
  check('StartLimitIntervalSec and StartLimitBurst live in [Unit], where systemd 229+ reads them',
    single(parsed, 'Unit', 'StartLimitIntervalSec') === '60' && single(parsed, 'Unit', 'StartLimitBurst') === '5');
  check('the unit starts at boot', single(parsed, 'Install', 'WantedBy') === 'multi-user.target');
  check('nothing in the unit is a password, a credential or a shell prompt',
    !/password|credential|sudo/i.test(unit));

  const defaultDirUnit = (() => {
    const platform = platformModule;
    const defaultDir = platform.isWindows
      ? path.join(process.env.APPDATA || os.homedir(), 'easy-devops')
      : path.join(os.homedir(), '.config', 'easy-devops');
    return {
      defaultDir,
      isDefault: platform.isDefaultDataDir(defaultDir),
      text: sd.buildUnit({ nodeExe: runtimeNodePath(defaultDir), entry, user: 'deploy', dataDir: defaultDir }),
    };
  })();

  check('a second build of the same install is byte-identical',
    sd.buildUnit({ nodeExe: runtimeNodePath(dataDir), entry, user: 'deploy', dataDir }) === unit);
  check('the default data directory is recognised as the default',
    defaultDirUnit.isDefault === true, defaultDirUnit.defaultDir);
  check('the default data directory is explained in a comment, not set in the environment',
    values(parseUnit(defaultDirUnit.text), 'Service', 'Environment')
      .every((line) => !line.startsWith('EASY_DEVOPS_DATA_DIR='))
      && /is not set: this is the default directory/.test(defaultDirUnit.text));

  // The template's own guards. These are what make the class of bug
  // impossible rather than merely absent from today's template.
  let rejectedComment = null;
  try {
    sd.serializeUnit([{ name: 'Unit', items: ['# these belong in [Service], not here: StartLimitBurst=5', ['Description', 'x']] }]);
  } catch (error) { rejectedComment = error.message; }
  check('the serializer refuses a comment that contains a Key=value pattern',
    Boolean(rejectedComment) && /comment/i.test(rejectedComment ?? ''), rejectedComment ?? 'no error');

  let rejectedDuplicate = null;
  try {
    sd.serializeUnit([{ name: 'Service', items: [['Type', 'simple'], ['Type', 'forking']] }]);
  } catch (error) { rejectedDuplicate = error.message; }
  check('the serializer refuses a duplicate key in one section',
    Boolean(rejectedDuplicate) && /twice/i.test(rejectedDuplicate ?? ''), rejectedDuplicate ?? 'no error');

  let rejectedLine = null;
  try {
    sd.serializeUnit([{ name: 'Service', items: ['Type=simple'] }]);
  } catch (error) { rejectedLine = error.message; }
  check('the serializer refuses a directive written as a bare string',
    Boolean(rejectedLine), rejectedLine ?? 'no error');
}

// ─── 2. Repair of the broken 1.4.6 unit ─────────────────────────────────────

async function testBrokenUnitRepair() {
  setGroup('2. the malformed 1.4.6 unit is replaced by a valid one');

  const sd = await import(srcUrl('core/service/systemd.js'));
  const { runtimeNodePath } = await import(srcUrl('core/service/runtime.js'));

  const dir = scratch('repair-146');
  const unitPath = path.join(dir, 'easy-devops.service');
  fs.writeFileSync(unitPath, BROKEN_146_UNIT);

  const dataDir = '/home/deploy/.config/easy-devops';
  const entry = '/opt/easy-devops/src/cli/index.js';

  // Proof the fixture is the broken state, so the assertions after it mean
  // something.
  const before = parseUnit(BROKEN_146_UNIT);
  check('the fixture is really broken: Environment= sits outside [Service]',
    values(before, 'Unit', 'Environment').length === 4, values(before, 'Unit', 'Environment').join(' | '));
  check('and the broken lines carry the comment suffix systemd ignores',
    BROKEN_146_UNIT.includes('Environment=WS_NO_BUFFER_UTIL=1: systemd moved them in v229 and still'));

  const steps = [];
  const refreshed = await sd.refreshUnit({
    entry,
    dataDir,
    unitPath,
    fileRunner: unitFileRunner(steps),
    interactive: async () => ({ success: true }),
  });

  const repaired = fs.readFileSync(unitPath, 'utf8');
  const parsed = parseUnit(repaired);

  check('repair succeeds', refreshed.ok === true, refreshed.reason ?? '');
  check('the repaired unit parses with no problems', parsed.problems.length === 0, parsed.problems.join(' | '));
  check('nothing of the old comment suffix survives',
    !/=\d+: systemd/.test(repaired)
      && !/: systemd moved them in v229 and still/.test(repaired)
      && !/(?:^|\n)Environment=[^\n]*: /.test(repaired));
  check('Environment= is now only in [Service]',
    parsed.sections.filter((s) => s.entries.some((e) => e.key === 'Environment')).map((s) => s.name).join(',') === 'Service');
  const environment = values(parsed, 'Service', 'Environment');
  check('each protection appears exactly once',
    ['NODE_OPTIONS=', 'NODE_PATH=', 'WS_NO_BUFFER_UTIL=1', 'WS_NO_UTF_8_VALIDATE=1']
      .every((setting) => environment.filter((line) => line === setting).length === 1),
    environment.join(' | '));
  check('the repair keeps the account the service runs as', single(parsed, 'Service', 'User') === 'deploy');
  const repairedExecStart = single(parsed, 'Service', 'ExecStart') ?? '';
  const repairedRuntime = runtimeNodePath(dataDir);
  check('the repair derives the pinned runtime and the loader again',
    (repairedExecStart.startsWith(`${repairedRuntime} `)
      || repairedExecStart.startsWith(`${JSON.stringify(repairedRuntime)} `))
      && /runtime-loader\.mjs/.test(repairedExecStart), repairedExecStart);
  check('the previous unit was kept as a .prev file beside it',
    fs.readFileSync(`${unitPath}.prev`, 'utf8') === BROKEN_146_UNIT,
    `${unitPath}.prev`);
  check('the write went through the staged sudo install, not an in-place edit',
    steps[0] === 'write-unit' && steps.filter((step) => step === 'write-unit').length === 1, steps.join(' → '));

  // A second repair must change nothing at all — that is what stops the
  // "every repair adds another duplicate" behaviour.
  const secondSteps = [];
  const second = await sd.refreshUnit({
    entry,
    dataDir,
    unitPath,
    fileRunner: unitFileRunner(secondSteps),
    interactive: async () => ({ success: true }),
  });
  const afterSecond = fs.readFileSync(unitPath, 'utf8');

  check('a second repair reports that the unit is already current',
    second.ok === true && second.unchanged === true, JSON.stringify(second));
  check('a second repair writes nothing', secondSteps.length === 0, secondSteps.join(' → '));
  check('a second repair leaves the file byte-identical', afterSecond === repaired);
  check('and does not overwrite the .prev copy with the repaired unit',
    fs.readFileSync(`${unitPath}.prev`, 'utf8') === BROKEN_146_UNIT);
}

// ─── 3. Repair of a well-formed older unit, and its tuning ─────────────────

async function testOldUnitRepair() {
  setGroup('3. a well-formed 1.4.3 unit is brought to the generated one, keeping its tuning');

  const sd = await import(srcUrl('core/service/systemd.js'));
  const { runtimeNodePath } = await import(srcUrl('core/service/runtime.js'));

  const dir = scratch('repair-143');
  const unitPath = path.join(dir, 'easy-devops.service');
  fs.writeFileSync(unitPath, OLD_143_UNIT);

  const dataDir = '/home/deploy/.config/easy-devops';
  const entry = '/opt/easy-devops/src/cli/index.js';
  const steps = [];
  const logged = [];

  const refreshed = await sd.refreshUnit({
    entry,
    dataDir,
    unitPath,
    log: (line) => logged.push(line),
    fileRunner: unitFileRunner(steps),
    interactive: async () => ({ success: true }),
  });

  const repaired = fs.readFileSync(unitPath, 'utf8');
  const parsed = parseUnit(repaired);
  const service = parsed.sections.find((section) => section.name === 'Service') ?? { entries: [] };
  const tuning = service.entries.filter((e) => /^(Limit[A-Z]+|Nice|OOMScoreAdjust|TasksMax)$/.test(e.key));

  check('repair succeeds', refreshed.ok === true, refreshed.reason ?? '');
  check('the result is exactly the generated unit plus the carried-over tuning',
    repaired === sd.buildUnit({
      nodeExe: runtimeNodePath(dataDir),
      entry,
      dataDir,
      user: 'deploy',
      tuning: [['LimitNOFILE', '65536'], ['TasksMax', '4096']],
    }),
    repaired === sd.buildUnit({
      nodeExe: runtimeNodePath(dataDir), entry, dataDir, user: 'deploy',
      tuning: [['LimitNOFILE', '65536'], ['TasksMax', '4096']],
    }) ? '' : 'differs from buildUnit() with the same tuning');
  check('the unit parses with no problems', parsed.problems.length === 0, parsed.problems.join(' | '));
  check('the operator\'s resource tuning survives the repair, in [Service]',
    tuning.map((e) => e.line).join(' | ') === 'LimitNOFILE=65536 | TasksMax=4096',
    tuning.map((e) => e.line).join(' | '));
  check('a tuning key outside [Service] is not carried over',
    !/131072/.test(repaired) && values(parsed, 'Unit', 'LimitNOFILE').length === 0);
  check('a tuning key inside a comment is not carried over', !/262144/.test(repaired));
  check('an injected tuning value is dropped, and said so',
    !/rm -rf/.test(repaired)
      && logged.some((line) => line.includes('dropped LimitNOFILE from the old unit')),
    logged.filter((line) => line.includes('dropped')).join(' | '));
  check('the 1.4.3 unit is kept as a .prev file', fs.readFileSync(`${unitPath}.prev`, 'utf8') === OLD_143_UNIT);

  const secondSteps = [];
  const second = await sd.refreshUnit({
    entry, dataDir, unitPath, fileRunner: unitFileRunner(secondSteps),
    interactive: async () => ({ success: true }),
  });
  check('repairing the repaired unit is a no-op, tuning included',
    second.ok === true && second.unchanged === true, JSON.stringify(second));
  check('and writes nothing the second time', secondSteps.length === 0, secondSteps.join(' → '));

  // Only an injected value: nothing to carry, so no LimitNOFILE is invented.
  const injectedDir = scratch('repair-injected');
  const injectedPath = path.join(injectedDir, 'easy-devops.service');
  fs.writeFileSync(injectedPath, OLD_143_UNIT
    .replace('LimitNOFILE=65536\nTasksMax=4096\nLimitNOFILE=1;rm -rf /\n', 'LimitNOFILE=1;rm -rf /\n'));
  const injectedLogged = [];
  const injected = await sd.refreshUnit({
    entry,
    dataDir,
    unitPath: injectedPath,
    log: (line) => injectedLogged.push(line),
    fileRunner: unitFileRunner([]),
    interactive: async () => ({ success: true }),
  });
  const injectedUnit = fs.readFileSync(injectedPath, 'utf8');

  check('a unit whose only tuning value is injected is repaired without it',
    injected.ok === true && !/LimitNOFILE/.test(injectedUnit) && !/rm -rf/.test(injectedUnit),
    injectedUnit.split('\n').find((line) => /LimitNOFILE|rm -rf/.test(line)) ?? '');
  check('and the dropped key is named in the output',
    injectedLogged.some((line) => line.includes('dropped LimitNOFILE from the old unit')),
    injectedLogged.filter((line) => line.includes('dropped')).join(' | '));
}

// ─── 4. recoverService ─────────────────────────────────────────────────────

async function testRecoverService() {
  setGroup('4. recoverService regenerates the unit, restarts, and proves the daemon is alive');

  const sd = await import(srcUrl('core/service/systemd.js'));

  const dir = scratch('recover');
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const unitPath = path.join(dir, 'easy-devops.service');
  fs.writeFileSync(unitPath, BROKEN_146_UNIT);
  const stopFile = path.join(dataDir, 'daemon.stop');
  fs.writeFileSync(stopFile, `${JSON.stringify({ at: new Date().toISOString(), reason: 'left by 1.4.6' })}\n`);

  const steps = [];
  const calls = [];
  const waitCalls = [];
  const result = await sd.recoverService({
    dataDir,
    entry: '/opt/easy-devops/src/cli/index.js',
    unitPath,
    log: () => {},
    run: journalRunner(),
    runFile: unitFileRunner(steps, { calls }),
    waitForDaemon: async (opts) => {
      steps.push('heartbeat');
      waitCalls.push(opts);
      return { alive: true, waitedMs: 1234, lock: { pid: 4242 } };
    },
    deps: {
      isRoot: () => false,
      linkRuntime: () => ({ ok: true, link: '/x/runtime/node', target: '/usr/bin/node' }),
    },
  });

  check('recovery reports success', result.ok === true, result.reason ?? '');
  check('the steps run in the order write → daemon-reload → restart → heartbeat',
    steps.join(' → ') === 'write-unit → daemon-reload → restart → heartbeat', steps.join(' → '));
  check('the heartbeat is awaited before success is reported',
    waitCalls.length === 1 && waitCalls[0].dataDir === dataDir);
  check('the reported pid is the one the heartbeat carried', result.pid === 4242, String(result.pid));
  check('the unit on disk is valid again', parseUnit(fs.readFileSync(unitPath, 'utf8')).problems.length === 0);
  check('the stale stop request is gone, so the daemon cannot be stopped again at once',
    !fs.existsSync(stopFile));
  check('the previous unit is kept as .prev', fs.readFileSync(`${unitPath}.prev`, 'utf8') === BROKEN_146_UNIT);
  check('recovery used no shell string for its privileged steps',
    steps.every((step) => !step.startsWith('unexpected')), steps.join(' → '));
  check('as a normal user every privileged command goes through sudo, as argv',
    calls.length === 3
      && calls.every(([file]) => file === 'sudo')
      && calls[0][1] === 'install'
      && calls[1].join(' ') === 'sudo systemctl daemon-reload'
      && calls[2].join(' ') === 'sudo systemctl restart easy-devops.service',
    calls.map((call) => call.join(' ')).join(' | '));

  // ── As root, there is no sudo to ask — and possibly none installed ──────
  const rootDir = scratch('recover-root');
  const rootData = path.join(rootDir, 'data');
  fs.mkdirSync(rootData, { recursive: true });
  const rootUnit = path.join(rootDir, 'easy-devops.service');
  fs.writeFileSync(rootUnit, BROKEN_146_UNIT);
  const rootSteps = [];
  const rootCalls = [];
  const rootResult = await sd.recoverService({
    dataDir: rootData,
    entry: '/opt/easy-devops/src/cli/index.js',
    unitPath: rootUnit,
    log: () => {},
    run: journalRunner(),
    runFile: unitFileRunner(rootSteps, { calls: rootCalls }),
    waitForDaemon: async () => {
      rootSteps.push('heartbeat');
      return { alive: true, waitedMs: 3, lock: { pid: 7 } };
    },
    deps: {
      isRoot: () => true,
      linkRuntime: () => ({ ok: true, link: '/x/runtime/node', target: '/usr/bin/node' }),
    },
  });

  check('as root, recovery succeeds without sudo', rootResult.ok === true, rootResult.reason ?? '');
  check('as root, no command is wrapped in sudo',
    rootCalls.every(([file]) => file !== 'sudo'), rootCalls.map((call) => call.join(' ')).join(' | '));
  check('as root, the unit is installed and systemctl is invoked directly',
    rootCalls.map((call) => call.join(' ')).join(' | ')
      === `install -m 0644 -- ${rootCalls[0]?.at(-2)} ${rootUnit} | systemctl daemon-reload | systemctl restart easy-devops.service`,
    rootCalls.map((call) => call.join(' ')).join(' | '));
  check('as root, the order is still write → reload → restart → heartbeat',
    rootSteps.join(' → ') === 'write-unit → daemon-reload → restart → heartbeat', rootSteps.join(' → '));
  check('as root, the unit on disk is valid and the previous one kept',
    parseUnit(fs.readFileSync(rootUnit, 'utf8')).problems.length === 0
      && fs.readFileSync(`${rootUnit}.prev`, 'utf8') === BROKEN_146_UNIT);

  // ── A daemon that starts and dies ────────────────────────────────────────
  const failingDir = scratch('recover-heartbeat');
  const failingData = path.join(failingDir, 'data');
  fs.mkdirSync(failingData, { recursive: true });
  const failingUnit = path.join(failingDir, 'easy-devops.service');
  fs.writeFileSync(failingUnit, BROKEN_146_UNIT);
  const failingSteps = [];
  const failing = await sd.recoverService({
    dataDir: failingData,
    entry: '/opt/easy-devops/src/cli/index.js',
    unitPath: failingUnit,
    log: () => {},
    run: journalRunner('easy-devops.service: Failed to initialize database at: /home/deploy/.config/easy-devops/easy-devops.sqlite'),
    runFile: unitFileRunner(failingSteps),
    waitForDaemon: async () => ({ alive: false, waitedMs: 5000, lock: null }),
    deps: {
      isRoot: () => false,
      linkRuntime: () => ({ ok: true, link: '/x', target: '/y' }),
    },
  });

  check('a daemon that never reports in is a failure', failing.ok === false, JSON.stringify(failing));
  check('the failure names the heartbeat step', failing.step === 'heartbeat', String(failing.step));
  check('the failure carries the last journal lines',
    /Last log lines:/.test(failing.reason ?? '') && /Failed to initialize database/.test(failing.reason ?? ''),
    (failing.reason ?? '').split('\n')[0]);
  check('the failure says which command to run next',
    /Next: .*ezz service logs/.test(failing.reason ?? ''), failing.next ?? '');

  // ── A manager that refuses the restart ───────────────────────────────────
  const restartDir = scratch('recover-restart');
  const restartData = path.join(restartDir, 'data');
  fs.mkdirSync(restartData, { recursive: true });
  const restartUnit = path.join(restartDir, 'easy-devops.service');
  fs.writeFileSync(restartUnit, BROKEN_146_UNIT);
  const restartSteps = [];
  const refused = await sd.recoverService({
    dataDir: restartData,
    entry: '/opt/easy-devops/src/cli/index.js',
    unitPath: restartUnit,
    log: () => {},
    run: journalRunner(),
    runFile: unitFileRunner(restartSteps, { failRestart: true }),
    waitForDaemon: neverCalled(restartSteps),
    deps: {
      isRoot: () => false,
      linkRuntime: () => ({ ok: true, link: '/x', target: '/y' }),
    },
  });

  check('a refused restart is a failure', refused.ok === false && refused.step === 'restart',
    `${refused.step}: ${String(refused.reason).split('\n')[0]}`);
  check('a refused restart is not reported as a running daemon', !restartSteps.includes('heartbeat'),
    restartSteps.join(' → '));
  check('and it returns the next command', /Next: /.test(refused.reason ?? ''), refused.next ?? '');

  // ── A stop request that cannot be cleared ────────────────────────────────
  const blockedDir = scratch('recover-stoprequest');
  const blockedData = path.join(blockedDir, 'data');
  fs.mkdirSync(blockedData, { recursive: true });
  const blockedUnit = path.join(blockedDir, 'easy-devops.service');
  fs.writeFileSync(blockedUnit, BROKEN_146_UNIT);
  const blockedSteps = [];
  const blocked = await sd.recoverService({
    dataDir: blockedData,
    entry: '/opt/easy-devops/src/cli/index.js',
    unitPath: blockedUnit,
    log: () => {},
    run: journalRunner(),
    runFile: unitFileRunner(blockedSteps),
    waitForDaemon: neverCalled(blockedSteps),
    deps: {
      isRoot: () => false,
      linkRuntime: () => ({ ok: true, link: '/x', target: '/y' }),
      clearStopRequest: () => false,
    },
  });

  check('a stop request that cannot be cleared fails before the restart',
    blocked.ok === false && blocked.step === 'stop-request' && !blockedSteps.includes('restart'),
    `${blocked.step}: ${blockedSteps.join(' → ')}`);
  check('and the next command is the exact file to remove',
    (blocked.reason ?? '').includes(path.join(blockedData, 'daemon.stop')), blocked.next ?? '');
}

// ─── 5. One rule for every privileged command: root runs it, others sudo ────

/**
 * The owner's Linux server is a root install. 1.4.7 ran `sudo systemctl …` and
 * `sudo install …` unconditionally, so on a root server without sudo installed
 * `ezz update` stopped and started nothing at all — while `recover` already
 * dropped the wrapper. Every privileged command in systemd.js now goes through
 * one decision, and this group pins both halves of it with an injected uid:
 * root → the argv starts with `systemctl` / `install` / `rm`, a normal user →
 * it starts with `sudo`.
 */
async function testPrivilegeRule() {
  setGroup('5. as root every privileged command runs directly; otherwise sudo asks');

  const sd = await import(srcUrl('core/service/systemd.js'));

  const dir = scratch('privilege');
  const unitPath = path.join(dir, 'easy-devops.service');
  fs.writeFileSync(unitPath, BROKEN_146_UNIT);
  const tty = { isTTY: true };

  /** A runner that records every argv and succeeds, so nothing real is run. */
  const recorder = () => {
    const calls = [];
    const fileRunner = async (file, args) => {
      calls.push([file, ...args]);
      return { success: true, exitCode: 0, stdout: '', stderr: '' };
    };
    const interactive = async (command) => {
      calls.push([String(command)]);
      return { success: true, exitCode: 0, stdout: '', stderr: '' };
    };
    return { calls, fileRunner, interactive, joined: () => calls.map((call) => call.join(' ')) };
  };

  for (const [label, isRoot] of [['as root', true], ['as a normal user', false]]) {
    const { calls, fileRunner, joined } = recorder();
    const restarted = await sd.restart({ fileRunner, isRoot });
    const stopped = await sd.stop({ fileRunner, isRoot, unitPath, stdin: tty });
    const started = await sd.start({ fileRunner, isRoot, unitPath, stdin: tty });

    check(`${label}: restart, stop and start succeed`,
      restarted.ok && stopped.ok && started.ok,
      restarted.reason ?? stopped.reason ?? started.reason ?? '');

    const expected = isRoot
      ? [['systemctl', 'restart', sd.UNIT_NAME], ['systemctl', 'stop', sd.UNIT_NAME], ['systemctl', 'start', sd.UNIT_NAME]]
      : [['sudo', 'systemctl', 'restart', sd.UNIT_NAME], ['sudo', 'systemctl', 'stop', sd.UNIT_NAME], ['sudo', 'systemctl', 'start', sd.UNIT_NAME]];
    check(`${label}: restart, stop and start are ${isRoot ? 'systemctl argv with no sudo' : 'sudo systemctl argv'}`,
      JSON.stringify(calls) === JSON.stringify(expected), joined().join(' | '));
  }

  // Root has nothing to answer, so it must not demand a terminal; a normal user
  // must still have one, because sudo asks there and nowhere else.
  const rootNoTty = recorder();
  const rootStop = await sd.stop({ fileRunner: rootNoTty.fileRunner, isRoot: true, unitPath, stdin: { isTTY: false } });
  check('as root, stop needs no terminal (there is no password to ask for)',
    rootStop.ok === true && rootNoTty.calls.length === 1, rootStop.reason ?? '');
  const userNoTty = recorder();
  const userStop = await sd.stop({ fileRunner: userNoTty.fileRunner, isRoot: false, unitPath, stdin: { isTTY: false } });
  check('as a normal user, stop still refuses without a terminal, because sudo must ask',
    userStop.ok === false && /terminal/i.test(userStop.reason ?? '') && userNoTty.calls.length === 0,
    userStop.reason ?? '');

  // ── install: the file copy, enable and restart ───────────────────────────
  for (const [label, isRoot] of [['as root', true], ['as a normal user', false]]) {
    const { calls, fileRunner, interactive, joined } = recorder();
    const installed = await sd.install({
      nodeExe: path.join(dir, 'runtime', 'node'),
      entry: path.join(dir, 'src', 'cli', 'index.js'),
      dataDir: dir,
      user: 'deploy',
      fileRunner,
      interactive,
      unitPath: path.join(dir, `install-${isRoot ? 'root' : 'user'}.service`),
      stdin: tty,
      isRoot,
      runner: async () => ({ success: true, exitCode: 0, stdout: '', stderr: '' }),
    });

    check(`${label}: install succeeds`, installed.ok === true, installed.reason ?? '');
    check(`${label}: the unit copy is ${isRoot ? 'install' : 'sudo install'}, and reload, enable and restart follow the same rule`,
      calls[0]?.[0] === (isRoot ? 'install' : 'sudo')
        && calls[0]?.join(' ').includes('-m 0644')
        && calls.slice(1).map((call) => call.join(' ')).join(' | ') === (isRoot
          ? 'systemctl daemon-reload | systemctl enable easy-devops.service | systemctl restart easy-devops.service'
          : 'sudo systemctl daemon-reload | sudo systemctl enable easy-devops.service | sudo systemctl restart easy-devops.service'),
      joined().join(' | '));
  }

  // A root install needs no terminal at all: nobody has to answer sudo, and a
  // server being set up by a script has none.
  const scripted = recorder();
  const scriptedInstall = await sd.install({
    nodeExe: path.join(dir, 'runtime', 'node'),
    entry: path.join(dir, 'src', 'cli', 'index.js'),
    dataDir: dir,
    user: 'deploy',
    fileRunner: scripted.fileRunner,
    interactive: scripted.interactive,
    unitPath: path.join(dir, 'install-scripted.service'),
    stdin: { isTTY: false },
    isRoot: true,
    runner: async () => ({ success: true, exitCode: 0, stdout: '', stderr: '' }),
  });
  check('as root, install does not demand a terminal it has no use for',
    scriptedInstall.ok === true, scriptedInstall.reason ?? '');
  const scriptedUser = recorder();
  const scriptedRefused = await sd.install({
    nodeExe: path.join(dir, 'runtime', 'node'),
    entry: path.join(dir, 'src', 'cli', 'index.js'),
    dataDir: dir,
    fileRunner: scriptedUser.fileRunner,
    interactive: scriptedUser.interactive,
    unitPath: path.join(dir, 'install-refused.service'),
    stdin: { isTTY: false },
    isRoot: false,
  });
  check('as a normal user, install still refuses without a terminal',
    scriptedRefused.ok === false && /terminal/i.test(scriptedRefused.reason ?? ''),
    scriptedRefused.reason ?? '');

  // ── daemon-reload, through a unit rewrite ────────────────────────────────
  for (const [label, isRoot] of [['as root', true], ['as a normal user', false]]) {
    const { calls, fileRunner, interactive, joined } = recorder();
    const refreshPath = path.join(dir, `refresh-${isRoot ? 'root' : 'user'}.service`);
    fs.writeFileSync(refreshPath, OLD_143_UNIT);
    const refreshed = await sd.refreshUnit({
      entry: '/opt/easy-devops/src/cli/index.js',
      dataDir: dir,
      unitPath: refreshPath,
      fileRunner,
      interactive,
      isRoot,
    });

    const reloadLine = calls.map((call) => call.join(' ')).find((line) => line.includes('daemon-reload')) ?? '';
    check(`${label}: rewriting the unit copies it with ${isRoot ? 'install' : 'sudo install'} and reloads with ${isRoot ? 'systemctl' : 'sudo systemctl'}`,
      refreshed.ok === true
        && calls[0]?.[0] === (isRoot ? 'install' : 'sudo')
        && reloadLine === (isRoot ? 'systemctl daemon-reload' : 'sudo systemctl daemon-reload'),
      joined().join(' | '));
  }

  // ── uninstall: stop, disable, rm, reload, reset-failed ──────────────────
  for (const [label, isRoot] of [['as root', true], ['as a normal user', false]]) {
    const { calls, fileRunner, interactive, joined } = recorder();
    const removePath = path.join(dir, `remove-${isRoot ? 'root' : 'user'}.service`);
    const removed = await sd.uninstall({ fileRunner, interactive, unitPath: removePath, stdin: tty, isRoot });

    const lines = joined();
    check(`${label}: uninstall succeeds`, removed.ok === true, removed.reason ?? '');
    check(`${label}: uninstall ${isRoot ? 'never wraps a step in sudo' : 'wraps every step in sudo'}`,
      isRoot
        ? lines.every((line) => !line.startsWith('sudo ') && line.split(' ')[1] !== 'sudo')
        : lines.every((line) => line.startsWith('sudo ')),
      lines.join(' | '));
    check(`${label}: stop, disable, rm, daemon-reload and reset-failed all ran`,
      ['systemctl stop', 'systemctl disable', 'rm -f --', 'systemctl daemon-reload', 'systemctl reset-failed']
        .every((part) => lines.join(' ').includes(part)), lines.join(' | '));
  }

  // ── status: readable state never elevates, for anyone ────────────────────
  const statusCalls = [];
  const statusRunner = async (command) => {
    statusCalls.push(String(command));
    return {
      success: true,
      exitCode: 0,
      stdout: 'ActiveState=active\nSubState=running\nNRestarts=0\nUnitFileState=enabled\n',
      stderr: '',
    };
  };
  const statusRoot = await sd.status({ runner: statusRunner, unitPath, isRoot: true });
  const statusUser = await sd.status({ runner: statusRunner, unitPath, isRoot: false });
  check('status reads the same for root and a normal user, and never adds sudo',
    statusRoot.running === true && statusUser.running === true
      && statusCalls.length === 2
      && statusCalls.every((command) => command.startsWith('systemctl show ') && !command.includes('sudo')),
    statusCalls.join(' | '));
}

// ─── 6. systemd's own parser, when it exists here ───────────────────────────

async function testSystemdAnalyze() {
  setGroup('6. systemd-analyze verify accepts the generated unit');

  const shell = await import(srcUrl('core/shell.js'));
  const sd = await import(srcUrl('core/service/systemd.js'));

  const probe = await shell.runFile('systemd-analyze', ['--version'], { timeout: 10_000 });
  if (!probe.success) {
    skip('systemd-analyze verify', `systemd-analyze is not on PATH here (${probe.stderr.split('\n')[0] || 'not found'})`);
    return;
  }

  const dir = scratch('systemd-analyze');
  const unitPath = path.join(dir, 'easy-devops.service');
  fs.writeFileSync(unitPath, sd.buildUnit({
    nodeExe: '/usr/bin/node',
    entry: '/opt/easy-devops/src/cli/index.js',
    user: 'deploy',
    dataDir: '/home/deploy/.config/easy-devops',
  }));

  const verified = await shell.runFile('systemd-analyze', ['verify', unitPath], { timeout: 60_000 });
  const output = [verified.stdout, verified.stderr].filter(Boolean).join('\n');

  // `verify` also reports a runtime path that does not exist on this machine,
  // which is not a syntax problem with the unit. What must not appear is a
  // complaint about the file's structure: an unknown section or key, a parse
  // failure, or a duplicate.
  const structural = /Unknown (section|key|directive|lvalue)|Failed to parse|Invalid (setting|unit)|Syntax error|duplicate/i;
  check('systemd-analyze verify finds no structural problem in the generated unit',
    !structural.test(output), output.split('\n').filter((line) => structural.test(line))[0] ?? output.slice(0, 120));
  check('and does not reject it as unloadable',
    !/cannot be (loaded|parsed)|not a valid unit/i.test(output), output.slice(0, 120));
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write('\nLinux systemd unit\n');
  process.stdout.write(`data dir: ${TEST_DATA_DIR}\n`);

  await testGeneratedUnit();
  await testBrokenUnitRepair();
  await testOldUnitRepair();
  await testRecoverService();
  await testPrivilegeRule();
  await testSystemdAnalyze();

  const failed = results.filter((result) => !result.passed);
  const skipped = results.filter((result) => result.skipped);
  process.stdout.write(`\n${'-'.repeat(62)}\n`);
  process.stdout.write(
    `TOTAL ${results.length}   PASS ${results.length - failed.length - skipped.length}`
    + `   SKIP ${skipped.length}   FAIL ${failed.length}\n`,
  );
  if (failed.length) {
    process.stdout.write('\nFailures:\n');
    for (const failure of failed) {
      process.stdout.write(`  [${failure.group}] ${failure.label}`
        + `${failure.detail ? ` — ${failure.detail}` : ''}\n`);
    }
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? String(error)}\n`);
  process.exit(1);
});
