/**
 * Historical service-upgrade matrix: one command from every old state.
 *
 * Run with: node e2e/run.mjs service-upgrade-matrix
 *
 * What 1.4.7's tests could not see (contract cause C9)
 * ---------------------------------------------------
 * The old fake `icacls` in this suite was an in-process `runFile` stub. It
 * returned everything, sorted every path globally, and never went through
 * `core/shell.js`, so neither the 64 KiB captured-output tail nor icacls's real
 * enumeration order could apply. The fixture runtime had five files.
 *
 * What this suite does instead
 * ---------------------------
 * e2e/lib/fake-icacls.mjs runs as its own process, over a real tree on disk,
 * driven through the REAL `core/shell.js` `runFile` - the same path production
 * uses. It prints a folder's own matches first and then each subfolder, which is
 * the order that pushed `runtime\node.exe` out of the captured tail on the real
 * server, and it produces the same multi-megabyte output for the 11,000-file
 * runtime. Its DACL state is a JSON document the suite reads back, so every
 * assertion below is made against a model the production code actually wrote.
 *
 * Every Windows command goes to the fake; `sc.exe` is a stateful fake SCM and
 * WinSW is a stateful stub, so a "start" writes the daemon's own heartbeat lock
 * the same way the service does. Nothing here runs real icacls, sc.exe,
 * systemctl or sudo, and every path is below the run's temporary data directory.
 *
 * The structure: groups 1-10 hold the historical versions' behaviours that were
 * already covered. Groups 11-22 are the owner's Part 2 states, one command each,
 * asserted from the FINAL state: registered and running, heartbeat on the CLI
 * version under test, every file under bin and runtime readable by SYSTEM,
 * Administrators and the service account, SYSTEM and Administrators full control
 * at every recorded intermediate ACL, user data byte for byte unchanged, and no
 * Startup file on a Server edition.
 */

import './lib/guard.mjs';
import { TEST_DATA_DIR, assertInsideTestDataDir } from './lib/guard.mjs';
import {
  HISTORICAL_VERSIONS,
  INSTALL_PROGRESS_FILE,
  MALFORMED_UNIT_LINE,
  PERSONAL_LAUNCHER_FILE,
  PERSONAL_SUPERVISOR_FILE,
  PUBLISHED_VERSIONS,
  STARTUP_RELATIVE,
  TRUSTEES,
  materializeHealthyVersionFixtures,
  materializeServerEvidenceFixture,
  materializeUpgradeFixtures,
  materializeUpgradeStates,
} from './fixtures/upgrade-history.mjs';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const srcUrl = (relative) => pathToFileURL(path.join(ROOT, 'src', relative)).href;
const ENTRY = path.join(ROOT, 'src', 'cli', 'index.js');
const FAKE_ICACLS = path.join(__dirname, 'lib', 'fake-icacls.mjs');
const TARGET_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const PIPELINED_NODE_VERSION = process.version;

let modules = null;
let IS_WINDOWS = false;

const results = [];
const states = [];
let group = '';

function setGroup(name) {
  group = name;
  process.stdout.write(`\n-- ${name}\n`);
}

function check(label, passed, detail = '') {
  results.push({ group, label, passed, detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}

function skip(label, reason) {
  results.push({ group, label, passed: true, skipped: true, detail: reason });
  process.stdout.write(`   SKIP  ${label}  (${reason})\n`);
}

/** A line for the operator; not a check, so the runner does not count it. */
function note(text) {
  process.stdout.write(`   ..    ${text}\n`);
}

/** One line per state, as the brief asks. */
function stateLine(name, passed, detail) {
  states.push({ name, passed, detail });
  process.stdout.write(`   ..    STATE ${name}: ${passed ? 'PASS' : 'FAIL'}${detail ? ` - ${detail}` : ''}\n`);
}

function scratch(name) {
  const dir = path.join(TEST_DATA_DIR, 'upgrade-matrix', name);
  assertInsideTestDataDir(dir, `create ${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function withEnv(values, fn) {
  const previous = new Map();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** Runs `fn` with ProgramData, %APPDATA% and the data directory on one fixture. */
async function asWindowsFixture(fixture, fn, { dataDirEnv } = {}) {
  const appData = fixture.windows.appDataDir ?? path.join(fixture.root, 'AppData');
  fs.mkdirSync(appData, { recursive: true });
  return withEnv({
    EASY_DEVOPS_DATA_DIR: dataDirEnv ?? fixture.windows.dataDir,
    ProgramData: fixture.windows.programData,
    APPDATA: appData,
  }, async () => {
    modules.platform.resetDataDirCache();
    try {
      return await fn();
    } finally {
      modules.platform.resetDataDirCache();
    }
  });
}

// --- User data: hash every file, before and after ---------------------------

/** Every entry under `root`, the root included: files and directories. */
function walkEntries(root) {
  const found = [];
  const stat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!stat) return found;
  if (!stat.isDirectory()) return [root];
  found.push(root);
  const visit = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const full = path.join(dir, entry.name);
      found.push(full);
      if (entry.isDirectory()) visit(full);
    }
  };
  visit(root);
  return found;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** `relative|sha256` for every file under the given roots, sorted. */
function hashUserData(entries) {
  const base = path.dirname(entries[0]);
  const rows = [];
  for (const entry of entries) {
    for (const file of walkEntries(entry)) {
      if (fs.statSync(file).isDirectory()) continue;
      rows.push(`${path.relative(base, file)}|${sha256(file)}`);
    }
  }
  return rows.sort();
}

function sameRows(left, right) {
  return left.length === right.length && left.every((row, index) => row === right[index]);
}

// --- The systemd unit: parsed, never grepped --------------------------------

/** Which section a directive belongs in, for the keys this template emits. */
const UNIT_SECTION = new Map([
  ['Description', 'Unit'], ['Documentation', 'Unit'], ['After', 'Unit'], ['Before', 'Unit'],
  ['Wants', 'Unit'], ['Requires', 'Unit'], ['StartLimitIntervalSec', 'Unit'],
  ['StartLimitBurst', 'Unit'],
  ['Type', 'Service'], ['User', 'Service'], ['WorkingDirectory', 'Service'],
  ['ExecStart', 'Service'], ['ExecStartPre', 'Service'], ['ExecStartPost', 'Service'],
  ['ExecStop', 'Service'], ['Environment', 'Service'], ['EnvironmentFile', 'Service'],
  ['Restart', 'Service'], ['RestartSec', 'Service'], ['TimeoutStopSec', 'Service'],
  ['KillSignal', 'Service'], ['StandardOutput', 'Service'], ['StandardError', 'Service'],
  ['SyslogIdentifier', 'Service'], ['LimitNOFILE', 'Service'], ['LimitNPROC', 'Service'],
  ['Nice', 'Service'], ['TasksMax', 'Service'], ['OOMScoreAdjust', 'Service'],
  ['MemoryMax', 'Service'], ['CPUQuota', 'Service'],
  ['WantedBy', 'Install'], ['RequiredBy', 'Install'], ['Alias', 'Install'],
]);

const REPEATABLE_KEYS = new Set([
  'Environment', 'EnvironmentFile', 'ExecStartPre', 'ExecStartPost', 'ExecStart', 'ExecStop',
  'After', 'Before', 'Wants', 'Requires', 'Documentation',
]);

function unquoteUnitValue(raw) {
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try { return JSON.parse(raw); } catch { return raw.slice(1, -1); }
  }
  return raw;
}

/** One systemd command line, with its quoted arguments, split back into argv. */
function splitUnitArgs(value) {
  const args = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let match;
  while ((match = pattern.exec(String(value ?? ''))) !== null) {
    if (match[1] === undefined) args.push(match[2]);
    else {
      try { args.push(JSON.parse(`"${match[1]}"`)); } catch { args.push(match[1]); }
    }
  }
  return args;
}

/**
 * Parses the unit the way systemd does and returns every structural problem.
 *
 * A directive is only real when it is on its own line inside a section; text
 * after `#` is a comment and carries no meaning. That is exactly what the
 * 1.4.4-1.4.6 generator got wrong.
 */
function parseUnit(raw) {
  const problems = [];
  const sections = new Map();
  let section = null;

  const lines = String(raw).split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('#') || trimmed.startsWith(';')) {
      if (/(^|[^A-Za-z0-9_])[A-Za-z][A-Za-z0-9]*=/.test(trimmed)) {
        problems.push(`line ${lineNumber}: an assignment inside a comment is dead text`);
      }
      continue;
    }

    const header = /^\[([^\]]+)\]$/.exec(trimmed);
    if (header) {
      section = header[1];
      if (!sections.has(section)) sections.set(section, []);
      continue;
    }
    if (!section) {
      problems.push(`line ${lineNumber}: directive outside any section: ${trimmed}`);
      continue;
    }

    const assignment = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/.exec(trimmed);
    if (!assignment) {
      problems.push(`line ${lineNumber}: not Key=Value: ${trimmed}`);
      continue;
    }
    const [, key, value] = assignment;
    const expected = UNIT_SECTION.get(key);
    if (!expected) problems.push(`line ${lineNumber}: unknown directive ${key}`);
    else if (expected !== section) problems.push(`line ${lineNumber}: ${key} belongs in [${expected}], not in [${section}]`);
    sections.get(section).push([key, value]);
  }

  for (const [name, entries] of sections) {
    const seen = new Set();
    for (const [key] of entries) {
      if (REPEATABLE_KEYS.has(key)) continue;
      if (seen.has(key)) problems.push(`${key} appears twice in [${name}]`);
      seen.add(key);
    }
  }

  return { problems, sections };
}

function unitValues(sections, name, key) {
  return (sections.get(name) ?? []).filter(([entry]) => entry === key)
    .map(([, value]) => unquoteUnitValue(value));
}

function unitValue(sections, name, key) {
  return unitValues(sections, name, key)[0] ?? null;
}

/** Structural assertions on the unit the new code wrote. */
function unitIssues(raw, { dataDir, pinnedNode, expectedUser = null }) {
  const { problems, sections } = parseUnit(raw);
  const issues = [...problems];

  const service = sections.get('Service') ?? [];
  if (!service.some(([key]) => key === 'Environment')) issues.push('no Environment= in [Service]');

  const environment = new Map(unitValues(sections, 'Service', 'Environment').map((value) => {
    const equals = value.indexOf('=');
    return [value.slice(0, equals), value.slice(equals + 1)];
  }));
  for (const [name, value] of Object.entries({
    NODE_OPTIONS: '',
    NODE_PATH: '',
    WS_NO_BUFFER_UTIL: '1',
    WS_NO_UTF_8_VALIDATE: '1',
    NODE_ENV: 'production',
  })) {
    if (environment.get(name) !== value) issues.push(`Environment ${name}=${value} missing`);
  }
  const dataDirValue = environment.get('EASY_DEVOPS_DATA_DIR');
  if (dataDirValue !== undefined && dataDirValue !== dataDir) {
    issues.push(`EASY_DEVOPS_DATA_DIR is ${dataDirValue}, expected ${dataDir}`);
  }

  const argv = splitUnitArgs(unitValue(sections, 'Service', 'ExecStart') ?? '');
  if (argv[0] !== pinnedNode) issues.push(`ExecStart runs ${argv[0]}, expected the pinned ${pinnedNode}`);
  // A Node >= 18.19 / 20.6 gets `--import`, an older one the loader flag; both
  // are confinement, and the binary decides (lane E's daemonNodeArgs).
  const confined = argv.some((argument) => (
    argument.startsWith('--experimental-loader=') && argument.endsWith('runtime-loader.mjs'))
    || (argument === '--import' && String(argv[argv.indexOf(argument) + 1] ?? '').includes('runtime-register.mjs'))
    || (argument.startsWith('--import=') && argument.includes('runtime-register.mjs')));
  if (!confined) issues.push('ExecStart has no runtime confinement (--import or --experimental-loader)');
  if (!argv.includes(ENTRY)) issues.push(`ExecStart does not run ${ENTRY}`);
  if (argv.at(-1) !== 'daemon') issues.push('ExecStart does not end with `daemon`');
  if (!unitValue(sections, 'Service', 'User')) issues.push('no User= in [Service]');
  if (expectedUser && unitValue(sections, 'Service', 'User') !== expectedUser) {
    issues.push(`User is ${unitValue(sections, 'Service', 'User')}, expected ${expectedUser}`);
  }
  if (!unitValue(sections, 'Service', 'WorkingDirectory')) issues.push('no WorkingDirectory= in [Service]');
  if (!unitValues(sections, 'Install', 'WantedBy').includes('multi-user.target')) issues.push('no WantedBy=multi-user.target');
  return issues;
}

// --- The real fake icacls, through the real shell.runFile -------------------

const keyOf = (value) => {
  const resolved = path.resolve(String(value));
  return IS_WINDOWS ? resolved.toLowerCase() : resolved;
};

const DEFAULT_SDDL = 'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)'
  + '(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)S:(AU;FA;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;WD)';

function isDirPath(target) {
  try { return fs.statSync(target).isDirectory(); } catch { return false; }
}

/** The fixture's DACL seed, converted to the fake's state document shape. */
function seedStatePaths(fixture) {
  const seed = JSON.parse(fs.readFileSync(fixture.aclRecordsPath, 'utf8'));
  const ownerFor = (target) => (
    isDirPath(target) ? seed.owner?.folders ?? TRUSTEES.ADMINISTRATORS : seed.owner?.files ?? fixture.operator?.sid ?? 'S-1-5-21-1111111111-2222222222-3333333333-1001'
  );
  const paths = {};
  const put = (target, spec) => {
    paths[keyOf(target)] = {
      owner: spec.owner ?? ownerFor(target),
      inherit: spec.inherit !== false,
      explicit: (spec.aces ?? spec.explicit ?? []).map((entry) => ({
        trustee: entry.trustee,
        level: entry.level,
        flags: [...(entry.flags ?? [])],
      })),
    };
  };
  if (seed.dataRoot) put(fixture.dataDir, seed.dataRoot);
  for (const [name, spec] of Object.entries(seed.folders ?? {})) {
    put(path.join(fixture.dataDir, ...name.split('/')), spec);
  }
  for (const [name, spec] of Object.entries(seed.files ?? {})) {
    put(path.join(fixture.dataDir, ...name.split('/')), spec);
  }
  return { seed, paths };
}

/** Writes the daemon's own heartbeat: what a real start leaves behind. */
function writeDaemonLock(dataDir, version = TARGET_VERSION, pid = 9000 + Math.floor(Math.random() * 1000)) {
  fs.mkdirSync(dataDir, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(dataDir, 'daemon.lock'), `${JSON.stringify({
    pid,
    startedAt: now - 60_000,
    heartbeatAt: now,
    version,
    mode: 'daemon',
  }, null, 2)}\n`);
  return pid;
}

/**
 * One fixture's fake Windows system: a real `icacls.exe` fake over a real tree,
 * plus a stateful SCM and a stateful WinSW, both answering through `runFile`
 * and the legacy string `run` exactly where production asks them.
 */
function createWindowsWorld(fixtureOrBranch, options = {}) {
  const fixture = fixtureOrBranch.windows ?? fixtureOrBranch;
  const dir = path.join(TEST_DATA_DIR, 'upgrade-matrix', 'worlds');
  assertInsideTestDataDir(dir, 'create a fake Windows world');
  fs.mkdirSync(dir, { recursive: true });

  const { seed, paths } = seedStatePaths(fixture);
  const operator = fixture.operator ?? {
    sid: seed.owner?.files ?? 'S-1-5-21-1111111111-2222222222-3333333333-1001',
    name: 'EXAMPLE\\operator',
  };
  // C:\ProgramData's own ACL: SYSTEM and Administrators full control, Users
  // read & execute. Without it, an `icacls /reset` on the data folder would
  // read as an empty DACL, when in reality the reset restores exactly this.
  paths[keyOf(fixture.programData)] = {
    owner: TRUSTEES.ADMINISTRATORS,
    inherit: false,
    explicit: [
      { trustee: TRUSTEES.SYSTEM, level: 'F', flags: ['OI', 'CI'] },
      { trustee: TRUSTEES.ADMINISTRATORS, level: 'F', flags: ['OI', 'CI'] },
      { trustee: TRUSTEES.USERS, level: 'RX', flags: ['OI', 'CI'] },
    ],
  };
  const seededMtime = (() => {
    let latest = 0;
    for (const root of [fixture.binDir, fixture.runtimeRoot, fixture.runtimePrevRoot].filter(Boolean)) {
      for (const entry of walkEntries(root)) {
        try { latest = Math.max(latest, fs.statSync(entry).mtimeMs); } catch { /* removed already */ }
      }
    }
    return latest;
  })();
  const statePath = path.join(dir, `acl-${fixture.name ?? fixtureOrBranch.name ?? fixture.version}-${crypto.randomUUID()}.json`);
  const state = {
    version: 1,
    operator: { ...operator },
    serviceAccount: TRUSTEES.SERVICE,
    defaults: { folderOwner: TRUSTEES.ADMINISTRATORS, fileOwner: operator.sid },
    paths,
    watch: [fixture.binDir, fixture.runtimeRoot, fixture.dataDir,
      ...(fixture.runtimePrevRoot && fs.existsSync(fixture.runtimePrevRoot) ? [fixture.runtimePrevRoot] : [])],
    rules: {},
    calls: [],
    unknownVerbs: [],
    stats: {},
  };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  const sc = {
    registered: options.registered ?? fixture.serviceRegistered ?? false,
    state: (options.registered ?? fixture.serviceRegistered ?? false)
      ? (options.running === false ? 'STOPPED' : 'RUNNING')
      : 'MISSING',
    sddl: fixture.serviceDescriptor ?? DEFAULT_SDDL,
    writes: 0,
    wrapperRuns: 0,
  };

  const read = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));

  /**
   * Deletes/recreates a code folder in real Windows and the new files carry
   * fresh inherited ACLs. The fake keeps a record per path, so a record for a
   * path that is gone, or for a file rewritten after the fixture was seeded
   * (the runtime copy), would describe a file that no longer exists. Forget
   * those before every icacls call: the folder's own record still applies.
   * Only bin and runtime folders are reconciled; user data is never rewritten
   * here.
   */
  const codeRoots = [fixture.binDir, fixture.runtimeRoot, fixture.runtimePrevRoot].filter(Boolean);
  const forgetRecreatedCodeRecords = () => {
    const document = read();
    let changed = false;
    for (const key of Object.keys(document.paths ?? {})) {
      if (!codeRoots.some((root) => key.startsWith(keyOf(root)))) continue;
      let stat = null;
      try { stat = fs.statSync(key); } catch { stat = null; }
      if (!stat) {
        delete document.paths[key];
        changed = true;
        continue;
      }
      // A fresh file inherits; only a record that says "nothing, inherited
      // from nowhere" for a path rewritten after seeding is stale. Anything
      // the code wrote has an explicit ACE and is kept.
      const explicit = document.paths[key].explicit ?? [];
      if (stat.mtimeMs > seededMtime && explicit.length === 0) {
        delete document.paths[key];
        changed = true;
      }
    }
    if (changed) fs.writeFileSync(statePath, JSON.stringify(document));
  };

  const heartbeat = () => {
    world.heartbeat = writeDaemonLock(fixture.dataDir, options.heartbeatVersion ?? TARGET_VERSION);
    return world.heartbeat;
  };

  const scRun = (args) => {
    const verb = String(args[0] ?? '').toLowerCase();
    if (verb === 'query') {
      if (!sc.registered) {
        return {
          success: false,
          stdout: '',
          stderr: '[SC] EnumQueryServicesStatus:OpenService FAILED 1060:\r\n\r\nThe specified service does not exist as an installed service.\r\n',
          exitCode: 1060,
        };
      }
      return {
        success: true,
        stdout: `SERVICE_NAME: EasyDevOps\r\n        TYPE               : 10  WIN32_OWN_PROCESS\r\n        STATE              : 4  ${sc.state}\r\n`,
        stderr: '',
        exitCode: 0,
      };
    }
    if (verb === 'stop') {
      if (!sc.registered) return { success: false, stdout: '', stderr: 'FAILED 1060: does not exist', exitCode: 1060 };
      sc.state = 'STOPPED';
      return { success: true, stdout: '[SC] StopService SUCCESS\r\n', stderr: '', exitCode: 0 };
    }
    if (verb === 'start') {
      if (!sc.registered) return { success: false, stdout: '', stderr: 'FAILED 1060: does not exist', exitCode: 1060 };
      sc.state = 'RUNNING';
      heartbeat();
      return { success: true, stdout: '[SC] StartService SUCCESS\r\n', stderr: '', exitCode: 0 };
    }
    if (verb === 'delete') {
      sc.registered = false;
      sc.state = 'MISSING';
      return { success: true, stdout: '[SC] DeleteService SUCCESS\r\n', stderr: '', exitCode: 0 };
    }
    if (verb === 'sdshow') return { success: true, stdout: `${sc.sddl}\r\n`, stderr: '', exitCode: 0 };
    if (verb === 'sdset') {
      sc.sddl = String(args[2] ?? sc.sddl);
      sc.writes += 1;
      return { success: true, stdout: '[SC] SetServiceObjectSecurity SUCCESS\r\n', stderr: '', exitCode: 0 };
    }
    if (verb === 'showsid') {
      return {
        success: true,
        stdout: 'SERVICE SID : S-1-5-80-1111111111-2222222222-3333333333-4444444444-5555555555\r\n',
        stderr: '',
        exitCode: 0,
      };
    }
    if (verb === 'config' || verb === 'qc') return { success: true, stdout: '', stderr: '', exitCode: 0 };
    return { success: false, stdout: '', stderr: `unexpected sc.exe ${args.join(' ')}`, exitCode: 1 };
  };

  const winsw = (args) => {
    const verb = String(args[0] ?? '').toLowerCase();
    sc.wrapperRuns += 1;
    if (verb === 'install') {
      sc.registered = true;
      sc.state = 'STOPPED';
      return { success: true, stdout: 'Installed service EasyDevOps\r\n', stderr: '', exitCode: 0 };
    }
    if (verb === 'start') {
      sc.registered = true;
      sc.state = 'RUNNING';
      heartbeat();
      return { success: true, stdout: 'Started service EasyDevOps\r\n', stderr: '', exitCode: 0 };
    }
    if (verb === 'stop') {
      sc.state = 'STOPPED';
      return { success: true, stdout: 'Stopped service EasyDevOps\r\n', stderr: '', exitCode: 0 };
    }
    if (verb === 'status') return { success: true, stdout: `${sc.state}\r\n`, stderr: '', exitCode: 0 };
    if (verb === 'uninstall') {
      sc.registered = false;
      sc.state = 'MISSING';
      return { success: true, stdout: 'Uninstalled\r\n', stderr: '', exitCode: 0 };
    }
    return { success: false, stdout: '', stderr: `unexpected WinSW ${args.join(' ')}`, exitCode: 1 };
  };

  let icaclsQueue = Promise.resolve();

  const fakeIcacls = (args, options) => {
    // One fake process at a time. Production runs its status probes in
    // parallel, and the fake keeps its DACL model in one state file whose
    // temp name is fixed; two writers would corrupt it. The commands are still
    // issued concurrently by the code under test - only the fake serializes.
    const invoke = () => {
      forgetRecreatedCodeRecords();
      return modules.shell.runFile(process.execPath, [FAKE_ICACLS, ...args], {
        ...options,
        env: { ...(options?.env ?? {}), EZ_FAKE_ICACLS_STATE: statePath },
      });
    };
    const next = icaclsQueue.then(invoke, invoke);
    icaclsQueue = next.then(() => {}, () => {});
    return next;
  };

  /**
   * Real icacls applies every verb on one command line; the fake applies the
   * first one it finds. `icacls <dir> /inheritance:r /grant:r ...` is ONE call
   * in operator.js buildProtectCommands, so it is issued here as the same two
   * changes icacls makes, in the same order, against the same target.
   */
  const icaclsWithEveryVerb = async (args, options) => {
    const lower = args.map((argument) => String(argument).toLowerCase());
    const inheritance = lower.findIndex((argument) => argument === '/inheritance:r');
    const grant = lower.findIndex((argument) => argument === '/grant' || argument === '/grant:r');
    if (inheritance === -1 || grant === -1) return fakeIcacls(args, options);
    const target = args[0];
    const scope = args.filter((argument) => /^\/(?:L|Q|C|T)$/i.test(String(argument)));
    // Grant first, then drop inheritance: icacls's final state is the same, and
    // the folder is never empty between the two changes.
    const grantArgs = [target, ...args.slice(grant)];
    const inheritanceArgs = [target, '/inheritance:r', ...scope];
    const first = await fakeIcacls(grantArgs, options);
    const second = await fakeIcacls(inheritanceArgs, options);
    return {
      success: first.success && second.success,
      stdout: `${first.stdout ?? ''}${second.stdout ?? ''}`,
      stderr: `${first.stderr ?? ''}${second.stderr ?? ''}`,
      exitCode: (first.success && second.success) ? 0 : (second.exitCode ?? first.exitCode ?? 1),
    };
  };

  const runFile = async (file, args, options = {}) => {
    const exe = path.win32.basename(String(file)).toLowerCase();
    if (exe === 'icacls.exe') {
      return icaclsWithEveryVerb(args ?? [], options);
    }
    if (exe === 'sc.exe') return scRun(args ?? []);
    if (exe === 'powershell.exe') return { success: true, stdout: '', stderr: '', exitCode: 0 };
    try {
      if (keyOf(file) === keyOf(modules.windowsService.winswPath())) return winsw(args ?? []);
    } catch { /* programDataDir unavailable outside the fixture env: not a WinSW call */ }
    return {
      success: false,
      stdout: '',
      stderr: `unexpected executable: ${file} ${(args ?? []).join(' ')}`,
      exitCode: 1,
    };
  };

  const run = async (command) => {
    const text = String(command ?? '');
    if (/^sc\.exe /i.test(text)) {
      const args = text.replace(/^sc\.exe\s+/i, '').match(/"[^"]*"|\S+/g) ?? [];
      return scRun(args.map((argument) => argument.replace(/^"|"$/g, '')));
    }
    if (/IsInRole/.test(text)) return { success: true, stdout: 'True\r\n', stderr: '', exitCode: 0 };
    if (/WindowsIdentity\]::GetCurrent\(\)/.test(text)) {
      return {
        success: true,
        stdout: `${operator.sid}|${operator.name}\r\n`,
        stderr: '',
        exitCode: 0,
      };
    }
    if (/windowsEdition|ProductType|OperatingSystem/i.test(text)) {
      return { success: true, stdout: 'Server\r\n', stderr: '', exitCode: 0 };
    }
    if (/systemctl|journalctl/.test(text)) return { success: true, stdout: '', stderr: '', exitCode: 0 };
    return { success: false, stdout: '', stderr: `unexpected command: ${text}`, exitCode: 1 };
  };

  const world = {
    fixture: { ...fixture, operator },
    statePath,
    seed,
    sc,
    read,
    runFile,
    run,
    heartbeat: null,
  };
  return world;
}

// --- Reading the fake's DACL model ------------------------------------------

function defaultEntry(state, target) {
  return {
    owner: isDirPath(target) ? TRUSTEES.ADMINISTRATORS : state.defaults?.fileOwner ?? state.operator?.sid,
    inherit: true,
    explicit: [],
  };
}

/** Every ACE that applies to an object, exactly as the fake computes it. */
function effectiveAces(state, target) {
  const resolved = path.resolve(String(target));
  const directory = isDirPath(resolved);
  const entry = state.paths[keyOf(resolved)] ?? null;
  const aces = (entry?.explicit ?? []).map((ace) => ({ ...ace, flags: [...(ace.flags ?? [])], inherited: false }));

  if (!entry || entry.inherit !== false) {
    let current = path.dirname(resolved);
    const seen = new Set();
    while (current && !seen.has(current)) {
      seen.add(current);
      const ancestor = state.paths[keyOf(current)] ?? null;
      if (ancestor) {
        for (const ace of ancestor.explicit ?? []) {
          const flags = ace.flags ?? [];
          const applies = directory ? (flags.includes('CI') || flags.includes('OI')) : flags.includes('OI');
          if (applies) aces.push({ ...ace, flags: [...flags], inherited: true });
        }
        if (ancestor.inherit === false) break;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return aces;
}

function hasAce(aces, trustee, levels) {
  return aces.some((ace) => String(ace.trustee).toUpperCase() === trustee.toUpperCase()
    && levels.includes(ace.level));
}

/** Every entry under a protected root: non-empty, SYSTEM F, Administrators F, service RX. */
function codeRootIssues(state, root) {
  const issues = [];
  for (const entryPath of walkEntries(root)) {
    const aces = effectiveAces(state, entryPath);
    if (aces.length === 0) {
      issues.push(`${entryPath}: empty DACL`);
      continue;
    }
    if (!hasAce(aces, TRUSTEES.SYSTEM, ['F'])) issues.push(`${entryPath}: no SYSTEM full control`);
    if (!hasAce(aces, TRUSTEES.ADMINISTRATORS, ['F'])) issues.push(`${entryPath}: no Administrators full control`);
    if (!hasAce(aces, TRUSTEES.SERVICE, ['F', 'M', 'RX', 'R'])) issues.push(`${entryPath}: service cannot read and execute`);
  }
  return issues;
}

/** The DACL state a data file must keep: its own ACEs, owner and inheritance. */
function ownAclSnapshot(state, roots) {
  const rows = [];
  for (const root of roots) {
    for (const entryPath of walkEntries(root)) {
      const entry = state.paths[keyOf(entryPath)] ?? defaultEntry(state, entryPath);
      rows.push(`${entryPath}|${entry.owner}|${entry.inherit !== false}|${JSON.stringify(entry.explicit ?? [])}`);
    }
  }
  return rows.sort();
}

const FULL_ACE = (text, trustee) => text.toUpperCase().startsWith(`${trustee.toUpperCase()}:`) && /\(F\)$/.test(text);

/** SYSTEM and Administrators full control at every ACL the code recorded. */
function intermediateAclIssues(state) {
  const issues = [];
  let snapshots = 0;
  for (const call of state.calls ?? []) {
    for (const watched of call.snapshot ?? []) {
      snapshots += 1;
      const aces = watched.aces ?? [];
      if (!aces.some((text) => FULL_ACE(text, TRUSTEES.SYSTEM))) {
        issues.push(`seq ${call.seq} (${call.verb ?? 'listing'}${call.hasT ? '/T' : ''}): no SYSTEM full control`);
      }
      if (!aces.some((text) => FULL_ACE(text, TRUSTEES.ADMINISTRATORS))) {
        issues.push(`seq ${call.seq} (${call.verb ?? 'listing'}${call.hasT ? '/T' : ''}): no Administrators full control`);
      }
    }
  }
  return { issues, snapshots };
}

/** Calls whose first argument is exactly `target` (a folder command, not a tree). */
function callsAt(state, target) {
  return (state.calls ?? []).filter((call) => keyOf(call.args[0] ?? '') === keyOf(target));
}

function callsWithVerb(state, verb) {
  return (state.calls ?? []).filter((call) => call.verb === verb);
}

function describeCalls(state) {
  return (state.calls ?? []).map((call) => `${call.verb ?? 'listing'}${call.hasT ? '/T' : ''}`).join(' ');
}

// --- Driving the real commands ----------------------------------------------

/** A runtime copy that writes the shape the verification requires. */
function fakeCopyRuntime() {
  return ({ dataDir }) => {
    const dir = path.join(dataDir, 'runtime');
    const write = (relative, contents) => {
      const file = path.join(dir, ...relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents);
    };
    write(['node.exe'], `fake-node:${PIPELINED_NODE_VERSION}\n`);
    write(['package.json'], `${JSON.stringify({ name: 'easy-devops', version: TARGET_VERSION }, null, 2)}\n`);
    write(['app', 'package.json'], `${JSON.stringify({ name: 'easy-devops', version: TARGET_VERSION }, null, 2)}\n`);
    write(['app', 'src', 'cli', 'index.js'], '// the service runs this entrypoint\n');
    write(['app', 'src', 'core', 'service', 'runtime-register.mjs'], '// confinement entry\n');
    return {
      ok: true,
      dir,
      nodeExe: path.join(dir, 'node.exe'),
      entry: path.join(dir, 'app', 'src', 'cli', 'index.js'),
    };
  };
}

/** WinSW bytes for `downloadWinsw`; the hash check is injected as well. */
function fakeFetch() {
  const bytes = new TextEncoder().encode('fake-winsw-binary');
  return async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer });
}

/** Where a redirected %APPDATA% puts the Startup folder for this fixture. */
function startupDirFor(fixture) {
  if (fixture.windows.startupDir) return fixture.windows.startupDir;
  const appData = fixture.windows.appDataDir ?? path.join(fixture.root, 'AppData');
  return path.join(appData, ...STARTUP_RELATIVE);
}

/** Everything `core/service/index.js` needs so the real path runs off the fake. */
function windowsDeps(world, { startupDir } = {}) {
  const inner = {
    isWindows: true,
    isElevated: async () => true,
    canWrite: async () => true,
    verifyWinsw: async () => ({ ok: true, sha256: 'fixture' }),
    copyRuntime: fakeCopyRuntime(),
    verifyNativeModules: async () => ({
      ok: true,
      version: PIPELINED_NODE_VERSION,
      abi: Number(process.versions.modules),
      reason: null,
      fix: '',
    }),
  };
  return {
    edition: 'server',
    run: world.run,
    runFile: world.runFile,
    isElevated: async () => true,
    resolveOperator: async () => world.fixture.operator,
    repairPrivateKeys: async () => {},
    isPidAlive: () => false,
    // The suite's own connection lives at the run's data root; the fixture data
    // directory is an env override, so closing and reopening here would open
    // the fixture's synthetic database. Installing a real service reopens the
    // live one; this harness has nothing to reopen.
    closeDb: () => {},
    reopenDb: () => {},
    ...(startupDir ? { startupDir } : {}),
    windowsServiceOpts: {
      run: world.run,
      runFile: world.runFile,
      fetchImpl: fakeFetch(),
      config: { nginxDir: null, sslDir: null },
      deps: inner,
    },
  };
}

async function runWindowsRepair(world, fixture) {
  return asWindowsFixture(fixture, () => modules.service.repair({
    log: () => {},
    deps: windowsDeps(world, { startupDir: startupDirFor(fixture) }),
  }));
}

async function runWindowsInstall(world, fixture, leftoverChoice, { dataDirEnv } = {}) {
  return asWindowsFixture(fixture, () => modules.service.install({
    mode: 'server',
    ...(leftoverChoice ? { leftoverChoice } : {}),
    log: () => {},
    deps: windowsDeps(world, { startupDir: startupDirFor(fixture) }),
  }), { dataDirEnv });
}

/** `ezz service recover`, Windows: the CLI's own order (interrupted update,
 *  permissions, ordinary repair), driven through the same injected system. */
async function runWindowsRecover(world, fixture) {
  return asWindowsFixture(fixture, async () => {
    const recovered = await modules.windowsService.recoverCodePermissions({
      run: world.run,
      runFile: world.runFile,
      operator: world.fixture.operator,
      dataDir: fixture.windows.dataDir,
      log: () => {},
    });
    if (!recovered.ok) return recovered;
    return modules.service.repair({
      log: () => {},
      deps: windowsDeps(world, { startupDir: fixture.windows.startupDir }),
    });
  });
}

/**
 * The assertions every state ends with, read from the final fake state.
 *
 * @returns {{ ok: boolean, detail: string }}
 */
function assertFinalState(name, world, options = {}) {
  const { userDataBefore, userDataAfter = userDataBefore, roots, expectRegistered = true } = options;
  const fixture = world.fixture;
  const state = world.read();
  const failed = [];

  const registered = world.sc.registered === true;
  const running = world.sc.state === 'RUNNING';
  if (expectRegistered) {
    check(`${name}: the service is registered and running`, registered && running,
      `registered=${world.sc.registered} state=${world.sc.state}`);
    if (!(registered && running)) failed.push('service');
  } else {
    check(`${name}: the service is not registered`, registered === false, String(world.sc.registered));
  }

  let heartbeat = null;
  try {
    heartbeat = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, 'daemon.lock'), 'utf8')).version;
  } catch { /* reported below */ }
  check(`${name}: the daemon heartbeat reports ${TARGET_VERSION} (the CLI under test)`,
    heartbeat === TARGET_VERSION, String(heartbeat));
  if (heartbeat !== TARGET_VERSION) failed.push('heartbeat');

  const codeRoots = (roots ?? [fixture.binDir, fixture.runtimeRoot])
    .filter((dir) => dir && fs.existsSync(dir));
  const aclIssues = codeRoots.flatMap((root) => codeRootIssues(state, root));
  check(`${name}: every file under bin and runtime is readable by SYSTEM, Administrators and the service account`,
    aclIssues.length === 0, aclIssues.slice(0, 3).join('; '));
  if (aclIssues.length) failed.push('acl');

  const intermediate = intermediateAclIssues(state);
  check(`${name}: SYSTEM and Administrators kept full control at every recorded ACL write`,
    intermediate.issues.length === 0 && intermediate.snapshots > 0,
    intermediate.issues.length ? intermediate.issues.slice(0, 3).join('; ') : `${intermediate.snapshots} snapshot(s)`);
  if (intermediate.issues.length) failed.push('intermediate');

  check(`${name}: the service descriptor still grants SYSTEM and Administrators full control`,
    modules.operator.missingServiceDefaults(world.sc.sddl).length === 0
      && world.sc.writes >= 1,
    `${world.sc.writes} write(s), missing=${modules.operator.missingServiceDefaults(world.sc.sddl).join(',') || 'none'}`);
  if (modules.operator.missingServiceDefaults(world.sc.sddl).length > 0) failed.push('descriptor');

  check(`${name}: not one byte of user data changed`,
    sameRows(userDataBefore, userDataAfter), `${userDataAfter.length} file(s)`);
  if (!sameRows(userDataBefore, userDataAfter)) failed.push('data');

  const startup = fixture.startupDir;
  if (startup) {
    check(`${name}: no Startup file is left on a Server edition`,
      !fs.existsSync(path.join(startup, PERSONAL_LAUNCHER_FILE)));
    if (fs.existsSync(path.join(startup, PERSONAL_LAUNCHER_FILE))) failed.push('startup');
  }

  return { ok: failed.length === 0, detail: failed.length ? failed.join(',') : `${intermediate.snapshots} ACL writes verified` };
}

// --- 1. Fixture integrity ---------------------------------------------------

async function testFixtureIntegrity(fixtures) {
  setGroup('1. the historical fixtures reproduce what 1.4.0-1.4.6 left behind');

  check('all four required historical versions are present',
    fixtures.map((fixture) => fixture.version).join(',') === HISTORICAL_VERSIONS.join(','));

  for (const fixture of fixtures) {
    const unit = fs.readFileSync(fixture.linux.unitPath, 'utf8');
    const xml = fs.readFileSync(fixture.windows.xmlPath, 'utf8');
    const acl = JSON.parse(fs.readFileSync(fixture.windows.aclRecordsPath, 'utf8'));
    const operator = JSON.parse(fs.readFileSync(fixture.windows.operatorRecordPath, 'utf8'));
    const runtimePackage = JSON.parse(
      fs.readFileSync(path.join(fixture.windows.runtimeRoot, 'app', 'package.json'), 'utf8'),
    );

    check(`${fixture.version}: the Linux unit is the one that version left`,
      fixture.linux.unitVariant === 'legacy'
        ? !unit.includes('runtime-loader.mjs') && !unit.includes('runtime-register.mjs')
        : unit.includes('[Service]') && /runtime-(?:loader|register)\.mjs/.test(unit),
      fixture.linux.unitVariant);

    if (fixture.version === '1.4.6') {
      const parsed = parseUnit(unit);
      check(`${fixture.version}: 1.4.6's Environment= line sits inside [Unit], not in a comment`,
        unit.includes(`${MALFORMED_UNIT_LINE}\n`)
          && unitValues(parsed.sections, 'Unit', 'Environment').length === 2,
        MALFORMED_UNIT_LINE);
    }
    if (fixture.version === '1.4.3') {
      check(`${fixture.version}: the well-formed 1.4.3 unit really parses`,
        parseUnit(unit).problems.length === 0, parseUnit(unit).problems.join('; '));
    }

    check(`${fixture.version}: the WinSW XML is the one that version left`,
      fixture.windows.xmlVariant === 'malformed' ? !xml.includes('</service>') : xml.includes('</service>'),
      fixture.windows.xmlVariant);

    check(`${fixture.version}: the empty DACLs under bin/ and runtime/ are seeded for the files that lost them`,
      acl.emptyDacls === fixture.windows.emptyAcl
        && fixture.windows.probeFiles.every((relative) => {
          const spec = acl.files[relative];
          return spec && spec.aces.length === 0 && spec.inherit === !fixture.windows.emptyAcl;
        }),
      `${fixture.windows.probeFiles.length} probe files, empty=${acl.emptyDacls}`);

    check(`${fixture.version}: the folders, the marker and the operator record are complete`,
      Object.keys(acl.folders).includes('bin') && Object.keys(acl.folders).includes('runtime')
        && fs.existsSync(fixture.windows.markerPath)
        && Boolean(operator.operator?.sid)
        && Boolean(operator.service?.sddl?.startsWith('D:')),
      Object.keys(acl.folders).join(','));

    check(`${fixture.version}: the runtime copy is older than the installed package`,
      runtimePackage.version === fixture.windows.runtimeVersion
        && runtimePackage.version !== TARGET_VERSION,
      `${runtimePackage.version} vs package ${TARGET_VERSION}`);

    check(`${fixture.version}: a stale stop request and a recorded stop timestamp are both present`,
      fs.existsSync(fixture.linux.stopRequestPath)
        && Boolean(JSON.parse(fs.readFileSync(fixture.linux.stopRequestPath, 'utf8')).at)
        && Boolean(JSON.parse(fs.readFileSync(fixture.linux.serviceStatePath, 'utf8')).stoppedAt)
        && fs.existsSync(fixture.windows.stopRequestPath)
        && Boolean(JSON.parse(fs.readFileSync(fixture.windows.serviceStatePath, 'utf8')).stoppedAt));

    const required = ['easy-devops.sqlite', 'easy-devops.sqlite-wal', 'settings.json',
      'certs/example.com/fullchain.pem', 'certs/example.com/privkey.pem',
      'nginx/sites/example.com.conf', 'deploy/blog/current.json'];
    check(`${fixture.version}: the database, settings, certificate, nginx config and deploy are present`,
      required.every((relative) => fs.existsSync(path.join(fixture.linux.dataDir, ...relative.split('/'))))
        && required.every((relative) => fs.existsSync(path.join(fixture.windows.dataDir, ...relative.split('/')))),
      required.length);

    check(`${fixture.version}: only 1.4.6 carries the runtime.prev left by the failed update`,
      fixture.windows.runtimePrevRoot
        ? (fixture.version === '1.4.6' && fs.existsSync(fixture.windows.runtimePrevRoot))
        : fixture.version !== '1.4.6');
  }
}

// --- Linux: post-update and recover -----------------------------------------

/** The `sudo` runner: install copies the staged file, systemctl is accepted. */
function unitCopyRunner(calls) {
  const copyUnit = (args) => {
    const dash = args.indexOf('--');
    if (dash === -1) return false;
    fs.copyFileSync(args[dash + 1], args[dash + 2]);
    fs.chmodSync(args[dash + 2], 0o600);
    return true;
  };
  const runner = async (file, args) => {
    calls.push([file, ...args]);
    const direct = file === 'sudo' ? args[0] : file;
    const rest = file === 'sudo' ? args.slice(1) : args;
    if (direct === 'systemctl') return { success: true, stdout: '', stderr: '', exitCode: 0 };
    if (direct === 'install' || direct === 'cp') {
      if (copyUnit(rest)) return { success: true, stdout: '', stderr: '', exitCode: 0 };
    }
    return { success: false, stdout: '', stderr: `unexpected runner: ${file} ${args.join(' ')}`, exitCode: 1 };
  };
  runner.calls = calls;
  return runner;
}

function unitRunner(calls) {
  return async (command) => {
    calls.push([String(command)]);
    if (/systemctl|journalctl/.test(String(command))) {
      return { success: true, stdout: '', stderr: '', exitCode: 0, command };
    }
    return { success: false, stdout: '', stderr: `unexpected command: ${command}`, exitCode: 1 };
  };
}

async function testLinuxPostUpdate(fixtures) {
  setGroup('2. Linux: the new post-update writes a valid unit over every historical one');

  for (const fixture of fixtures) {
    const before = hashUserData(fixture.linux.userDataPaths);
    const historical = fs.readFileSync(fixture.linux.unitPath, 'utf8');
    const calls = [];

    const result = await withEnv({ EASY_DEVOPS_DATA_DIR: fixture.linux.dataDir }, () => modules.postUpdate.applyPostUpdate({
      dataDir: fixture.linux.dataDir,
      mechanism: 'systemd',
      targetVersion: TARGET_VERSION,
      deps: {
        installedPackageVersion: () => TARGET_VERSION,
        refreshUnit: (options) => modules.systemd.refreshUnit({
          ...options,
          dataDir: fixture.linux.dataDir,
          unitPath: fixture.linux.unitPath,
          fileRunner: unitCopyRunner(calls),
          interactive: unitRunner(calls),
        }),
      },
    }));

    const written = fs.readFileSync(fixture.linux.unitPath, 'utf8');
    const parsed = parseUnit(written);
    const issues = unitIssues(written, {
      dataDir: fixture.linux.dataDir,
      pinnedNode: modules.runtime.runtimeNodePath(fixture.linux.dataDir),
    });

    check(`${fixture.version}: post-update succeeds`, result.ok === true, result.reason ?? '');
    check(`${fixture.version}: the unit is generated from the template, not edited in place`,
      !written.includes(MALFORMED_UNIT_LINE) && !written.includes('# Environment='),
      fixture.linux.unitVariant);
    check(`${fixture.version}: every directive is in its section and Environment= only in [Service]`,
      issues.length === 0, issues.slice(0, 3).join('; '));
    check(`${fixture.version}: the unit keeps the account it ran as`,
      unitValue(parsed.sections, 'Service', 'User') === 'root',
      String(unitValue(parsed.sections, 'Service', 'User')));
    check(`${fixture.version}: operator resource tuning survives the rewrite`,
      fixture.linux.unitVariant === 'legacy'
        || unitValue(parsed.sections, 'Service', 'LimitNOFILE') === '65535',
      String(unitValue(parsed.sections, 'Service', 'LimitNOFILE')));
    check(`${fixture.version}: the previous unit is kept beside it for a manual rollback`,
      fs.existsSync(`${fixture.linux.unitPath}.prev`)
        && fs.readFileSync(`${fixture.linux.unitPath}.prev`, 'utf8') === historical);
    // The orchestrator's note: post-update now CLEARS a stale daemon.stop on
    // purpose, so the start that follows cannot race a request nobody wants.
    check(`${fixture.version}: post-update clears the stale stop request`,
      !fs.existsSync(fixture.linux.stopRequestPath));
    check(`${fixture.version}: not one byte of user data changed`,
      sameRows(before, hashUserData(fixture.linux.userDataPaths)));
  }
}

async function testLinuxRecover(fixtures) {
  setGroup('3. Linux: recoverService rewrites the unit, clears the stop request and waits for the daemon');

  for (const fixture of fixtures) {
    const before = hashUserData(fixture.linux.userDataPaths);
    const historical = fs.readFileSync(fixture.linux.unitPath, 'utf8');
    const calls = [];
    const waits = [];

    const result = await withEnv({ EASY_DEVOPS_DATA_DIR: fixture.linux.dataDir }, () => modules.systemd.recoverService({
      dataDir: fixture.linux.dataDir,
      entry: ENTRY,
      unitPath: fixture.linux.unitPath,
      deps: {
        isRoot: () => false,
        linkRuntime: async () => ({
          ok: true,
          link: modules.runtime.runtimeNodePath(fixture.linux.dataDir),
          target: process.execPath,
        }),
      },
      run: unitRunner(calls),
      runFile: unitCopyRunner(calls),
      waitForDaemon: async ({ dataDir, timeoutMs }) => {
        writeDaemonLock(dataDir, TARGET_VERSION);
        waits.push(timeoutMs);
        return { alive: true, waitedMs: 5, lock: { pid: process.pid, version: TARGET_VERSION } };
      },
    }));

    const written = fs.readFileSync(fixture.linux.unitPath, 'utf8');
    const issues = unitIssues(written, {
      dataDir: fixture.linux.dataDir,
      pinnedNode: modules.runtime.runtimeNodePath(fixture.linux.dataDir),
    });

    check(`${fixture.version}: recovery succeeds`, result.ok === true, result.reason ?? '');
    check(`${fixture.version}: recovery wrote a structurally valid unit`,
      issues.length === 0, issues.slice(0, 3).join('; '));
    check(`${fixture.version}: the historical unit is preserved as <unit>.prev`,
      fs.readFileSync(`${fixture.linux.unitPath}.prev`, 'utf8') === historical);
    check(`${fixture.version}: the generated unit is installed through the one file write`,
      calls.some((call) => call.includes('install') && call.includes('--')),
      calls.map((call) => call.slice(0, 3).join(' ')).join(' | '));
    check(`${fixture.version}: daemon-reload and restart are both issued`,
      calls.some((call) => call.includes('daemon-reload')) && calls.some((call) => call.includes('restart')));
    check(`${fixture.version}: the daemon's own heartbeat is awaited (not systemctl's word)`,
      waits.length === 1 && result.pid === process.pid, String(waits[0]));
    check(`${fixture.version}: the stale stop request is cleared, so the daemon cannot exit at once`,
      !fs.existsSync(fixture.linux.stopRequestPath));
    check(`${fixture.version}: recovery does not change one byte of user data`,
      sameRows(before, hashUserData(fixture.linux.userDataPaths)));
  }
}

// --- Windows: post-update ---------------------------------------------------

async function testWindowsPostUpdate(fixtures) {
  setGroup('4. Windows: post-update refreshes the runtime and protects bin/ and runtime/ for real');

  if (!IS_WINDOWS) {
    skip('Windows post-update and its ACL transaction', 'skipped on Linux; the Windows code paths need a real win32 host');
    return;
  }

  for (const fixture of fixtures) {
    const before = hashUserData(fixture.windows.userDataPaths);
    const runtimePackage = path.join(fixture.windows.runtimeRoot, 'app', 'package.json');
    const detected = JSON.parse(fs.readFileSync(runtimePackage, 'utf8')).version;
    const order = [];
    const world = createWindowsWorld(fixture, { registered: true, running: true });
    const ownBefore = ownAclSnapshot(world.read(), fixture.windows.userDataPaths);
    const dataRootBefore = JSON.stringify((world.read().paths[keyOf(fixture.windows.dataDir)] ?? { explicit: [] }).explicit);

    const applied = await asWindowsFixture(fixture, () => modules.postUpdate.applyPostUpdate({
      dataDir: fixture.windows.dataDir,
      mode: 'server',
      mechanism: 'winsw',
      targetVersion: TARGET_VERSION,
      nodeExe: path.join(fixture.windows.runtimeRoot, 'node.exe'),
      deps: {
        installedPackageVersion: () => TARGET_VERSION,
        copyRuntime: (options) => {
          order.push('copy');
          return fakeCopyRuntime()(options);
        },
        verifyNativeModules: async () => {
          order.push('native');
          return { ok: true, version: PIPELINED_NODE_VERSION, abi: Number(process.versions.modules), detail: 'fixture native module' };
        },
        protectServiceFiles: (options) => {
          order.push('protect');
          return modules.operator.protectServiceFiles({ ...options, runFile: world.runFile });
        },
        refreshServiceDefinition: (options) => {
          order.push('definition');
          modules.windowsService.refreshServiceDefinition(options);
        },
      },
    }));

    const state = world.read();
    const xml = fs.readFileSync(fixture.windows.xmlPath, 'utf8');
    const refreshed = JSON.parse(fs.readFileSync(runtimePackage, 'utf8')).version;
    const runtimeIssues = codeRootIssues(state, fixture.windows.runtimeRoot);
    const binIssues = codeRootIssues(state, fixture.windows.binDir);
    const dataRootAfter = JSON.stringify((state.paths[keyOf(fixture.windows.dataDir)] ?? { explicit: [] }).explicit);

    check(`${fixture.version}: post-update succeeds`, applied.ok === true, applied.reason ?? '');
    check(`${fixture.version}: the older runtime copy is detected and refreshed to the package version`,
      detected !== TARGET_VERSION && refreshed === TARGET_VERSION,
      `${detected} -> ${refreshed}`);
    check(`${fixture.version}: copy, native proof, protection and definition run in that order`,
      order.join(',') === 'copy,native,protect,definition', order.join(' -> '));
    check(`${fixture.version}: the WinSW XML is well formed and points at the new runtime and the entry`,
      xml.startsWith('<service>') && xml.trimEnd().endsWith('</service>')
        && /runtime-(?:register|loader)\.mjs/.test(xml)
        && xml.includes(path.join(fixture.windows.runtimeRoot, 'node.exe'))
        && xml.includes(fixture.windows.dataDir),
      fixture.windows.xmlVariant);
    check(`${fixture.version}: every file under runtime has SYSTEM F, Administrators F and the service RX`,
      runtimeIssues.length === 0, runtimeIssues.slice(0, 2).join('; '));
    check(`${fixture.version}: every file under bin has SYSTEM F, Administrators F and the service RX`,
      binIssues.length === 0, binIssues.slice(0, 2).join('; '));
    check(`${fixture.version}: protection was not rolled back (no /restore ran)`,
      callsWithVerb(state, '/restore').length === 0);
    check(`${fixture.version}: post-update neither resets nor grants on the data root`,
      dataRootAfter === dataRootBefore && callsAt(state, fixture.windows.dataDir).length === 0,
      describeCalls(state));
    check(`${fixture.version}: no user-data file's own DACL changed`,
      ownBefore.length > 0 && sameRows(ownBefore, ownAclSnapshot(state, fixture.windows.userDataPaths)));
    check(`${fixture.version}: no user-data byte changed`,
      sameRows(before, hashUserData(fixture.windows.userDataPaths)));
    check(`${fixture.version}: post-update clears the stale stop request`,
      !fs.existsSync(fixture.windows.stopRequestPath));
  }
}

// --- Windows: recover -------------------------------------------------------

async function testWindowsRecover(fixtures) {
  setGroup('5. Windows: recover restores the empty DACLs and keeps SYSTEM and Administrators');

  if (!IS_WINDOWS) {
    skip('Windows recoverCodePermissions', 'skipped on Linux; the Windows code paths need a real win32 host');
    return;
  }

  for (const fixture of fixtures) {
    const before = hashUserData(fixture.windows.userDataPaths);
    const world = createWindowsWorld(fixture, { registered: true, running: true });
    const dataRootBefore = JSON.parse(JSON.stringify(
      (world.read().paths[keyOf(fixture.windows.dataDir)] ?? { explicit: [] }).explicit,
    ));
    const ownBefore = ownAclSnapshot(world.read(), fixture.windows.userDataPaths);

    const recovered = await asWindowsFixture(fixture, () => modules.windowsService.recoverCodePermissions({
      run: world.run,
      runFile: world.runFile,
      operator: fixture.windows.operator,
      dataDir: fixture.windows.dataDir,
      log: () => {},
    }));

    const state = world.read();
    const roots = [fixture.windows.binDir, fixture.windows.runtimeRoot, fixture.windows.runtimePrevRoot]
      .filter(Boolean);
    const issues = roots.flatMap((root) => codeRootIssues(state, root));
    const dataRootCalls = callsAt(state, fixture.windows.dataDir);
    const dataRootAfter = (state.paths[keyOf(fixture.windows.dataDir)] ?? { explicit: [] }).explicit;
    const operatorState = modules.operator.operatorAceState(world.sc.sddl, fixture.windows.operator.sid);

    check(`${fixture.version}: recover finishes on an elevated administrator`,
      recovered.ok === true, recovered.reason ?? '');
    check(`${fixture.version}: every empty DACL is gone: SYSTEM F, Administrators F, service RX`,
      issues.length === 0, issues.slice(0, 3).join('; '));
    check(`${fixture.version}: a refused /reset takes ownership first (the A1 condition)`,
      fixture.windows.emptyAcl === false
        ? !((state.calls ?? []).some((call) => call.verb === '/reset' && (call.refused ?? []).length))
        : (state.calls ?? []).some((call) => call.verb === '/reset' && (call.refused ?? []).length)
          && (state.calls ?? []).some((call) => call.args.includes('/setowner') && call.hasT),
      describeCalls(state));
    check(`${fixture.version}: recover never restored a saved tree (nothing failed half way)`,
      callsWithVerb(state, '/restore').length === 0);
    check(`${fixture.version}: the data root got one additive grant and nothing else`,
      dataRootCalls.length === 1
        && dataRootCalls[0].verb === '/grant'
        && dataRootCalls[0].hasT === false,
      dataRootCalls.map((call) => `${call.verb}${call.hasT ? '/T' : ''}`).join(','));
    check(`${fixture.version}: that grant only added SYSTEM and Administrators full control`,
      hasAce(dataRootAfter, TRUSTEES.SYSTEM, ['F'])
        && hasAce(dataRootAfter, TRUSTEES.ADMINISTRATORS, ['F'])
        && dataRootBefore.every((ace) => dataRootAfter.some((now) =>
          now.trustee === ace.trustee && now.level === ace.level))
        && dataRootAfter.length <= dataRootBefore.length + 2,
      `${dataRootBefore.length} -> ${dataRootAfter.length}`);
    check(`${fixture.version}: no data file lost an ACE or had its own DACL rewritten`,
      ownBefore.length > 0 && sameRows(ownBefore, ownAclSnapshot(state, fixture.windows.userDataPaths)));
    check(`${fixture.version}: recovery issued no command against a data file`,
      (state.calls ?? []).every((call) => !fixture.windows.userDataPaths
        .some((entry) => keyOf(call.args[0] ?? '').startsWith(keyOf(entry)))),
      describeCalls(state));
    check(`${fixture.version}: the descriptor the code wrote keeps SYSTEM and Administrators full control`,
      world.sc.writes >= 1 && modules.operator.missingServiceDefaults(world.sc.sddl).length === 0,
      modules.operator.missingServiceDefaults(world.sc.sddl).join(',') || 'ok');
    check(`${fixture.version}: the installing account keeps start/stop/query and nothing more`,
      operatorState.granted === true && operatorState.excessive === false,
      JSON.stringify(operatorState));
    check(`${fixture.version}: not one byte of user data changed`,
      sameRows(before, hashUserData(fixture.windows.userDataPaths)));
  }
}

// --- Windows: Server with no service: not_installed, then install ----------

async function testWindowsNoServiceThenInstall(fixtures) {
  setGroup('6. Windows Server with no service: repair/start say not_installed, install is the one command');

  if (!IS_WINDOWS) {
    skip('Windows Server not-installed path and install', 'skipped on Linux; the Windows code paths need a real win32 host');
    return;
  }

  for (const fixture of fixtures) {
    const before = hashUserData(fixture.windows.userDataPaths);
    const world = createWindowsWorld(fixture, { registered: false, running: false });
    const deps = windowsDeps(world);

    const repaired = await asWindowsFixture(fixture, () => modules.service.repair({ log: () => {}, deps }));
    const started = await asWindowsFixture(fixture, () => modules.service.start({ log: () => {}, deps }));

    check(`${fixture.version}: repair on an uninstalled Server says not_installed, never the Personal launcher`,
      repaired.ok === false && repaired.code === 'not_installed'
        && String(repaired.message ?? '').includes('ezz service install')
        && !world.sc.wrapperRuns,
      repaired.message ?? repaired.reason ?? '');
    check(`${fixture.version}: start on an uninstalled Server says not_installed`,
      started.ok === false && started.code === 'not_installed'
        && String(started.message ?? '').includes('ezz service install'),
      started.message ?? started.reason ?? '');

    const installed = await runWindowsInstall(world, fixture);

    check(`${fixture.version}: install is the one command and succeeds`, installed.ok === true,
      installed.reason ?? '');
    check(`${fixture.version}: it registered and started the real service`, world.sc.registered && world.sc.state === 'RUNNING',
      `${world.sc.registered}/${world.sc.state}`);
    check(`${fixture.version}: the runtime copy is now the CLI under test`,
      JSON.parse(fs.readFileSync(path.join(fixture.windows.runtimeRoot, 'app', 'package.json'), 'utf8')).version
        === TARGET_VERSION);
    check(`${fixture.version}: install leaves no progress record behind`,
      !fs.existsSync(path.join(fixture.windows.dataDir, INSTALL_PROGRESS_FILE)));
    check(`${fixture.version}: no Startup file is written on a Server edition`,
      !fs.existsSync(path.join(startupDirFor(fixture), PERSONAL_LAUNCHER_FILE)));

    const state = world.read();
    const aclIssues = [fixture.windows.binDir, fixture.windows.runtimeRoot]
      .flatMap((root) => codeRootIssues(state, root));
    check(`${fixture.version}: after install every code file is readable by SYSTEM, Administrators and the service`,
      aclIssues.length === 0, aclIssues.slice(0, 3).join('; '));
    const intermediate = intermediateAclIssues(state);
    check(`${fixture.version}: SYSTEM and Administrators never lost full control during install`,
      intermediate.issues.length === 0 && intermediate.snapshots > 0,
      intermediate.issues.slice(0, 3).join('; ') || `${intermediate.snapshots} snapshot(s)`);
    check(`${fixture.version}: install did not change one byte of user data`,
      sameRows(before, hashUserData(fixture.windows.userDataPaths)));

    const heartbeat = (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(fixture.windows.dataDir, 'daemon.lock'), 'utf8')).version;
      } catch { return null; }
    })();
    check(`${fixture.version}: the daemon heartbeat reports ${TARGET_VERSION}`,
      heartbeat === TARGET_VERSION, String(heartbeat));
    stateLine(`1.4.x ${fixture.version} Windows Server install`, installed.ok === true
      && world.sc.registered === true && heartbeat === TARGET_VERSION
      && aclIssues.length === 0 && intermediate.issues.length === 0,
      `install from ${fixture.version}, service running on ${TARGET_VERSION}`);
  }
}

// --- A5: "stopped by you" is live state only --------------------------------

async function testStopRequestSemantics(fixtures) {
  setGroup('7. A5: "stopped by you" comes from the live request, never a recorded stop');

  for (const fixture of fixtures) {
    const branch = IS_WINDOWS ? fixture.windows : fixture.linux;
    const mechanism = IS_WINDOWS
      ? { platform: 'windows', mode: 'server', mechanism: 'winsw' }
      : { platform: 'linux', mode: null, mechanism: 'systemd' };
    const deps = { mechanism, fs: { lstatSync: () => ({}) } };
    const stopFile = branch.stopRequestPath;
    const lock = path.join(branch.dataDir, 'daemon.lock');

    // The historical record: a stoppedAt in service-state, which 1.4.6 read as
    // current state while the service was actually running.
    modules.db.dbSet('service-state', {
      mode: 'server',
      stoppedAt: '2026-11-25T16:28:00.000Z',
      installedAt: '2026-11-24T15:30:00.000Z',
    });
    fs.rmSync(lock, { force: true });
    // A fresh live request: earlier groups legitimately clear the fixture's
    // own one (post-update and every start path now do), so this group creates
    // the state it is about instead of borrowing it.
    fs.mkdirSync(branch.dataDir, { recursive: true });
    fs.writeFileSync(stopFile, `${JSON.stringify({
      at: '2026-11-25T16:28:00.000Z',
      by: process.pid,
      reason: 'fixture: the user asked for a stop',
    }, null, 2)}\n`);

    const live = modules.service.backgroundServiceState({ dataDir: branch.dataDir, deps });
    writeDaemonLock(branch.dataDir, TARGET_VERSION);
    const running = modules.service.backgroundServiceState({ dataDir: branch.dataDir, deps });

    check(`${fixture.version}: a live request with no daemon still reads as "stopped by you"`,
      live.stoppedByUser === true && Boolean(live.stoppedAt), String(live.stoppedAt));
    check(`${fixture.version}: a running daemon is never "stopped by you", whatever service-state says`,
      running.running === true && running.stoppedByUser === false && running.stoppedAt === null);
    check(`${fixture.version}: taking the lock clears the recorded stop timestamp`,
      (modules.db.dbGet('service-state')?.stoppedAt ?? null) === null);

    modules.service.clearServiceStopState({ dataDir: branch.dataDir, deps: {} });
    check(`${fixture.version}: a start path clears the request and the live state`,
      !fs.existsSync(stopFile)
        && modules.service.backgroundServiceState({ dataDir: branch.dataDir, deps }).stoppedByUser === false);
    fs.rmSync(lock, { force: true });
  }
}

// --- The update handoff -----------------------------------------------------

function updateServiceStub({ mode, mechanism, order }) {
  let starts = 0;
  return {
    heartbeats: [],
    async status() {
      order.push('status');
      return { service: { installed: true }, mode, mechanism };
    },
    recordedState() {
      return { nodeExe: process.execPath };
    },
    async stop() {
      order.push('stop');
      return { ok: true };
    },
    async start() {
      starts += 1;
      order.push('start');
      return { ok: true, pid: 12000 + starts };
    },
    async waitForDaemon() {
      order.push('wait');
      this.heartbeats.push(TARGET_VERSION);
      return { alive: true, waitedMs: 50, lock: { version: TARGET_VERSION } };
    },
  };
}

function recordingNpm({ order, targetVersion }) {
  return async (file, args) => {
    const normalized = file === process.execPath ? args.slice(1) : args;
    if (file === process.execPath && path.basename(args[0]) !== 'npm-cli.js') {
      return { success: false, stdout: '', stderr: `unexpected executable: ${args[0]}` };
    }
    if (normalized[0] !== 'install' || normalized[1] !== '-g') {
      return { success: false, stdout: '', stderr: `unexpected npm args: ${normalized.join(' ')}` };
    }
    if (normalized[2] === `easy-devops@${targetVersion}`) order.push('npm-new');
    else if (normalized[2].startsWith('easy-devops@')) order.push('npm-old');
    else return { success: false, stdout: '', stderr: `unexpected package: ${normalized[2]}` };
    return { success: true, stdout: 'installed', stderr: '', exitCode: 0 };
  };
}

async function testHandoffOrder(fixtures) {
  setGroup('8. every historical update hands off to the new package before start');

  for (const fixture of fixtures) {
    const branch = IS_WINDOWS ? fixture.windows : fixture.linux;
    const mode = IS_WINDOWS ? 'server' : null;
    const mechanism = IS_WINDOWS ? 'winsw' : 'systemd';
    const before = hashUserData(branch.userDataPaths);
    const order = [];
    const service = updateServiceStub({ mode, mechanism, order });
    const handoffs = [];
    let transactionSeen = false;

    const result = await modules.updater.performUpdate({
      version: TARGET_VERSION,
      dataDir: branch.dataDir,
      deps: {
        service,
        runFile: recordingNpm({ order, targetVersion: TARGET_VERSION }),
        detectInstallSource: () => ({
          kind: 'npm',
          root: fixture.root,
          npmUpdatable: true,
          reason: 'fixture package',
          howToUpdate: [],
        }),
        currentVersion: () => fixture.version,
        isElevated: async () => true,
        captureUpdateState: async (options) => {
          transactionSeen = true;
          order.push('snapshot');
          return { ok: true, root: null, ...options, runtimeNodeExe: process.execPath };
        },
        commitUpdateState: () => {
          order.push('commit');
          return { ok: true, warnings: [] };
        },
        restoreUpdateState: async () => {
          order.push('restore');
          return { ok: true, restored: true };
        },
        runPostUpdate: async (options) => {
          order.push('post-update');
          handoffs.push(options);
          return { ok: true, step: 'definition', version: options.version };
        },
        inspectLock: () => ({ lock: { version: TARGET_VERSION } }),
      },
    });

    check(`${fixture.version}: the update succeeds`, result.ok === true, result.reason ?? '');
    check(`${fixture.version}: service files are captured before npm replaces the package`,
      transactionSeen && order.indexOf('snapshot') < order.indexOf('npm-new'), order.join(' -> '));
    check(`${fixture.version}: npm, the new post-update, the start and the heartbeat are in order`,
      order.indexOf('npm-new') < order.indexOf('post-update')
        && order.indexOf('post-update') < order.indexOf('start')
        && order.indexOf('start') < order.indexOf('wait'),
      order.join(' -> '));
    check(`${fixture.version}: the handoff receives the newly installed root and target version`,
      handoffs.length === 1
        && handoffs[0].sourceRoot === fixture.root
        && handoffs[0].version === TARGET_VERSION
        && handoffs[0].dataDir === branch.dataDir);
    check(`${fixture.version}: only the target version's heartbeat confirms success`,
      result.versionConfirmed === true && result.runningVersion === TARGET_VERSION);
    check(`${fixture.version}: the handoff and start do not rewrite user data`,
      sameRows(before, hashUserData(branch.userDataPaths)));
  }
}

// --- The real update transaction (B2: the rollback that left nothing) ------

async function testUpdateTransaction(fixtures) {
  setGroup('9. the real update transaction puts the 1.4.6 XML and runtime copy back together');

  if (!IS_WINDOWS) {
    skip('Windows Server transaction (XML and runtime copy together)',
      'skipped on Linux; the runtime copy is Windows-Server-only');
    return;
  }

  for (const fixture of fixtures.filter((entry) => entry.version === '1.4.6')) {
    const before = hashUserData(fixture.windows.userDataPaths);
    const xmlBefore = fs.readFileSync(fixture.windows.xmlPath, 'utf8');
    const runtimeBefore = sha256(path.join(fixture.windows.runtimeRoot, 'node.exe'));
    const journal = path.join(fixture.windows.dataDir, 'update-journal.json');
    const runFile = async (file, args) => {
      if (/node(\.exe)?$/i.test(file) && args[0] === '--version') {
        return { success: true, stdout: 'v22.23.5\n', stderr: '' };
      }
      return { success: false, stdout: '', stderr: `unexpected ${file} ${args.join(' ')}` };
    };

    const snapshot = await asWindowsFixture(fixture, () => modules.updateTransaction.captureUpdateState({
      dataDir: fixture.windows.dataDir,
      mode: 'server',
      mechanism: 'winsw',
      log: () => {},
      deps: {},
    }));
    const movedAside = Boolean(snapshot.activeRuntime)
      && !fs.existsSync(snapshot.activeRuntime)
      && Boolean(snapshot.runtimeBackup)
      && fs.existsSync(snapshot.runtimeBackup)
      && fs.existsSync(journal);

    fs.mkdirSync(path.join(fixture.windows.runtimeRoot, 'app'), { recursive: true });
    fs.writeFileSync(path.join(fixture.windows.runtimeRoot, 'node.exe'), 'new-runtime');
    fs.writeFileSync(path.join(fixture.windows.runtimeRoot, 'app', 'package.json'),
      `${JSON.stringify({ name: 'easy-devops', version: TARGET_VERSION })}\n`);
    fs.writeFileSync(fixture.windows.xmlPath, '<service><id>EasyDevOps</id></service>\n');

    const recovered = await asWindowsFixture(fixture, () => modules.updateTransaction.recoverInterruptedUpdate({
      dataDir: fixture.windows.dataDir,
      log: () => {},
      deps: { runFile },
    }));

    check(`${fixture.version}: the transaction moves the runtime copy aside and journals it`,
      snapshot.ok === true && movedAside, snapshot.reason ?? JSON.stringify({
        active: snapshot.activeRuntime,
        backup: snapshot.runtimeBackup,
        runtimeMoved: snapshot.runtimeMoved,
      }));
    check(`${fixture.version}: the interrupted update is finished by the next run`,
      recovered.ok === true && recovered.recovered === true, recovered.reason ?? '');
    check(`${fixture.version}: the previous runtime copy is back, byte for byte`,
      sha256(path.join(fixture.windows.runtimeRoot, 'node.exe')) === runtimeBefore);
    check(`${fixture.version}: the previous WinSW XML is back, byte for byte`,
      fs.readFileSync(fixture.windows.xmlPath, 'utf8') === xmlBefore);
    check(`${fixture.version}: the journal and the snapshot are gone`,
      !fs.existsSync(journal) && !fs.existsSync(snapshot.root));
    check(`${fixture.version}: the restore leaves user data byte-identical`,
      sameRows(before, hashUserData(fixture.windows.userDataPaths)));
  }
}

// --- Rollback contract ------------------------------------------------------

async function testRollbackContract(fixtures) {
  setGroup('10. a failed new post-update restores the old state and proves its heartbeat');

  const fixture = fixtures.find((entry) => entry.version === '1.4.3');
  const branch = IS_WINDOWS ? fixture.windows : fixture.linux;
  const before = hashUserData(branch.userDataPaths);
  const order = [];
  const service = updateServiceStub({
    mode: IS_WINDOWS ? 'server' : null,
    mechanism: IS_WINDOWS ? 'winsw' : 'systemd',
    order,
  });

  service.waitForDaemon = async function waitForDaemon() {
    order.push('wait');
    this.heartbeats.push(fixture.version);
    return { alive: true, waitedMs: 50, lock: { version: fixture.version } };
  };

  const result = await modules.updater.performUpdate({
    version: TARGET_VERSION,
    dataDir: branch.dataDir,
    deps: {
      service,
      runFile: recordingNpm({ order, targetVersion: TARGET_VERSION }),
      detectInstallSource: () => ({
        kind: 'npm',
        root: fixture.root,
        npmUpdatable: true,
        reason: 'fixture package',
        howToUpdate: [],
      }),
      currentVersion: () => fixture.version,
      isElevated: async () => true,
      captureUpdateState: async (options) => {
        order.push('snapshot');
        return { ok: true, root: 'fixture-snapshot', ...options, runtimeNodeExe: process.execPath };
      },
      restoreUpdateState: async () => {
        order.push('restore');
        return { ok: true, restored: true };
      },
      commitUpdateState: () => ({ ok: true, warnings: [] }),
      runPostUpdate: async () => {
        order.push('post-update-failed');
        return { ok: false, step: 'definition', reason: 'fixture post-update failure' };
      },
      inspectLock: () => ({ lock: { version: fixture.version } }),
    },
  });

  check('the failed post-update is not reported as success',
    result.ok === false && result.step === 'definition', result.step);
  check('the old package and service artifacts are restored before the rollback start',
    result.rolledBack === true
      && result.restored === true
      && order.includes('restore')
      && order.indexOf('restore') < order.lastIndexOf('start'),
    order.join(' -> '));
  check('the rollback is confirmed by the old version\'s heartbeat',
    result.rollbackVersionConfirmed === true && service.heartbeats.at(-1) === fixture.version,
    String(service.heartbeats.at(-1)));
  check('no target start is allowed before the failed post-update',
    order.indexOf('post-update-failed') < order.indexOf('restore'), order.join(' -> '));
  check('the rollback does not change user data',
    sameRows(before, hashUserData(branch.userDataPaths)));
}

// --- States: the Windows Server from the owner's evidence -------------------

/**
 * Group 11-12: C:\ProgramData holds the real data, %APPDATA% a near-empty one,
 * no marker and no service. The one command is `ezz service install` with an
 * explicit choice; undefined must refuse and change nothing.
 */
async function testServerEvidenceChoice(state, choice) {
  const fixture = state;
  const branch = fixture.windows;
  const beforeProgramData = hashUserData(branch.userDataPaths);
  const beforeAppData = walkEntries(branch.userDataDir)
    .filter((file) => {
      try { return fs.statSync(file).isFile(); } catch { return false; }
    })
    .map((file) => `${path.relative(branch.userDataDir, file)}|${sha256(file)}`)
    .sort();
  const originalDatabaseHash = sha256(branch.dbPath);
  const originalDatabaseSize = fs.statSync(branch.dbPath).size;
  // The same relative user-data set, read from %APPDATA% before the migration.
  const appendedUserData = hashUserData(fixture.windows.userDataPaths.map((entry) => entry
    .replace(fixture.windows.dataDir, fixture.windows.userDataDir)));
  // The CLI in this state has no marker, so its live data directory is
  // %APPDATA%'s; ProgramData is the leftover an explicit choice is about.
  const cliDataDir = branch.userDataDir;
  const world = createWindowsWorld(fixture, { registered: false, running: false });

  // Without a choice, install must refuse and touch nothing.
  if (choice === 'adopt') {
    const refused = await runWindowsInstall(world, fixture, undefined, { dataDirEnv: cliDataDir });
    check('server-evidence: install without a choice refuses with leftover_data',
      refused.ok === false && refused.code === 'leftover_data'
        && Boolean(refused.leftover?.programData?.db?.keyCount),
      refused.code ?? refused.reason ?? '');
    check('server-evidence: the refusal names both databases by key count, and key NAMES only',
      refused.leftover?.programData?.db?.keyCount === 15
        && refused.leftover?.userData?.db?.keyCount === 4
        && refused.leftover.programData.db.keys.length === 15
        && refused.leftover.programData.db.keys.includes('hub-link')
        // Values are never read, so no value field can appear on the record.
        && refused.leftover.programData.db.value === undefined
        && refused.leftover.userData.db.value === undefined,
      `${refused.leftover?.programData?.db?.keyCount} vs ${refused.leftover?.userData?.db?.keyCount}`);
    check('server-evidence: the refusal changed nothing',
      sameRows(beforeProgramData, hashUserData(branch.userDataPaths))
        && beforeAppData.every((row) => {
          const [relative] = row.split('|');
          return fs.existsSync(path.join(branch.userDataDir, ...relative.split('/')));
        }));
  }

  const installed = await runWindowsInstall(world, fixture, choice, { dataDirEnv: cliDataDir });
  check(`server-evidence/${choice}: install succeeds`, installed.ok === true, installed.reason ?? '');

  if (choice === 'adopt') {
    check('server-evidence/adopt: the marker is present and ProgramData is the live data',
      fs.existsSync(branch.markerPath) && installed.dataDir === branch.dataDir,
      String(installed.dataDir));
    check('server-evidence/adopt: %APPDATA% was not touched',
      beforeAppData.every((row) => {
        const [relative, hash] = row.split('|');
        const file = path.join(branch.userDataDir, ...relative.split('/'));
        return fs.existsSync(file) && sha256(file) === hash;
      }));
    stateLine('server-evidence adopt',
      assertFinalState('server-evidence adopt', world, { userDataBefore: beforeProgramData }).ok,
      'one install, 15-key database adopted, %APPDATA% untouched');
  } else {
    // keep-aside: the old folder is renamed, never deleted, and %APPDATA%'s
    // database is migrated to the new ProgramData directory.
    const older = fs.readdirSync(path.dirname(branch.dataDir))
      .filter((name) => name.startsWith('easy-devops.old-'))
      .map((name) => path.join(path.dirname(branch.dataDir), name));
    check('server-evidence/keep-aside: the old ProgramData folder is kept under easy-devops.old-<date>',
      older.length === 1 && fs.existsSync(path.join(older[0], 'easy-devops.sqlite')),
      older.join(','));
    const keptDatabase = older.length ? path.join(older[0], 'easy-devops.sqlite') : null;
    check('server-evidence/keep-aside: the real 15-key database is byte for byte in the kept folder',
      Boolean(keptDatabase)
        && fs.statSync(keptDatabase).size === originalDatabaseSize
        && sha256(keptDatabase) === originalDatabaseHash,
      String(keptDatabase));
    // The user data the migration carried forward is compared across the two
    // directories: same relative names, same bytes.
    stateLine('server-evidence keep-aside',
      assertFinalState('server-evidence keep-aside', world, {
        userDataBefore: appendedUserData,
        userDataAfter: hashUserData(fixture.windows.userDataPaths),
      }).ok,
      'old database kept aside; 4-key %APPDATA% migrated');
    check('server-evidence/keep-aside: the migrated database is the %APPDATA% one, not an empty new file',
      fs.existsSync(branch.dbPath) && fs.statSync(branch.dbPath).size > 0);
  }
}

// --- State: 1.4.7's Personal launcher on a Server edition -------------------

async function testPersonalLauncherOnServer(state) {
  setGroup('11. state: a Personal launcher left on a Server edition is replaced by the service');

  const fixture = state;
  const branch = fixture.windows;
  const before = hashUserData(branch.userDataPaths);
  const world = createWindowsWorld(fixture, { registered: false, running: false });
  const supervisor = fs.readFileSync(branch.supervisorPath);
  const launcher = fs.readFileSync(branch.launcherPath);

  const installed = await runWindowsInstall(world, fixture);
  check('personal-launcher: install succeeds', installed.ok === true, installed.reason ?? '');
  check('personal-launcher: the two launcher files are removed, and only those two',
    !fs.existsSync(branch.supervisorPath) && !fs.existsSync(branch.launcherPath));

  const backups = walkEntries(path.join(branch.dataDir, 'backup'))
    .filter((file) => fs.existsSync(file) && !fs.statSync(file).isDirectory());
  const copied = backups.some((file) => path.basename(file) === PERSONAL_SUPERVISOR_FILE
    && fs.readFileSync(file).equals(supervisor))
    && backups.some((file) => path.basename(file) === PERSONAL_LAUNCHER_FILE
      && fs.readFileSync(file).equals(launcher));
  check('personal-launcher: both files were copied, verified and kept in the backup folder', copied,
    backups.map((file) => path.relative(branch.dataDir, file)).join(','));
  check('personal-launcher: no Startup file remains', !fs.existsSync(branch.launcherPath));

  const result = assertFinalState('personal-launcher', world, { userDataBefore: before });
  stateLine('personal-launcher-on-server', result.ok, 'install removed the launcher, service running');
}

// --- State: install interrupted at the runtime step -------------------------

async function testInstallInterrupted(state) {
  setGroup('12. state: an install interrupted at the runtime step resumes from there');

  const fixture = state;
  const branch = fixture.windows;
  const before = hashUserData(branch.userDataPaths);
  const world = createWindowsWorld(fixture, { registered: false, running: false });
  const progressBefore = JSON.parse(fs.readFileSync(branch.installProgressPath, 'utf8'));

  const status = await asWindowsFixture(fixture, () => modules.service.status({
    deps: windowsDeps(world),
  }));
  check('install-interrupted: status says install not finished and names the resume command',
    status.installUnfinished === true
      && /install not finished.*run `ezz service install` to resume/i.test(status.warnings.join(' ')),
    String(status.warnings[0] ?? ''));
  check('install-interrupted: status does not claim the runtime permissions are missing',
    !status.warnings.some((line) => /no recorded permission|has no access/i.test(line)),
    status.warnings.join(' | '));

  const installed = await runWindowsInstall(world, fixture);
  check('install-interrupted: install resumes and succeeds', installed.ok === true, installed.reason ?? '');
  check('install-interrupted: the finished install resumes at the failed step, not from the start',
    progressBefore.failedStep === 'runtime' && !fs.existsSync(branch.installProgressPath));
  check('install-interrupted: the runtime copy is now the CLI under test', (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(branch.runtimeRoot, 'app', 'package.json'), 'utf8')).version
        === TARGET_VERSION;
    } catch { return false; }
  })());
  check('install-interrupted: no user-data byte changed',
    sameRows(before, hashUserData(branch.userDataPaths)));

  const result = assertFinalState('install-interrupted', world, { userDataBefore: before });
  stateLine('install-interrupted', result.ok, 'install resumed at runtime, service running');
}

// --- State: daemon runtime older than the CLI -------------------------------

async function testRuntimeOlderThanCli(state) {
  setGroup('13. state: the daemon runs 1.4.4 while the CLI is 1.4.6: repair moves it on');

  const fixture = state;
  const branch = fixture.windows;
  const before = hashUserData(branch.userDataPaths);
  const world = createWindowsWorld(fixture, { registered: true, running: true });
  const daemonBefore = JSON.parse(fs.readFileSync(branch.daemonLockPath, 'utf8')).version;

  const repaired = await runWindowsRepair(world, fixture);
  check('runtime-older-than-cli: repair succeeds', repaired.ok === true, repaired.reason ?? '');
  check('runtime-older-than-cli: the old runtime was detected and replaced',
    daemonBefore !== TARGET_VERSION
      && JSON.parse(fs.readFileSync(branch.runtimeAppPackagePath, 'utf8')).version === TARGET_VERSION,
    `${daemonBefore} -> ${TARGET_VERSION}`);
  check('runtime-older-than-cli: the previous copy is kept only as runtime.prev while it is needed',
    !fs.existsSync(path.join(branch.dataDir, 'runtime.prev')));
  check('runtime-older-than-cli: the service definition points at the new runtime',
    fs.readFileSync(path.join(branch.binDir, 'EasyDevOps.xml'), 'utf8')
      .includes(path.join(branch.runtimeRoot, 'node.exe')));
  check('runtime-older-than-cli: no user-data byte changed',
    sameRows(before, hashUserData(branch.userDataPaths)));

  const result = assertFinalState('runtime-older-than-cli', world, { userDataBefore: before });
  stateLine('runtime-older-than-cli', result.ok, `repair: ${daemonBefore} -> ${TARGET_VERSION}`);
}

// --- State: a stale stop request --------------------------------------------

async function testStaleStopRequest(state) {
  setGroup('14. state: a stale stop request beside a running daemon: repair clears it');

  const fixture = state;
  const branch = fixture.windows;
  const before = hashUserData(branch.userDataPaths);
  const world = createWindowsWorld(fixture, { registered: true, running: true });

  check('stale-stop-request: the stop request is there before the command',
    fs.existsSync(branch.stopRequestPath));
  const repaired = await runWindowsRepair(world, fixture);
  check('stale-stop-request: repair succeeds', repaired.ok === true, repaired.reason ?? '');
  check('stale-stop-request: the request is gone, so the started daemon cannot exit at once',
    !fs.existsSync(branch.stopRequestPath));
  check('stale-stop-request: no user-data byte changed',
    sameRows(before, hashUserData(branch.userDataPaths)));

  const result = assertFinalState('stale-stop-request', world, { userDataBefore: before });
  stateLine('stale-stop-request', result.ok, 'repair cleared the request, daemon on the CLI version');
}

// --- State: the 11,000-file runtime -----------------------------------------

async function testLargeRuntime(state) {
  setGroup('15. state: an 11,000-file runtime where node.exe is listed before the app subtree');

  const fixture = state;
  const branch = fixture.windows;
  const before = hashUserData(branch.userDataPaths);
  const world = createWindowsWorld(fixture, { registered: true, running: true });
  // A registered service that is already running on this runtime copy.
  writeDaemonLock(branch.dataDir, TARGET_VERSION);

  const startedAt = Date.now();
  const recovered = await asWindowsFixture(fixture, () => modules.windowsService.recoverCodePermissions({
    run: world.run,
    runFile: world.runFile,
    operator: world.fixture.operator,
    dataDir: branch.dataDir,
    log: () => {},
  }));
  const elapsedMs = Date.now() - startedAt;
  const fakeState = world.read();

  check('large-runtime: recover succeeds through the streamed scan', recovered.ok === true,
    recovered.reason ?? '');
  check('large-runtime: the /T listing really exceeded the 64 KiB captured tail',
    (fakeState.stats.lastRecursiveBytes ?? 0) > 4 * 1024 * 1024,
    `${((fakeState.stats.lastRecursiveBytes ?? 0) / (1024 * 1024)).toFixed(1)} MiB`);
  const runtimeTreeCalls = (fakeState.calls ?? []).filter((call) => call.hasT
    && keyOf(call.args[0] ?? '').startsWith(keyOf(branch.runtimeRoot)));
  check('large-runtime: the runtime tree took one /T pass, not one per check',
    runtimeTreeCalls.length === 1, `${runtimeTreeCalls.length} pass(es)`);
  check('large-runtime: the protection stayed well inside the 30 s budget',
    elapsedMs < 30_000, `${(elapsedMs / 1000).toFixed(2)} s`);
  check('large-runtime: no user-data byte changed',
    sameRows(before, hashUserData(branch.userDataPaths)));

  const result = assertFinalState('large-runtime', world, { userDataBefore: before });
  stateLine('large-runtime', result.ok,
    `${branch.runtimeFileCount} files, one /T pass, ${(elapsedMs / 1000).toFixed(1)} s`);
}

// --- State: Linux unit tuning ------------------------------------------------

async function recoverLinuxUnit(branch, { dataDir, unitPath, user, isRoot }) {
  const calls = [];
  const waits = [];
  const result = await modules.systemd.recoverService({
    dataDir,
    entry: ENTRY,
    unitPath,
    deps: {
      isRoot: () => isRoot,
      linkRuntime: async () => ({
        ok: true,
        link: modules.runtime.runtimeNodePath(dataDir),
        target: process.execPath,
      }),
    },
    run: unitRunner(calls),
    runFile: unitCopyRunner(calls),
    waitForDaemon: async ({ dataDir: dir, timeoutMs }) => {
      writeDaemonLock(dir, TARGET_VERSION);
      waits.push(timeoutMs);
      return { alive: true, waitedMs: 5, lock: { pid: process.pid, version: TARGET_VERSION } };
    },
  });
  return { result, calls, waits, unitPath };
}

async function testLinuxUnitTuning(state) {
  setGroup('16. state: Linux malformed unit and operator tuning survive recover (root and non-root)');

  const fixture = state;
  const before = hashUserData(fixture.linux.userDataPaths);
  const malformedPath = fixture.linux.malformedUnitPath;
  const malformedHistorical = fs.readFileSync(malformedPath, 'utf8');

  const malformed = await recoverLinuxUnit(fixture.linux, {
    dataDir: fixture.linux.dataDir,
    unitPath: malformedPath,
    user: 'root',
    isRoot: true,
  });
  const written = fs.readFileSync(malformedPath, 'utf8');
  const issues = unitIssues(written, {
    dataDir: fixture.linux.dataDir,
    pinnedNode: modules.runtime.runtimeNodePath(fixture.linux.dataDir),
    expectedUser: 'root',
  });

  check('linux-unit-tuning: recover succeeds as root', malformed.result.ok === true,
    malformed.result.reason ?? '');
  check('linux-unit-tuning: the Environment= lines are out of [Unit] and into [Service]',
    !written.includes(MALFORMED_UNIT_LINE) && issues.length === 0, issues.slice(0, 3).join('; '));
  check('linux-unit-tuning: Environment= appears only in [Service]',
    unitValues(parseUnit(written).sections, 'Unit', 'Environment').length === 0
      && unitValues(parseUnit(written).sections, 'Service', 'Environment').length >= 5);
  check('linux-unit-tuning: the operator LimitNOFILE in the old unit is kept',
    unitValue(parseUnit(written).sections, 'Service', 'LimitNOFILE') === '65535',
    String(unitValue(parseUnit(written).sections, 'Service', 'LimitNOFILE')));
  check('linux-unit-tuning: the broken unit is preserved as <unit>.prev',
    fs.readFileSync(`${malformedPath}.prev`, 'utf8') === malformedHistorical);
  const stoppedCleared = !fs.existsSync(fixture.linux.stopRequestPath);
  check('linux-unit-tuning: the stale stop request is cleared', stoppedCleared);

  // A unit with an operator-set LimitNOFILE of 1048576 must keep that value.
  const tunedPath = fixture.linux.tunedUnitPath;
  const tuned = await recoverLinuxUnit(fixture.linux, {
    dataDir: fixture.linux.dataDir,
    unitPath: tunedPath,
    user: 'root',
    isRoot: false,
  });
  const tunedWritten = fs.readFileSync(tunedPath, 'utf8');
  const tunedKept = unitValue(parseUnit(tunedWritten).sections, 'Service', 'LimitNOFILE') === '1048576';
  check('linux-unit-tuning: recover succeeds through sudo as a normal user',
    tuned.result.ok === true && tuned.calls.some((call) => call[0] === 'sudo'),
    tuned.result.reason ?? tuned.calls.map((call) => call[0]).join(','));
  check('linux-unit-tuning: the tuned LimitNOFILE survives the rewrite',
    tunedKept,
    String(unitValue(parseUnit(tunedWritten).sections, 'Service', 'LimitNOFILE')));
  check('linux-unit-tuning: the root and sudo paths both reload and restart the unit',
    tuned.calls.some((call) => call.includes('daemon-reload')) && tuned.calls.some((call) => call.includes('restart')));
  const dataUnchanged = sameRows(before, hashUserData(fixture.linux.userDataPaths));
  check('linux-unit-tuning: not one byte of user data changed', dataUnchanged);

  stateLine('linux-unit-tuning',
    malformed.result.ok === true && issues.length === 0 && stoppedCleared && tuned.result.ok === true
      && tunedKept && dataUnchanged,
    'malformed unit regenerated, LimitNOFILE tuning kept, root and sudo');
}

// --- State: a failed update that rolled back --------------------------------

async function testLinuxFailedUpdateRollback(state) {
  setGroup('17. state: a failed update that rolled back: the post-update step runs without touching data');

  const fixture = state;
  const branch = fixture.linux;
  const before = hashUserData(branch.userDataPaths);
  const statusBefore = fs.readFileSync(branch.updateStatusPath, 'utf8');
  const runtimeBefore = fs.readFileSync(branch.runtimePackagePath, 'utf8');
  const calls = [];

  const result = await withEnv({ EASY_DEVOPS_DATA_DIR: branch.dataDir }, () => modules.postUpdate.applyPostUpdate({
    dataDir: branch.dataDir,
    mechanism: 'systemd',
    targetVersion: TARGET_VERSION,
    deps: {
      installedPackageVersion: () => TARGET_VERSION,
      refreshUnit: (options) => modules.systemd.refreshUnit({
        ...options,
        dataDir: branch.dataDir,
        unitPath: branch.unitPath,
        fileRunner: unitCopyRunner(calls),
        interactive: unitRunner(calls),
      }),
    },
  }));

  const unitOk = unitIssues(fs.readFileSync(branch.unitPath, 'utf8'), {
    dataDir: branch.dataDir,
    pinnedNode: modules.runtime.runtimeNodePath(branch.dataDir),
  }).length === 0;
  const recordKept = fs.readFileSync(branch.updateStatusPath, 'utf8') === statusBefore
    && JSON.parse(statusBefore).rollback?.restoredVersion === branch.runtimeVersion;
  const runtimeKept = fs.readFileSync(branch.runtimePackagePath, 'utf8') === runtimeBefore;
  const dataKept = sameRows(before, hashUserData(branch.userDataPaths));

  check('linux-failed-update-rollback: the post-update step succeeds', result.ok === true, result.reason ?? '');
  check('linux-failed-update-rollback: the unit is regenerated for the running service', unitOk);
  check('linux-failed-update-rollback: the rollback record is untouched', recordKept);
  check('linux-failed-update-rollback: the runtime copy stays the rolled-back old version', runtimeKept);
  check('linux-failed-update-rollback: not one byte of user data changed', dataKept);

  stateLine('linux-failed-update-rollback',
    result.ok === true && unitOk && recordKept && runtimeKept && dataKept,
    `post-update on ${branch.runtimeVersion}, rollback record and runtime kept`);
}

// --- State: the database held by a leftover process -------------------------

async function testLinuxDatabaseHeld(state) {
  setGroup('18. state: a leftover process holds the database: reported, never killed, never deleted');

  const fixture = state;
  const branch = fixture.linux;
  const before = hashUserData(branch.userDataPaths);
  const holder = branch.holder;

  const report = modules.serviceStatusPreflight.inspectServiceStatusDatabase({
    dataDir: branch.dataDir,
    holders: {
      fuser: { checked: true, available: true, output: holder.answers.fuser, error: null },
    },
  });
  const text = modules.serviceStatusPreflight.formatDatabasePreflightFailure(report);

  const namedPid = text.includes(String(holder.pid));
  const namedCommand = namedPid && /src[\\/]cli[\\/]index\.js/.test(text) && /\bnode\b/.test(text);
  const saysStop = /stop that process/i.test(text) && !/\bkill\b/i.test(text);
  const leftoverLock = report.lock.present === true && report.lock.running === false && /is gone/.test(text);
  const untouched = sameRows(before, hashUserData(branch.userDataPaths))
    && fs.existsSync(branch.dbPath) && fs.existsSync(branch.daemonLockPath);
  const readOnlySaid = /only read/.test(text);

  check('linux-database-held: the report names the holder pid', namedPid, holder.pid);
  check('linux-database-held: the report names the holder command from fuser', namedCommand,
    holder.command);
  check('linux-database-held: it says to stop that process, never to delete the database',
    saysStop,
    text.split('\n').find((line) => /stop that process/i.test(line)) ?? '');
  check('linux-database-held: the daemon lock is reported as a leftover, not a live daemon',
    leftoverLock);
  check('linux-database-held: nothing was killed and no file was deleted', untouched);
  check('linux-database-held: the report says the check only read', readOnlySaid);

  stateLine('linux-database-held',
    namedPid && namedCommand && saysStop && leftoverLock && untouched && readOnlySaid,
    `pid ${holder.pid} and its command reported; no kill, no delete`);
}

// --- Healthy published versions: one command leaves them working -----------

async function testHealthyVersions(fixtures) {
  setGroup('19. every published 1.4.0-1.4.7 is healthy after one command (Server, Linux root and non-root)');

  check('all eight published versions are materialized',
    fixtures.map((fixture) => fixture.version).join(',') === PUBLISHED_VERSIONS.join(','));

  for (const fixture of fixtures) {
    // ── Windows Server: repair ────────────────────────────────────────────
    const before = hashUserData(fixture.windows.userDataPaths);
    const world = createWindowsWorld(fixture, { registered: true, running: true });
    const daemonBefore = JSON.parse(fs.readFileSync(fixture.windows.daemonLockPath, 'utf8')).version;
    const repaired = await runWindowsRepair(world, fixture);
    const result = assertFinalState(`healthy-${fixture.version} windows`, world, { userDataBefore: before });
    stateLine(`healthy ${fixture.version} Windows Server`, repaired.ok === true && result.ok,
      repaired.ok ? `repair ${daemonBefore} -> ${TARGET_VERSION}` : (repaired.reason ?? '').slice(0, 120));

    // ── Linux, root and a normal user: recover ────────────────────────────
    for (const [label, branch, platform] of [
      ['Linux root', fixture.linuxRoot, true],
      ['Linux non-root', fixture.linuxUser, false],
    ]) {
      const dataBefore = hashUserData(branch.userDataPaths);
      const recovered = await recoverLinuxUnit(branch, {
        dataDir: branch.dataDir,
        unitPath: branch.unitPath,
        user: branch.user,
        isRoot: branch.isRoot,
      });
      const written = fs.readFileSync(branch.unitPath, 'utf8');
      const issues = unitIssues(written, {
        dataDir: branch.dataDir,
        pinnedNode: modules.runtime.runtimeNodePath(branch.dataDir),
        expectedUser: branch.user,
      });
      const ok = recovered.result.ok === true
        && issues.length === 0
        && sameRows(dataBefore, hashUserData(branch.userDataPaths));
      if (!ok && recovered.result.reason) note(`${fixture.version} ${label}: ${recovered.result.reason.slice(0, 160)}`);
      stateLine(`healthy ${fixture.version} ${label}`, ok,
        `recover: unit valid for ${branch.user}, data unchanged`);
    }
  }
}

// --- Recover twice on a healthy server --------------------------------------

async function testRecoverTwice(state) {
  setGroup('20. recover twice on a healthy server: the second run changes nothing');

  const fixture = state;
  const branch = fixture.windows;
  const before = hashUserData(branch.userDataPaths);
  const world = createWindowsWorld(fixture, { registered: true, running: true });

  const first = await runWindowsRecover(world, fixture);
  check('recover-twice: the first recover on a healthy server succeeds', first.ok === true, first.reason ?? '');
  const afterFirst = world.read();
  const snapshotFirst = ownAclSnapshot(afterFirst, [branch.binDir, branch.runtimeRoot, branch.dataDir]);

  const second = await runWindowsRecover(world, fixture);
  check('recover-twice: the second recover also succeeds', second.ok === true, second.reason ?? '');
  const afterSecond = world.read();
  const snapshotSecond = ownAclSnapshot(afterSecond, [branch.binDir, branch.runtimeRoot, branch.dataDir]);

  check('recover-twice: the second run changes no ACL, owner or inheritance',
    sameRows(snapshotFirst, snapshotSecond));
  check('recover-twice: not one byte of user data changed either time',
    sameRows(before, hashUserData(branch.userDataPaths)));
  const result = assertFinalState('recover-twice', world, { userDataBefore: before });
  stateLine('recover twice on a healthy server', result.ok && sameRows(snapshotFirst, snapshotSecond),
    'second run is a cheap check: no ACL rewritten');
}

// --- main -------------------------------------------------------------------

async function main() {
  process.stdout.write('\nHistorical service upgrade matrix\n');
  process.stdout.write(`data dir: ${TEST_DATA_DIR}\n`);

  const fixtures = materializeUpgradeFixtures(scratch('fixtures-upgrade'));
  const recoveryFixtures = materializeUpgradeFixtures(scratch('fixtures-recovery'));
  const transactionFixtures = materializeUpgradeFixtures(scratch('fixtures-transaction'));
  const upgradeStates = materializeUpgradeStates(scratch('fixtures-states'));
  // The two leftover choices each need the untouched evidence server: the
  // first install consumes it (adopt leaves it in place, set-aside moves it).
  const evidenceAside = materializeServerEvidenceFixture(scratch('fixtures-evidence-aside'));
  const healthyFixtures = materializeHealthyVersionFixtures(scratch('fixtures-healthy'));

  modules = {
    platform: await import(srcUrl('core/platform.js')),
    shell: await import(srcUrl('core/shell.js')),
    systemd: await import(srcUrl('core/service/systemd.js')),
    windowsService: await import(srcUrl('core/service/windowsService.js')),
    operator: await import(srcUrl('core/service/operator.js')),
    postUpdate: await import(srcUrl('core/service/postUpdate.js')),
    updateTransaction: await import(srcUrl('core/service/updateTransaction.js')),
    runtime: await import(srcUrl('core/service/runtime.js')),
    updater: await import(srcUrl('core/updater.js')),
    service: await import(srcUrl('core/service/index.js')),
    db: await import(srcUrl('core/db.js')),
    serviceStatusPreflight: await import(srcUrl('cli/serviceStatusPreflight.js')),
  };
  IS_WINDOWS = modules.platform.isWindows;
  if (!IS_WINDOWS) {
    note('this machine is not Windows: the Windows-only groups are skipped by name;');
    note('run `node e2e/run.mjs --windows-only` on the owner\'s Windows Server before release.');
  }

  try {
    await testFixtureIntegrity(fixtures);
    await testLinuxPostUpdate(fixtures);
    await testLinuxRecover(recoveryFixtures);
    await testWindowsPostUpdate(fixtures);
    await testWindowsRecover(recoveryFixtures);
    await testWindowsNoServiceThenInstall(recoveryFixtures);
    await testStopRequestSemantics(fixtures);
    await testHandoffOrder(fixtures);
    await testUpdateTransaction(transactionFixtures);
    await testRollbackContract(fixtures);
    await testServerEvidenceChoice(upgradeStates['server-evidence'], 'adopt');
    await testServerEvidenceChoice(evidenceAside, 'keep-aside');
    await testPersonalLauncherOnServer(upgradeStates['personal-launcher-on-server']);
    await testInstallInterrupted(upgradeStates['install-interrupted']);
    await testRuntimeOlderThanCli(upgradeStates['runtime-older-than-cli']);
    await testStaleStopRequest(upgradeStates['stale-stop-request']);
    await testLargeRuntime(upgradeStates['large-runtime']);
    await testLinuxUnitTuning(upgradeStates['linux-unit-tuning']);
    await testLinuxFailedUpdateRollback(upgradeStates['linux-failed-update-rollback']);
    await testLinuxDatabaseHeld(upgradeStates['linux-database-held']);
    await testHealthyVersions(healthyFixtures);
    await testRecoverTwice(healthyFixtures[healthyFixtures.length - 1]);
  } finally {
    modules.db.closeDb();
  }

  const failed = results.filter((result) => !result.passed);
  const skipped = results.filter((result) => result.skipped);
  const failedStates = states.filter((entry) => !entry.passed);
  process.stdout.write(`\n${'-'.repeat(68)}\n`);
  process.stdout.write('States (one command each):\n');
  for (const entry of states) {
    process.stdout.write(`  ${entry.passed ? 'ok  ' : 'FAIL'}  ${entry.name}: ${entry.detail}\n`);
  }
  process.stdout.write(
    `TOTAL ${results.length}   PASS ${results.length - failed.length - skipped.length}`
    + `   SKIP ${skipped.length}   FAIL ${failed.length}\n`,
  );
  if (failed.length) {
    process.stdout.write('\nFailures:\n');
    for (const failure of failed) {
      process.stdout.write(`  [${failure.group}] ${failure.label}`
        + `${failure.detail ? ` - ${failure.detail}` : ''}\n`);
    }
  }
  process.exit(failed.length || failedStates.length ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? String(error)}\n`);
  process.exit(1);
});
