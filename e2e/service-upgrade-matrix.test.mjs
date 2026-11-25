/**
 * Historical service-upgrade matrix.
 *
 * Run with: node e2e/run.mjs service-upgrade-matrix
 *
 * The suite materializes the on-disk state left by 1.4.0, 1.4.3, 1.4.5 and
 * 1.4.6 (e2e/fixtures/upgrade-history.mjs) and runs the NEW version's
 * post-update, recover, repair, start and update-transaction paths against it.
 *
 * The Windows half drives the REAL core/service/operator.js
 * `protectServiceFiles` and core/service/windowsService.js
 * `recoverCodePermissions` through their `run` / `runFile` injection points,
 * and the stateful fake `icacls` below keeps a per-path DACL model (owner,
 * explicit ACEs, inheritance) that both the production code and the assertions
 * read. Nothing here executes icacls, sc.exe, systemctl or sudo, and every path
 * is below the run's temporary data directory.
 *
 * The assertions are always made against that MODEL, never against source
 * text: after the code ran, every file under bin\ and runtime\ must have a
 * non-empty DACL with SYSTEM full control, Administrators full control and
 * NT SERVICE\EasyDevOps read & execute; the data root may only receive the
 * additive, non-recursive grant; and no user-data file's own DACL may be
 * rewritten or lose an ACE.
 */

import './lib/guard.mjs';
import { TEST_DATA_DIR, assertInsideTestDataDir } from './lib/guard.mjs';
import {
  HISTORICAL_VERSIONS,
  MALFORMED_UNIT_LINE,
  TRUSTEES,
  materializeUpgradeFixtures,
} from './fixtures/upgrade-history.mjs';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const srcUrl = (relative) => pathToFileURL(path.join(ROOT, 'src', relative)).href;
const ENTRY = path.join(ROOT, 'src', 'cli', 'index.js');
const TARGET_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

let modules = null;

const results = [];
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

/** Runs `fn` with ProgramData / the data directory pointed at one fixture. */
async function asWindowsFixture(fixture, fn) {
  return withEnv({
    EASY_DEVOPS_DATA_DIR: fixture.windows.dataDir,
    ProgramData: fixture.windows.programData,
  }, async () => {
    modules.platform.resetDataDirCache();
    try {
      return await fn();
    } finally {
      modules.platform.resetDataDirCache();
    }
  });
}

// ─── User data: hash every file, before and after ────────────────────────────

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

// ─── The generated systemd unit: parsed, never grepped ───────────────────────

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
 *
 * @returns {{ problems: string[], sections: Map<string, Array<[string,string]>> }}
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
    else if (expected !== section) problems.push(`line ${lineNumber}: ${key} belongs in [${expected}], not [${section}]`);
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
function unitIssues(raw, { dataDir, pinnedNode }) {
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
  if (!argv.some((argument) => argument.startsWith('--experimental-loader=') && argument.endsWith('runtime-loader.mjs'))) {
    issues.push('ExecStart has no runtime loader');
  }
  if (!argv.includes(ENTRY)) issues.push(`ExecStart does not run ${ENTRY}`);
  if (argv.at(-1) !== 'daemon') issues.push('ExecStart does not end with `daemon`');
  if (!unitValue(sections, 'Service', 'User')) issues.push('no User= in [Service]');
  if (!unitValue(sections, 'Service', 'WorkingDirectory')) issues.push('no WorkingDirectory= in [Service]');
  if (!unitValues(sections, 'Install', 'WantedBy').includes('multi-user.target')) issues.push('no WantedBy=multi-user.target');
  return issues;
}

// ─── The stateful fake icacls ────────────────────────────────────────────────

function cloneAce(ace) {
  return { trustee: ace.trustee, level: ace.level, flags: [...(ace.flags ?? [])] };
}

function isInsidePath(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

const samePath = (left, right) => path.resolve(String(left)).toLowerCase() === path.resolve(String(right)).toLowerCase();

/**
 * A per-path DACL model behind `icacls.exe`.
 *
 * It implements the subset the service code uses - /save, /restore, /setowner,
 * /grant:r, /grant, /inheritance:r, /inheritance:e, /reset, /remove:g - plus a
 * listing in the real format (including "Successfully processed N files").
 *
 * Inheritance is COMPUTED from the nearest ancestor that still inherits, which
 * is how `/reset` restores a child's access after `/inheritance:r` on its
 * folder, and why the empty-DACL files from finding A1 cannot be fixed until
 * `/setowner` has run: a DACL with no ACEs grants nobody WRITE_DAC, and the
 * elevated Administrator is not the owner.
 *
 * The order of the recover transaction is deliberately not assumed: a second
 * `/reset` after `/inheritance:r`, and `/remove:g` of unapproved explicit ACEs,
 * are both supported, so either version of that code passes.
 *
 * @param {Object} opts
 * @param {{sid: string, name: string}} opts.operator
 * @param {string} opts.sddl  The service descriptor `sc.exe sdshow` returns
 */
function createIcaclsModel({ operator, sddl }) {
  const entries = new Map();
  const calls = [];
  const mutations = [];
  const sc = { sddl, writes: 0 };

  const SID_NAMES = new Map([
    ['S-1-5-18', TRUSTEES.SYSTEM],
    ['S-1-5-32-544', TRUSTEES.ADMINISTRATORS],
    ['S-1-5-32-545', TRUSTEES.USERS],
    [operator.sid.toUpperCase(), operator.name],
  ]);
  const ADMIN_KEY = TRUSTEES.ADMINISTRATORS.toUpperCase();

  const trusteeName = (value) => {
    const raw = String(value ?? '').trim().replace(/^\*/, '');
    return SID_NAMES.get(raw.toUpperCase()) ?? raw;
  };
  const trusteeKey = (value) => trusteeName(value).toUpperCase();
  const keyOf = (value) => path.resolve(String(value)).toLowerCase();

  function statOf(target) {
    try { return fs.statSync(target); } catch { return null; }
  }
  const isDirectory = (target) => Boolean(statOf(target)?.isDirectory());

  function entryFor(target) {
    const id = keyOf(target);
    let entry = entries.get(id);
    if (!entry) {
      const directory = isDirectory(target);
      entry = {
        path: path.resolve(String(target)),
        isDir: directory,
        owner: directory ? TRUSTEES.ADMINISTRATORS : operator.sid,
        explicit: [],
        inherit: true,
      };
      entries.set(id, entry);
    }
    return entry;
  }

  function put(target, spec) {
    const entry = entryFor(target);
    entry.explicit = (spec?.aces ?? []).map(cloneAce);
    entry.inherit = spec?.inherit !== false;
    return entry;
  }

  /** Every ACE that applies to an entry: its own, then inherited ones. */
  function effective(entry) {
    const aces = entry.explicit.map((ace) => ({ ...cloneAce(ace), inherited: false }));
    if (!entry.inherit) return aces;
    let directory = path.dirname(entry.path);
    const seen = new Set();
    while (!seen.has(directory)) {
      seen.add(directory);
      const ancestor = entries.get(keyOf(directory));
      if (ancestor) {
        for (const ace of ancestor.explicit) {
          const flags = ace.flags ?? [];
          const applies = entry.isDir ? (flags.includes('CI') || flags.includes('OI')) : flags.includes('OI');
          if (applies) aces.push({ ...cloneAce(ace), inherited: true });
        }
        if (!ancestor.inherit) break;
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    return aces;
  }

  function children(directory) {
    try {
      return fs.readdirSync(directory, { withFileTypes: true })
        .map((entry) => path.join(directory, entry.name))
        .sort();
    } catch {
      return [];
    }
  }

  function descendants(directory) {
    const found = [];
    const stack = [path.resolve(String(directory))];
    while (stack.length) {
      const current = stack.pop();
      for (const child of children(current)) {
        found.push(child);
        if (isDirectory(child)) stack.push(child);
      }
    }
    return found.sort();
  }

  /** `dir\*` means the children; `/T` adds everything below them. */
  function expandTargets(target, recursive) {
    const value = String(target);
    const wildcard = /[\\/]\*$/.test(value);
    const base = wildcard ? value.slice(0, -2) : value;
    const targets = wildcard
      ? (recursive ? descendants(base) : children(base))
      : [base, ...(recursive ? descendants(base) : [])];
    return [...new Set(targets.map((entry) => path.resolve(entry)))];
  }

  const SPEC_FLAGS = new Set(['OI', 'CI', 'IO', 'NP', 'I']);
  /**
   * `SID:(OI)(CI)F` on a command line, `SID:(I)(OI)(CI)(F)` in a listing: the
   * access level may be a bare token or parenthesised.
   */
  function parseSpec(spec) {
    const text = String(spec);
    const groups = [...text.matchAll(/\(([^()]*)\)/g)].map((match) => match[1].trim().toUpperCase());
    const flags = [];
    let level = null;
    for (const group of groups) {
      if (SPEC_FLAGS.has(group)) flags.push(group);
      else level = group;
    }
    if (!level) {
      const bare = text.replace(/\([^()]*\)/g, '').trim().toUpperCase();
      if (/^[A-Z]{1,3}$/.test(bare)) level = bare;
    }
    return level ? { level, flags } : null;
  }

  function parseGrantArg(argument) {
    const text = String(argument);
    const colon = text.lastIndexOf(':');
    if (colon <= 0) return null;
    const spec = parseSpec(text.slice(colon + 1));
    if (!spec) return null;
    return { trustee: trusteeName(text.slice(0, colon)), ...spec };
  }

  function aclLine(entry) {
    const aces = effective(entry);
    if (aces.length === 0) return [entry.path];
    const rendered = aces.map((ace) => {
      const flags = (ace.flags ?? []).map((flag) => `(${flag})`).join('');
      return `${ace.trustee}:${ace.inherited ? '(I)' : ''}${flags}(${ace.level})`;
    });
    return [entry.path, rendered[0], ...rendered.slice(1).map((line) => `    ${line}`)];
  }

  function listing(target, recursive) {
    const lines = [];
    let processed = 0;
    for (const entryPath of expandTargets(target, recursive)) {
      if (!fs.existsSync(entryPath)) continue;
      lines.push(...aclLine(entryFor(entryPath)));
      processed += 1;
    }
    return {
      success: true,
      stdout: `${lines.join('\r\n')}\r\n\r\nSuccessfully processed ${processed} files.`,
      stderr: '',
    };
  }

  const ok = (processed) => ({ success: true, stdout: `Successfully processed ${processed} files.`, stderr: '' });
  const denied = (count) => ({ success: false, stdout: '', stderr: `Access is denied.\r\n${count} files were not processed.` });

  function icacls(args) {
    calls.push({ file: 'icacls.exe', args: [...args] });
    const target = args[0];
    const recursive = args.includes('/T');
    const operation = args.find((argument) =>
      /^\/(save|restore|setowner|grant(:r)?|deny|remove(:[gd])?|inheritance:[re]|reset|verify)$/i.test(argument));

    if (!operation) return listing(target, recursive);
    const op = operation.toLowerCase();

    if (op === '/save') {
      const saved = expandTargets(target, true).map((entryPath) => {
        const entry = entryFor(entryPath);
        return { path: entry.path, owner: entry.owner, inherit: entry.inherit, explicit: entry.explicit.map(cloneAce) };
      });
      fs.writeFileSync(args[1], JSON.stringify({ entries: saved }, null, 2));
      return ok(saved.length);
    }

    if (op === '/restore') {
      const parent = path.resolve(String(target));
      const payload = JSON.parse(fs.readFileSync(args[2], 'utf8'));
      let restored = 0;
      for (const record of payload.entries ?? []) {
        if (!isInsidePath(record.path, parent)) continue;
        const entry = entryFor(record.path);
        entry.owner = record.owner;
        entry.inherit = record.inherit !== false;
        entry.explicit = (record.explicit ?? []).map(cloneAce);
        restored += 1;
      }
      mutations.push({ op: '/restore', targets: [parent] });
      return ok(restored);
    }

    if (op === '/setowner') {
      const owner = trusteeName(args[2]);
      const targets = expandTargets(target, recursive);
      for (const entryPath of targets) entryFor(entryPath).owner = owner;
      mutations.push({ op: '/setowner', targets, trustees: [owner] });
      return ok(targets.length);
    }

    if (op === '/grant' || op === '/grant:r') {
      const replace = op === '/grant:r';
      const specs = args.slice(2).filter((argument) => !/^\/[A-Za-z]/.test(argument))
        .map(parseGrantArg).filter(Boolean);
      if (specs.length === 0) return { success: false, stdout: '', stderr: 'Invalid parameter' };
      const named = new Set(specs.map((spec) => trusteeKey(spec.trustee)));
      const targets = expandTargets(target, recursive);
      for (const entryPath of targets) {
        const entry = entryFor(entryPath);
        if (replace) entry.explicit = entry.explicit.filter((ace) => !named.has(trusteeKey(ace.trustee)));
        for (const spec of specs) {
          const already = entry.explicit.some((ace) => trusteeKey(ace.trustee) === trusteeKey(spec.trustee)
            && ace.level === spec.level
            && [...(ace.flags ?? [])].sort().join(',') === [...spec.flags].sort().join(','));
          if (!already) entry.explicit.push(cloneAce(spec));
        }
      }
      mutations.push({ op, targets, trustees: specs.map((spec) => spec.trustee) });
      return ok(targets.length);
    }

    if (op === '/remove:g' || op === '/remove') {
      const removed = new Set([trusteeKey(args[2])]);
      const targets = expandTargets(target, recursive);
      for (const entryPath of targets) {
        const entry = entryFor(entryPath);
        entry.explicit = entry.explicit.filter((ace) => !removed.has(trusteeKey(ace.trustee)));
      }
      mutations.push({ op, targets, trustees: [trusteeName(args[2])] });
      return ok(targets.length);
    }

    if (op === '/inheritance:r' || op === '/inheritance:e') {
      const enable = op === '/inheritance:e';
      const targets = expandTargets(target, recursive);
      for (const entryPath of targets) entryFor(entryPath).inherit = enable;
      mutations.push({ op, targets });
      return ok(targets.length);
    }

    if (op === '/reset') {
      const targets = expandTargets(target, recursive);
      const changed = [];
      const refused = [];
      for (const entryPath of targets) {
        const entry = entryFor(entryPath);
        // Finding A1, exactly: `/reset` needs WRITE_DAC. An empty DACL grants
        // nobody that, and only the owner can rewrite a DACL - so a file owned
        // by the installing user cannot be reset until Administrators own it.
        if (entry.owner.toUpperCase() !== ADMIN_KEY && effective(entry).length === 0) {
          refused.push(entryPath);
          continue;
        }
        entry.explicit = [];
        entry.inherit = true;
        changed.push(entryPath);
      }
      mutations.push({ op: '/reset', targets: changed, refused });
      if (refused.length) return denied(refused.length);
      return ok(changed.length);
    }

    if (op === '/verify') return ok(expandTargets(target, recursive).length);

    return { success: false, stdout: '', stderr: `unexpected icacls operation: ${args.join(' ')}` };
  }

  function scExe(args) {
    calls.push({ file: 'sc.exe', args: [...args] });
    if (args[0] === 'sdshow') return { success: true, stdout: `${sc.sddl}\r\n`, stderr: '' };
    if (args[0] === 'sdset') {
      sc.sddl = args[2];
      sc.writes += 1;
      return { success: true, stdout: '[SC] SetServiceObjectSecurity SUCCESS\r\n', stderr: '' };
    }
    return { success: false, stdout: '', stderr: `unexpected sc.exe ${args.join(' ')}` };
  }

  const runFile = async (file, args) => {
    const exe = path.win32.basename(String(file)).toLowerCase();
    if (exe === 'icacls.exe') return icacls([...args]);
    if (exe === 'sc.exe') return scExe([...args]);
    // The reparse-point preflight in acl.js. Only reached by walks this suite
    // does not drive; answering it keeps an unexpected call visible in `calls`.
    if (exe === 'powershell.exe') return { success: true, stdout: '', stderr: '' };
    return { success: false, stdout: '', stderr: `unexpected executable ${file} ${args.join(' ')}` };
  };

  const run = async (command) => {
    calls.push({ file: '(string)', args: [String(command)] });
    if (/IsInRole/.test(command)) return { success: true, stdout: 'True\r\n', stderr: '' };
    if (/WindowsIdentity]::GetCurrent\(\)/.test(command)) {
      return { success: true, stdout: `${operator.sid}|${operator.name}\r\n`, stderr: '' };
    }
    if (/^sc\.exe query /i.test(command)) {
      return { success: true, stdout: 'SERVICE_NAME: EasyDevOps\r\n        STATE : 4  RUNNING\r\n', stderr: '' };
    }
    if (/^sc\.exe sdshow /i.test(command)) return { success: true, stdout: `${sc.sddl}\r\n`, stderr: '' };
    return { success: false, stdout: '', stderr: `unexpected command: ${command}` };
  };

  /** Mutations whose target set contains exactly `target`. */
  const mutationsAt = (target) => mutations.filter((mutation) =>
    mutation.targets.some((entry) => samePath(entry, target)));

  /** Mutations that touched anything at or below one of `roots`. */
  const mutationsInside = (roots) => mutations.filter((mutation) =>
    mutation.targets.some((target) => roots.some((root) => isInsidePath(target, root))));

  return { entries, calls, mutations, sc, run, runFile, put, effective, entryFor, mutationsAt, mutationsInside };
}

/** The fake icacls, seeded from one fixture's acl-records.json. */
function createWindowsAcl(fixture, seed) {
  if (!seed?.dataRoot || !seed?.folders || !seed?.files) {
    throw new Error('the fixture ACL records are not a DACL model');
  }
  const model = createIcaclsModel({ operator: fixture.operator, sddl: fixture.serviceDescriptor });
  model.put(fixture.dataDir, seed.dataRoot);
  for (const [name, spec] of Object.entries(seed.folders)) {
    model.put(path.join(fixture.dataDir, ...name.split('/')), spec);
  }
  for (const [name, spec] of Object.entries(seed.files)) {
    model.put(path.join(fixture.dataDir, ...name.split('/')), spec);
  }
  return model;
}

// ─── Model assertions ────────────────────────────────────────────────────────

const hasAce = (aces, trustee, levels) => aces.some((ace) =>
  ace.trustee.toUpperCase() === trustee.toUpperCase() && levels.includes(ace.level));

/** Every entry under a protected root: non-empty, SYSTEM F, Administrators F, service RX. */
function codeRootIssues(model, root) {
  const issues = [];
  for (const entryPath of walkEntries(root)) {
    const aces = model.effective(model.entryFor(entryPath));
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
function ownAclSnapshot(model, roots) {
  const rows = [];
  for (const root of roots) {
    for (const entryPath of walkEntries(root)) {
      const entry = model.entryFor(entryPath);
      rows.push(`${entryPath}|${entry.owner}|${entry.inherit}|${JSON.stringify(entry.explicit)}`);
    }
  }
  return rows.sort();
}

// ─── 1. Fixture integrity ───────────────────────────────────────────────────

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
        ? !unit.includes('runtime-loader.mjs')
        : unit.includes('[Service]') && unit.includes('runtime-loader.mjs'),
      fixture.linux.unitVariant);

    if (fixture.version === '1.4.6') {
      // The exact 1.4.6 defect: a real `Environment=` line inside [Unit].
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

// ─── Linux: post-update and recover ─────────────────────────────────────────

/** The `sudo` runner: install copies the staged file, systemctl is accepted. */
function unitCopyRunner(calls) {
  const runner = async (file, args) => {
    calls.push([file, ...args]);
    if (file !== 'sudo') return { success: false, stdout: '', stderr: `unexpected runner: ${file} ${args.join(' ')}` };
    if (args[0] === 'systemctl') return { success: true, stdout: '', stderr: '' };
    if (args[0] === 'install' && args[3] === '--' && args.length === 6) {
      fs.copyFileSync(args[4], args[5]);
      fs.chmodSync(args[5], 0o600);
      return { success: true, stdout: '', stderr: '' };
    }
    return { success: false, stdout: '', stderr: `unexpected sudo: ${args.join(' ')}` };
  };
  runner.calls = calls;
  return runner;
}

function writeDaemonLock(dataDir, version) {
  fs.mkdirSync(dataDir, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(dataDir, 'daemon.lock'), `${JSON.stringify({
    pid: process.pid,
    startedAt: now,
    heartbeatAt: now,
    version,
    mode: 'daemon',
  })}\n`);
}

async function testLinuxPostUpdate(fixtures) {
  setGroup('2. Linux: the new post-update writes a valid unit over every historical one');

  for (const fixture of fixtures) {
    const before = hashUserData(fixture.linux.userDataPaths);
    const historical = fs.readFileSync(fixture.linux.unitPath, 'utf8');
    const calls = [];
    const interactive = async (command) => ({ success: true, stdout: '', stderr: '', command });

    const result = await modules.postUpdate.applyPostUpdate({
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
          interactive,
        }),
      },
    });

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
    check(`${fixture.version}: post-update leaves the stale stop request alone (start is the authority)`,
      fs.existsSync(fixture.linux.stopRequestPath));
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
      run: async (command) => ({ success: true, stdout: '', stderr: '', command }),
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
      calls.some((call) => call[0] === 'sudo' && call[1] === 'install'),
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

// ─── Windows: post-update ───────────────────────────────────────────────────

/** A copyRuntime that refreshes the fixture's runtime package.json to the new version. */
function fakeCopyRuntime(branch, order) {
  return () => {
    order.push('copy');
    const runtimeRoot = branch.runtimeRoot;    fs.writeFileSync(path.join(runtimeRoot, 'app', 'package.json'),
      `${JSON.stringify({ name: 'easy-devops', version: TARGET_VERSION }, null, 2)}\n`);
    return {
      ok: true,
      dir: runtimeRoot,
      nodeExe: path.join(runtimeRoot, 'node.exe'),
      entry: path.join(runtimeRoot, 'app', 'src', 'cli', 'index.js'),
    };
  };
}

async function testWindowsPostUpdate(fixtures) {
  setGroup('4. Windows: post-update refreshes the runtime and protects bin/ and runtime/ for real');

  if (!modules.isWindows) {
    skip('Windows post-update and its ACL transaction', 'the Windows code paths are Windows-only');
    return;
  }

  for (const fixture of fixtures) {
    const before = hashUserData(fixture.windows.userDataPaths);
    const runtimePackage = path.join(fixture.windows.runtimeRoot, 'app', 'package.json');
    const detected = JSON.parse(fs.readFileSync(runtimePackage, 'utf8')).version;
    const order = [];
    const seed = JSON.parse(fs.readFileSync(fixture.windows.aclRecordsPath, 'utf8'));

    const outcome = await asWindowsFixture(fixture, async () => {
      const acl = createWindowsAcl(fixture.windows, seed);
      const dataRootBefore = JSON.stringify(acl.entryFor(fixture.windows.dataDir).explicit);
      const ownBefore = ownAclSnapshot(acl, fixture.windows.userDataPaths);

      const applied = await modules.postUpdate.applyPostUpdate({
        dataDir: fixture.windows.dataDir,
        mode: 'server',
        mechanism: 'winsw',
        targetVersion: TARGET_VERSION,
        nodeExe: path.join(fixture.windows.runtimeRoot, 'node.exe'),
        deps: {
          installedPackageVersion: () => TARGET_VERSION,
          copyRuntime: fakeCopyRuntime(fixture.windows, order),
          verifyNativeModules: async () => {
            order.push('native');
            return { ok: true, version: TARGET_VERSION, abi: 127, detail: 'fixture native module' };
          },
          protectServiceFiles: (options) => {
            order.push('protect');
            return modules.operator.protectServiceFiles({ ...options, runFile: acl.runFile });
          },
          refreshServiceDefinition: (options) => {
            order.push('definition');
            modules.windowsService.refreshServiceDefinition(options);
          },
        },
      });
      return { applied, acl, dataRootBefore, ownBefore };
    });

    const { applied, acl, dataRootBefore, ownBefore } = outcome;
    const xml = fs.readFileSync(fixture.windows.xmlPath, 'utf8');
    const refreshed = JSON.parse(fs.readFileSync(runtimePackage, 'utf8')).version;
    const runtimeIssues = codeRootIssues(acl, fixture.windows.runtimeRoot);
    const binIssues = codeRootIssues(acl, fixture.windows.binDir);

    check(`${fixture.version}: post-update succeeds`, applied.ok === true, applied.reason ?? '');
    check(`${fixture.version}: the older runtime copy is detected and refreshed to the package version`,
      detected !== TARGET_VERSION && refreshed === TARGET_VERSION,
      `${detected} -> ${refreshed}`);
    check(`${fixture.version}: copy, native proof, protection and definition run in that order`,
      order.join(',') === 'copy,native,protect,definition', order.join(' -> '));
    check(`${fixture.version}: the WinSW XML is well formed and points at the new runtime and the entry`,
      xml.startsWith('<service>') && xml.trimEnd().endsWith('</service>')
        && xml.includes('runtime-loader.mjs')
        && xml.includes(path.join(fixture.windows.runtimeRoot, 'node.exe'))
        && xml.includes(fixture.windows.dataDir),
      fixture.windows.xmlVariant);
    check(`${fixture.version}: every file under runtime has SYSTEM F, Administrators F and the service RX`,
      runtimeIssues.length === 0, runtimeIssues.slice(0, 2).join('; '));
    check(`${fixture.version}: every file under bin has SYSTEM F, Administrators F and the service RX`,
      binIssues.length === 0, binIssues.slice(0, 2).join('; '));
    check(`${fixture.version}: protection was not rolled back (no /restore ran)`,
      !acl.calls.some((call) => call.args.includes('/restore')));
    check(`${fixture.version}: post-update neither resets nor grants on the data root`,
      JSON.stringify(acl.entryFor(fixture.windows.dataDir).explicit) === dataRootBefore
        && acl.mutationsAt(fixture.windows.dataDir).length === 0,
      acl.mutations.map((mutation) => mutation.op).join(','));
    check(`${fixture.version}: no user-data file's own DACL changed`,
      ownBefore.length > 0 && sameRows(ownBefore, ownAclSnapshot(acl, fixture.windows.userDataPaths)));
    check(`${fixture.version}: no user-data byte changed`,
      sameRows(before, hashUserData(fixture.windows.userDataPaths)));
    check(`${fixture.version}: post-update leaves the stale stop request alone`,
      fs.existsSync(fixture.windows.stopRequestPath));
  }
}

// ─── Windows: recover ──────────────────────────────────────────────────────

async function testWindowsRecover(fixtures) {
  setGroup('5. Windows: recover restores the empty DACLs and keeps SYSTEM and Administrators');

  if (!modules.isWindows) {
    skip('Windows recoverCodePermissions', 'the Windows code paths are Windows-only');
    return;
  }

  for (const fixture of fixtures) {
    const before = hashUserData(fixture.windows.userDataPaths);
    const seed = JSON.parse(fs.readFileSync(fixture.windows.aclRecordsPath, 'utf8'));

    const outcome = await asWindowsFixture(fixture, async () => {
      const acl = createWindowsAcl(fixture.windows, seed);
      const dataRootBefore = JSON.parse(JSON.stringify(acl.entryFor(fixture.windows.dataDir).explicit));
      const ownBefore = ownAclSnapshot(acl, fixture.windows.userDataPaths);
      const recovered = await modules.windowsService.recoverCodePermissions({
        run: acl.run,
        runFile: acl.runFile,
        operator: fixture.windows.operator,
        dataDir: fixture.windows.dataDir,
        log: () => {},
      });
      return { acl, recovered, dataRootBefore, ownBefore };
    });

    const { acl, recovered, dataRootBefore, ownBefore } = outcome;
    const roots = [fixture.windows.binDir, fixture.windows.runtimeRoot, fixture.windows.runtimePrevRoot]
      .filter(Boolean);
    const issues = roots.flatMap((root) => codeRootIssues(acl, root));
    const dataRootMutations = acl.mutationsAt(fixture.windows.dataDir);
    const dataRootAfter = acl.entryFor(fixture.windows.dataDir).explicit;
    const operatorState = modules.operator.operatorAceState(acl.sc.sddl, fixture.windows.operator.sid);

    check(`${fixture.version}: recover finishes on an elevated administrator`,
      recovered.ok === true, recovered.reason ?? '');
    check(`${fixture.version}: every empty DACL is gone: SYSTEM F, Administrators F, service RX`,
      issues.length === 0, issues.slice(0, 3).join('; '));
    check(`${fixture.version}: a refused /reset takes ownership first (the A1 condition)`,
      fixture.windows.emptyAcl === false
        ? !acl.mutations.some((mutation) => mutation.op === '/reset' && mutation.refused?.length)
        : acl.mutations.some((mutation) => mutation.op === '/reset' && mutation.refused?.length)
          && acl.calls.some((call) => call.args.includes('/setowner') && call.args.includes('/T')
            && call.args[0] === path.join(fixture.windows.binDir, '*')),
      acl.mutations.filter((mutation) => mutation.refused?.length)
        .map((mutation) => `${mutation.op}:${mutation.refused.length}`).join(','));
    check(`${fixture.version}: recover never restored a saved tree (nothing failed half way)`,
      !acl.calls.some((call) => call.args.includes('/restore')));
    check(`${fixture.version}: the data root got one additive grant and nothing else`,
      dataRootMutations.length === 1
        && dataRootMutations[0].op === '/grant'
        && dataRootMutations[0].targets.length === 1
        && !acl.calls.some((call) => call.args[0] === fixture.windows.dataDir
          && (call.args.includes('/reset') || call.args.includes('/T'))),
      JSON.stringify(dataRootMutations.map((mutation) => mutation.op)));
    check(`${fixture.version}: that grant only added SYSTEM and Administrators full control`,
      hasAce(dataRootAfter, TRUSTEES.SYSTEM, ['F'])
        && hasAce(dataRootAfter, TRUSTEES.ADMINISTRATORS, ['F'])
        && dataRootBefore.every((ace) => dataRootAfter.some((now) =>
          now.trustee === ace.trustee && now.level === ace.level))
        && dataRootAfter.length <= dataRootBefore.length + 2,
      `${dataRootBefore.length} -> ${dataRootAfter.length}`);
    check(`${fixture.version}: no data file lost an ACE or had its own DACL rewritten`,
      ownBefore.length > 0 && sameRows(ownBefore, ownAclSnapshot(acl, fixture.windows.userDataPaths)));
    check(`${fixture.version}: recovery issued no command against a data file`,
      acl.mutationsInside(fixture.windows.userDataPaths).length === 0,
      acl.mutationsInside(fixture.windows.userDataPaths).map((mutation) => mutation.op).join(','));
    check(`${fixture.version}: the descriptor the code wrote keeps SYSTEM and Administrators full control`,
      acl.sc.writes === 1 && modules.operator.missingServiceDefaults(acl.sc.sddl).length === 0,
      modules.operator.missingServiceDefaults(acl.sc.sddl).join(',') || 'ok');
    check(`${fixture.version}: the installing account keeps start/stop/query and nothing more`,
      operatorState.granted === true && operatorState.excessive === false,
      JSON.stringify(operatorState));
    check(`${fixture.version}: not one byte of user data changed`,
      sameRows(before, hashUserData(fixture.windows.userDataPaths)));
  }
}

// ─── Windows: repair and start after recover ───────────────────────────────

async function testWindowsRepairAndStart(fixtures) {
  setGroup('6. Windows: after recover, repair and start reach the daemon heartbeat');

  if (!modules.isWindows) {
    skip('Windows repair and start', 'the Windows code paths are Windows-only');
    return;
  }

  for (const fixture of fixtures) {
    const before = hashUserData(fixture.windows.userDataPaths);
    const repairs = [];
    const starts = [];

    const repaired = await asWindowsFixture(fixture, () => modules.service.repair({
      deps: {
        windowsService: {
          async repair(options) {
            repairs.push(options);
            return { ok: true, granted: [fixture.windows.dataDir] };
          },
        },
        resolveOperator: async () => fixture.windows.operator,
        repairPrivateKeys: async () => {},
      },
    }));

    const started = await asWindowsFixture(fixture, () => modules.service.start({
      deps: {
        windowsService: {
          async start() {
            starts.push(true);
            writeDaemonLock(fixture.windows.dataDir, TARGET_VERSION);
            return { ok: true, pid: process.pid };
          },
        },
        startupGraceMs: 2_000,
      },
    }));

    const state = modules.service.backgroundServiceState({
      dataDir: fixture.windows.dataDir,
      deps: {
        mechanism: { platform: 'windows', mode: 'server', mechanism: 'winsw' },
        fs: { lstatSync: () => ({}) },
      },
    });

    check(`${fixture.version}: repair asks for the WinSW mechanism and succeeds`,
      repaired.ok === true && repaired.mechanism === 'winsw' && repairs.length === 1,
      repaired.reason ?? '');
    check(`${fixture.version}: repair clears the stale stop request it inherited`,
      !fs.existsSync(fixture.windows.stopRequestPath));
    check(`${fixture.version}: start is reached and the heartbeat reports the new version`,
      started.ok === true && starts.length === 1
        && JSON.parse(fs.readFileSync(path.join(fixture.windows.dataDir, 'daemon.lock'), 'utf8')).version === TARGET_VERSION,
      started.reason ?? '');
    check(`${fixture.version}: status is no longer "stopped by you"`,
      state.stoppedByUser === false && state.running === true && state.stoppedAt === null);
    check(`${fixture.version}: repair and start leave user data byte-identical`,
      sameRows(before, hashUserData(fixture.windows.userDataPaths)));
  }
}

// ─── A5: "stopped by you" is live state only ───────────────────────────────

async function testStopRequestSemantics(fixtures) {
  setGroup('7. A5: "stopped by you" comes from the live request, never a recorded stop');

  for (const fixture of fixtures) {
    const branch = modules.isWindows ? fixture.windows : fixture.linux;
    const mechanism = modules.isWindows
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

// ─── The update handoff ─────────────────────────────────────────────────────

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
    const branch = modules.isWindows ? fixture.windows : fixture.linux;
    const mode = modules.isWindows ? 'server' : null;
    const mechanism = modules.isWindows ? 'winsw' : 'systemd';
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

// ─── The real update transaction (B2: the rollback that left nothing) ──────

async function testUpdateTransaction(fixtures) {
  setGroup('9. the real update transaction puts the 1.4.6 XML and runtime copy back together');

  if (!modules.isWindows) {
    skip('Windows Server transaction (XML and runtime copy together)', 'the runtime copy is Windows-only');
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
    // Captured before the restore: the journal is meant to disappear with it.
    const movedAside = Boolean(snapshot.activeRuntime)
      && !fs.existsSync(snapshot.activeRuntime)
      && Boolean(snapshot.runtimeBackup)
      && fs.existsSync(snapshot.runtimeBackup)
      && fs.existsSync(journal);

    // What the failed 1.4.6 update did: the new package wrote a runtime and an
    // XML, and then nothing started.
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

// ─── Rollback contract ─────────────────────────────────────────────────────

async function testRollbackContract(fixtures) {
  setGroup('10. a failed new post-update restores the old state and proves its heartbeat');

  const fixture = fixtures.find((entry) => entry.version === '1.4.3');
  const branch = modules.isWindows ? fixture.windows : fixture.linux;
  const before = hashUserData(branch.userDataPaths);
  const order = [];
  const service = updateServiceStub({
    mode: modules.isWindows ? 'server' : null,
    mechanism: modules.isWindows ? 'winsw' : 'systemd',
    order,
  });

  // The rollback's heartbeat must report the OLD version.
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

// ─── main ──────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write('\nHistorical service upgrade matrix\n');
  process.stdout.write(`data dir: ${TEST_DATA_DIR}\n`);

  const fixtures = materializeUpgradeFixtures(scratch('fixtures-upgrade'));
  const recoveryFixtures = materializeUpgradeFixtures(scratch('fixtures-recovery'));
  const transactionFixtures = materializeUpgradeFixtures(scratch('fixtures-transaction'));

  modules = {
    platform: await import(srcUrl('core/platform.js')),
    systemd: await import(srcUrl('core/service/systemd.js')),
    windowsService: await import(srcUrl('core/service/windowsService.js')),
    operator: await import(srcUrl('core/service/operator.js')),
    postUpdate: await import(srcUrl('core/service/postUpdate.js')),
    updateTransaction: await import(srcUrl('core/service/updateTransaction.js')),
    runtime: await import(srcUrl('core/service/runtime.js')),
    updater: await import(srcUrl('core/updater.js')),
    service: await import(srcUrl('core/service/index.js')),
    db: await import(srcUrl('core/db.js')),
  };
  modules.isWindows = modules.platform.isWindows;

  try {
    await testFixtureIntegrity(fixtures);
    await testLinuxPostUpdate(fixtures);
    await testLinuxRecover(recoveryFixtures);
    await testWindowsPostUpdate(fixtures);
    await testWindowsRecover(recoveryFixtures);
    await testWindowsRepairAndStart(recoveryFixtures);
    await testStopRequestSemantics(fixtures);
    await testHandoffOrder(fixtures);
    await testUpdateTransaction(transactionFixtures);
    await testRollbackContract(fixtures);
  } finally {
    modules.db.closeDb();
  }

  const failed = results.filter((result) => !result.passed);
  const skipped = results.filter((result) => result.skipped);
  process.stdout.write(`\n${'-'.repeat(68)}\n`);
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
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? String(error)}\n`);
  process.exit(1);
});
