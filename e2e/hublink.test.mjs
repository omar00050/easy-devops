/**
 * Unit tests for src/core/hubLink.js and the agent status machine.
 *
 * Run with:  npm run test:e2e -- hublink
 *
 * Plain Node script on purpose: the easy-devops constitution forbids adding a
 * test framework to this project, so this uses no dependencies and no runner.
 *
 * Runs entirely against a TEMPORARY config directory: APPDATA/HOME are pointed
 * at a scratch dir before src/core/db.js is loaded, so the real
 * %APPDATA%\easy-devops\easy-devops.sqlite is never opened or written.
 *
 * It also pre-creates a zero-byte DB file in the scratch dir, because
 * db.js runs migrateIfNeeded() at import time, which would otherwise COPY
 * data/easy-devops.sqlite to the new location and RENAME the original to
 * .migrated. A pre-existing DB file makes that migration a no-op.
 *
 * Secrets are never printed.
 */

// MUST be the first import: ESM evaluates the static import graph before any
// line of this file runs, so only an import can act before the rest load. It
// refuses to run unless EZ_TEST and a throwaway EASY_DEVOPS_DATA_DIR are set.
// Run the suites with `npm run test:e2e` (see e2e/run.mjs).
import './lib/guard.mjs';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { once } from 'events';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// This script lives in <project>/e2e/, so the project root is one level up.
const ROOT = path.resolve(__dirname, '..');
const REAL_LEGACY_DB = path.join(ROOT, 'data', 'easy-devops.sqlite');

// ── Child process: runs the actual assertions under the temp config ──────────
const CHILD = String.raw`
import assert from 'assert';
import { createServer } from 'http';
import { Server as SocketIO } from 'socket.io';

const out = [];
const check = (label, passed, detail = '') => out.push({ label, passed, detail });

const hl = await import('./src/core/hubLink.js');

// ── parse / validate: valid strings ─────────────────────────────────────────
const VALID = [
  ['https url',      'ezops://https://hub.example.com|srv-1|' + 'a'.repeat(64)],
  ['http url + port','ezops://http://localhost:4000|srv-2|deadbeef'],
  ['bare host',      'ezops://hub.example.com|srv-3|deadbeef'],
  ['bare host:port', 'ezops://hub.example.com:4000|srv-4|deadbeef'],
  ['surrounding ws', '   ezops://http://localhost:4000|srv-5|deadbeef   '],
];
for (const [label, str] of VALID) {
  const r = hl.parseConnectionString(str);
  check('valid: ' + label, r.ok === true, r.ok ? '' : r.error);
}

// field extraction
const p = hl.parseConnectionString('ezops://http://localhost:4000|srv-x|abc123');
check('parse extracts hubUrl',   p.ok && p.link.hubUrl === 'http://localhost:4000', p.ok ? p.link.hubUrl : '');
check('parse extracts serverId', p.ok && p.link.serverId === 'srv-x');
check('parse extracts secret',   p.ok && p.link.secret === 'abc123');

// ── parse / validate: invalid strings ───────────────────────────────────────
const INVALID = [
  ['empty',            ''],
  ['null',             null],
  ['undefined',        undefined],
  ['number',           12345],
  ['object',           { a: 1 }],
  ['no prefix',        'http://hub.example.com|id|sec'],
  ['wrong prefix',     'ezzops://hub.example.com|id|sec'],
  ['two parts',        'ezops://hub.example.com|id'],
  ['four parts',       'ezops://hub.example.com|id|sec|extra'],
  ['empty hubUrl',     'ezops://|id|sec'],
  ['empty serverId',   'ezops://hub.example.com||sec'],
  ['empty secret',     'ezops://hub.example.com|id|'],
  ['space in hubUrl',  'ezops://not a url|id|sec'],
  ['javascript: url',  'ezops://javascript:alert(1)|id|sec'],
  ['file: url',        'ezops://file:///etc/passwd|id|sec'],
  ['oversized',        'ezops://hub.example.com|id|' + 'z'.repeat(5000)],
  ['newline in id',    'ezops://hub.example.com|id\nevil|sec'],
  ['space in secret',  'ezops://hub.example.com|id|sec ret'],
];
for (const [label, str] of INVALID) {
  const r = hl.parseConnectionString(str);
  check('invalid: ' + label, r.ok === false && typeof r.error === 'string' && r.error.length > 0,
        r.ok ? 'WRONGLY ACCEPTED' : '');
}

// ── resolveHubOrigin ────────────────────────────────────────────────────────
check('origin: bare host gets https', hl.resolveHubOrigin('hub.example.com') === 'https://hub.example.com');
check('origin: http preserved',       hl.resolveHubOrigin('http://localhost:4000') === 'http://localhost:4000');
check('origin: trailing slash dropped', hl.resolveHubOrigin('http://localhost:4000/') === 'http://localhost:4000');

// ── save / read / clear against the TEMP config ─────────────────────────────
check('starts unlinked', hl.isLinked() === false, 'temp config should be empty');

const saved = hl.saveConnectionString('ezops://http://localhost:4399|srv-temp|' + 'f'.repeat(64));
check('saveConnectionString ok', saved.ok === true, saved.ok ? '' : saved.error);
check('isLinked after save', hl.isLinked() === true);

const read = hl.getHubLink();
check('read back hubUrl',   read?.hubUrl === 'http://localhost:4399');
check('read back serverId', read?.serverId === 'srv-temp');
check('read back secret length', read?.secret?.length === 64);

const st = hl.getLinkStatus();
check('status reports linked', st.linked === true);
check('status omits the secret', !JSON.stringify(st).includes('f'.repeat(64)));
// Permissions use the catalog in core/hubPermissions.js (leaf ids), not the
// three legacy booleans. See e2e/hub-permissions.test.mjs for the full tree.
check('permissions default to all-false',
  Object.values(st.permissions).length > 0 && Object.values(st.permissions).every(v => v === false));

// permissions update + preservation across re-pair
hl.saveHubPermissions({ 'nginx.reload': true, 'ssl.renew': true });
check('permissions updated',
  hl.getHubPermissions()['nginx.reload'] === true && hl.getHubPermissions()['ssl.renew'] === true);
hl.saveHubPermissions({ bogusKey: true, 'nginx.reload': 'yes' });
const perms = hl.getHubPermissions();
check('unknown permission keys ignored', perms.bogusKey === undefined);
check('non-boolean permission ignored', perms['nginx.reload'] === true);

hl.saveConnectionString('ezops://http://localhost:4399|srv-temp2|' + 'e'.repeat(64));
check('re-pair preserves granted permissions', hl.getHubPermissions()['nginx.reload'] === true);
check('re-pair replaces serverId', hl.getHubLink()?.serverId === 'srv-temp2');

// ── rejection classification ────────────────────────────────────────────────
for (const m of ['AUTH_REQUIRED', 'UNKNOWN_SERVER', 'INVALID_SECRET']) {
  check('isAuthRejection(' + m + ')', hl.isAuthRejection(m) === true);
  check('describeRejection(' + m + ') is human text', typeof hl.describeRejection(m) === 'string' && hl.describeRejection(m).length > 10);
}
for (const m of ['xhr poll error', 'timeout', 'websocket error', 'ECONNREFUSED', 'AUTH_UNAVAILABLE', '', null, undefined, 'invalid_secret']) {
  check('NOT rejection: ' + JSON.stringify(m), hl.isAuthRejection(m) === false);
}

// ── live status machine: unreachable (nothing listening) ────────────────────
hl.saveConnectionString('ezops://http://127.0.0.1:1|srv-temp|' + 'd'.repeat(64));
const agent = await import('./src/core/hub/agent.js');
agent.initHubAgent();
const s1 = agent.getHubAgentStatus();
check('status is connecting immediately after init', s1.status === 'connecting', s1.status);
await new Promise(r => setTimeout(r, 2500));
const s2 = agent.getHubAgentStatus();
check('unreachable hub -> status "unreachable"', s2.status === 'unreachable', s2.status);
check('unreachable retries (attempts > 1)', s2.attempts > 1, 'attempts=' + s2.attempts);
check('unreachable lastError is human text', typeof s2.lastError === 'string' && s2.lastError.includes('Cannot reach'));
check('unreachable status leaks no secret', !JSON.stringify(s2).includes('d'.repeat(64)));
agent.stopHubAgent();

// ── live status machine: rejected (real server refusing the handshake) ──────
const httpServer = createServer();
const ioServer = new SocketIO(httpServer);
ioServer.of('/agent-socket').use((_s, next) => next(new Error('INVALID_SECRET')));
await new Promise(r => httpServer.listen(4399, r));

hl.saveConnectionString('ezops://http://127.0.0.1:4399|srv-temp|' + 'c'.repeat(64));
agent.initHubAgent();
await new Promise(r => setTimeout(r, 2500));
const s3 = agent.getHubAgentStatus();
check('rejected handshake -> status "rejected"', s3.status === 'rejected', s3.status);
check('rejected does not retry (attempts === 0)', s3.attempts === 0, 'attempts=' + s3.attempts);
check('rejected lastError explains re-pairing', typeof s3.lastError === 'string' && s3.lastError.length > 10);
check('rejected status leaks no secret', !JSON.stringify(s3).includes('c'.repeat(64)));

// stays rejected (no retry loop resurrecting it)
await new Promise(r => setTimeout(r, 1500));
const s4 = agent.getHubAgentStatus();
check('still rejected after waiting (no retry loop)', s4.status === 'rejected' && s4.attempts === 0, s4.status + '/' + s4.attempts);

agent.stopHubAgent();
ioServer.close();
httpServer.close();

// ── clear ───────────────────────────────────────────────────────────────────
hl.clearHubLink();
check('clearHubLink unlinks', hl.isLinked() === false);
check('clearHubLink clears link', hl.getHubLink() === null);
check('permissions reset to defaults after clear', hl.getHubPermissions()['nginx.reload'] === false);

console.log('@@RESULTS@@' + JSON.stringify(out));
process.exit(0);
`;

async function main() {
  const legacyBefore = fs.existsSync(REAL_LEGACY_DB)
    ? fs.statSync(REAL_LEGACY_DB).mtimeMs
    : null;

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ezdevops-hublink-'));
  const cfgDir = path.join(tmpRoot, 'easy-devops');
  fs.mkdirSync(cfgDir, { recursive: true });
  // Zero-byte file = valid empty SQLite db, and makes db.js's migration a no-op.
  fs.writeFileSync(path.join(cfgDir, 'easy-devops.sqlite'), '');

  // The child must live inside the project so bare imports (socket.io) and
  // relative imports (./src/core/...) resolve against the project's node_modules.
  const childFile = path.join(ROOT, 'hublink.child.tmp.mjs');
  fs.writeFileSync(childFile, CHILD);

  const child = spawn(process.execPath, [childFile], {
    cwd: ROOT,
    env: {
      ...process.env,
      // Both guard variables are passed through explicitly rather than left
      // to inheritance: a child that loses them would resolve the REAL data
      // directory, and EZ_TEST=1 makes that throw rather than happen quietly.
      EZ_TEST: '1',
      EASY_DEVOPS_DATA_DIR: cfgDir,
      APPDATA: tmpRoot,   // Windows config root
      HOME: tmpRoot,      // POSIX config root
      USERPROFILE: tmpRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const [code] = await once(child, 'exit');

  const marker = stdout.indexOf('@@RESULTS@@');
  if (marker === -1) {
    process.stderr.write(`child produced no results (exit ${code})\n`);
    process.stderr.write(stdout.slice(0, 4000) + '\n');
    process.stderr.write(stderr.slice(0, 4000) + '\n');
  } else {
    const results = JSON.parse(stdout.slice(marker + '@@RESULTS@@'.length));
    let failed = 0;
    for (const r of results) {
      if (!r.passed) failed++;
      process.stdout.write(`   ${r.passed ? 'PASS' : 'FAIL'}  ${r.label}${r.detail ? `  (${r.detail})` : ''}\n`);
    }
    process.stdout.write(`\nTOTAL ${results.length}   PASS ${results.length - failed}   FAIL ${failed}\n`);
    if (failed) process.exitCode = 1;
  }

  // ── Prove the real config and legacy DB were untouched ────────────────────
  const legacyAfter = fs.existsSync(REAL_LEGACY_DB)
    ? fs.statSync(REAL_LEGACY_DB).mtimeMs
    : null;
  process.stdout.write(`\nIsolation checks:\n`);
  process.stdout.write(`   ${legacyAfter === legacyBefore ? 'PASS' : 'FAIL'}  data/easy-devops.sqlite untouched (not migrated/renamed)\n`);
  process.stdout.write(`   ${!fs.existsSync(REAL_LEGACY_DB + '.migrated') ? 'PASS' : 'FAIL'}  no .migrated file was created\n`);
  const tempDbUsed = fs.existsSync(path.join(cfgDir, 'easy-devops.sqlite'));
  process.stdout.write(`   ${tempDbUsed ? 'PASS' : 'FAIL'}  temp config dir was used\n`);
  if (legacyAfter !== legacyBefore || fs.existsSync(REAL_LEGACY_DB + '.migrated')) process.exitCode = 1;

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(childFile, { force: true });
  process.stdout.write(`   cleaned up temp config dir and child script\n`);
}

main().catch((e) => { process.stderr.write(String(e.stack || e) + '\n'); process.exit(1); });
