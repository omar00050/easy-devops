/**
 * End-to-end tests for `ezz hub connect | status | unlink`.
 *
 * Run with:  npm run test:e2e -- hub-connect-cli
 *
 * The CLI is driven as a real child process with EZ_TEST=1 and a temp
 * EASY_DEVOPS_DATA_DIR in its environment (the only way the data directory is
 * settled before core/db.js loads). The Hub is a stub on 127.0.0.1; no real
 * network call is made — not to a Hub, GitHub, DNS or Let's Encrypt.
 *
 * Every assertion looks at the FULL stdout+stderr, because the rule is that the
 * secret, the one-time token and the connection string never appear anywhere.
 */

import './lib/guard.mjs';
import { TEST_DATA_DIR, assertInsideTestDataDir } from './lib/guard.mjs';

import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const results = [];
let group = '';
function setGroup(g) { group = g; process.stdout.write(`\n── ${g}\n`); }
function check(label, passed, detail = '') {
  results.push({ group, label, passed, detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}

const srcUrl = (rel) => pathToFileURL(path.join(ROOT, 'src', rel)).href;
const token = () => crypto.randomBytes(32).toString('base64url');

function streamedResponse(status, chunks, headers = {}) {
  let chunksConsumed = 0;
  let cancelCalls = 0;
  const response = new Response(new ReadableStream({
    pull(controller) {
      if (chunksConsumed === chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[chunksConsumed]);
      chunksConsumed += 1;
    },
    cancel() {
      cancelCalls += 1;
    },
  }, { highWaterMark: 0 }), { status, headers });

  return {
    response,
    stats: () => ({ chunksConsumed, cancelCalls }),
    isLocked: () => response.body.locked,
  };
}

function scratch(name) {
  const dir = path.join(TEST_DATA_DIR, 'scratch', name);
  assertInsideTestDataDir(dir, `create the scratch dir ${name}`);
  fs.mkdirSync(dir, { recursive: true });
  // A zero-byte file is a valid empty SQLite database and makes db.js's
  // legacy migration a no-op, so the real data/ file is never copied.
  const db = path.join(dir, 'easy-devops.sqlite');
  if (!fs.existsSync(db)) fs.writeFileSync(db, '');
  return dir;
}

/** Runs the real CLI entry point with an isolated data directory. */
function runCli(args, { dataDir, extraEnv = {}, timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src/cli/index.js'), ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        EZ_TEST: '1',
        EASY_DEVOPS_DATA_DIR: dataDir,
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, signal, stdout, stderr, out: stdout + stderr, timedOut });
    });
  });
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/** Starts a stub Hub on a random loopback port. */
function startStub(handler) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push({ method: req.method, url: req.url });
      handler(req, res, requests);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        origin: `http://127.0.0.1:${port}`,
        requests,
        link: (t) => `http://127.0.0.1:${port}/api/v1/connect/cli/${t}`,
        async close() {
          server.closeAllConnections?.();
          await new Promise((r) => server.close(r));
        },
      });
    });
  });
}

const connectionStringFor = (origin, serverId = 'server-1') =>
  `ezops://${origin}|${serverId}|${crypto.randomBytes(32).toString('hex')}`;

/** None of these may appear in any output, ever. */
function forbiddenIn(output, values) {
  return values.filter((value) => value && output.includes(value));
}

function reportForbidden(label, result, values) {
  const leaked = forbiddenIn(result.out, values);
  // Never print the value that leaked: the point is that it must not appear.
  check(label, leaked.length === 0, leaked.length ? `${leaked.length} forbidden value(s) appeared` : '');
}

async function testHappyPathAndLifecycle() {
  setGroup('1. happy path, status and unlink');

  const hub = await startStub((_req, res) => {
    sendJson(res, 200, { connectionString: cs });
  });
  const dataDir = scratch('happy');
  const t = token();
  const cs = connectionStringFor(hub.origin, 'server-1');
  const link = hub.link(t);

  try {
    const connect = await runCli(['hub', 'connect', link, '--yes'], { dataDir });
    check('connect exits 0', connect.code === 0, `exit ${connect.code}`);
    check('it names the Hub origin and server id',
      connect.out.includes(`Linked to ${hub.origin}`) && connect.out.includes('server-1'));
    check('with no daemon it says the service is not running',
      connect.out.includes('background service is not running') && connect.out.includes('ezz service start'));
    reportForbidden('connect prints no secret, token or connection string', connect, [cs, t, 'ezops://', '/connect/cli/']);

    const status = await runCli(['hub', 'status'], { dataDir });
    check('status exits 0', status.code === 0, `exit ${status.code}`);
    check('status shows the origin and server id',
      status.out.includes(hub.origin) && status.out.includes('server-1'));
    check('status lists the permissions summary', /Permissions:/.test(status.out));
    check('status says the agent is not connected without a daemon',
      /background service is not running/.test(status.out));
    reportForbidden('status prints no secret, token or connection string', status, [cs, t, 'ezops://', '/connect/cli/']);

    const unlink = await runCli(['hub', 'unlink', '--yes'], { dataDir });
    check('unlink exits 0', unlink.code === 0, `exit ${unlink.code}`);
    check('it explains what happens on the Hub side',
      unlink.out.includes('stays listed in the Hub as offline'));
    reportForbidden('unlink prints no secret', unlink, [cs, t, 'ezops://']);

    const after = await runCli(['hub', 'status'], { dataDir });
    check('status reports not linked afterwards', /Not linked/.test(after.out));
    check('and the old token is still absent', !after.out.includes(t));
  } finally {
    await hub.close();
  }
}

async function testDeadLinks() {
  setGroup('2. dead links are explained, never echoed');

  const cases = [
    { name: 'already used', status: 410, body: { code: 'LINK_USED' }, expect: /already used/i },
    { name: 'expired', status: 410, body: { code: 'LINK_EXPIRED' }, expect: /expired/i },
    { name: 'replaced', status: 410, body: { code: 'LINK_REPLACED' }, expect: /newer pairing link/i },
    { name: 'revoked', status: 410, body: { code: 'LINK_REVOKED' }, expect: /cancelled/i },
    { name: 'unknown', status: 404, body: { code: 'LINK_UNKNOWN' }, expect: /does not recognise/i },
  ];

  for (const c of cases) {
    const hub = await startStub((_req, res) => sendJson(res, c.status, c.body));
    const dataDir = scratch(`dead-${c.name.replace(/\s+/g, '-')}`);
    const t = token();
    try {
      const result = await runCli(['hub', 'connect', hub.link(t), '--yes'], { dataDir });
      check(`${c.name}: refused with exit 1`, result.code === 1, `exit ${result.code}`);
      check(`${c.name}: the message explains why`, c.expect.test(result.out), result.out.trim().split('\n').pop());
      reportForbidden(`${c.name}: no token or link in the output`, result, [t, '/connect/cli/', 'ezops://']);
    } finally {
      await hub.close();
    }
  }
}

async function testSecondUseOfTheSameLink() {
  setGroup('3. a link works once');

  let served = false;
  const hub = await startStub((_req, res) => {
    if (served) return sendJson(res, 410, { code: 'LINK_USED' });
    served = true;
    return sendJson(res, 200, { connectionString: connectionStringFor(hub.origin) });
  });
  const dataDir = scratch('second-use');
  const t = token();

  try {
    const first = await runCli(['hub', 'connect', hub.link(t), '--yes'], { dataDir });
    check('the first use succeeds', first.code === 0, `exit ${first.code}`);

    const second = await runCli(['hub', 'connect', hub.link(t), '--yes'], { dataDir });
    check('the second use is refused', second.code === 1, `exit ${second.code}`);
    check('and says it was already used', /already used/i.test(second.out));
    reportForbidden('no token leaked on the second use', second, [t, '/connect/cli/']);
  } finally {
    await hub.close();
  }
}

async function testRateLimited() {
  setGroup('4. rate limited');

  const hub = await startStub((_req, res) =>
    sendJson(res, 429, { code: 'RATE_LIMITED' }, { 'Retry-After': '42' }));
  const dataDir = scratch('rate-limited');
  const t = token();

  try {
    const result = await runCli(['hub', 'connect', hub.link(t), '--yes'], { dataDir });
    check('refused with exit 1', result.code === 1, `exit ${result.code}`);
    check('the message says too many attempts', /Too many pairing attempts/i.test(result.out));
    check('and repeats the Hub’s wait', result.out.includes('42s'));
    reportForbidden('no token leaked', result, [t, '/connect/cli/']);
  } finally {
    await hub.close();
  }
}

async function testUnreachable() {
  setGroup('5. unreachable Hub');

  const dataDir = scratch('unreachable');
  const t = token();
  // Nothing listens on port 1; no DNS and no external network are involved.
  const link = `http://127.0.0.1:1/api/v1/connect/cli/${t}`;

  const result = await runCli(['hub', 'connect', link, '--yes'], { dataDir });
  check('refused with exit 1', result.code === 1, `exit ${result.code}`);
  check('the message says the Hub could not be reached', /Could not reach the Hub/i.test(result.out));
  reportForbidden('no token leaked', result, [t, '/connect/cli/']);
}

async function testTimeout() {
  setGroup('6. a Hub that never answers');

  const hub = await startStub(() => { /* deliberately never respond */ });
  const dataDir = scratch('timeout');
  const t = token();

  try {
    const result = await runCli(['hub', 'connect', hub.link(t), '--yes'], {
      dataDir,
      // Honoured only under EZ_TEST=1; the test needs a short wait.
      extraEnv: { EZ_HUB_CONNECT_TIMEOUT_MS: '300' },
      timeoutMs: 15_000,
    });
    check('the CLI itself exits (the fetch is bounded)', !result.timedOut && result.code === 1,
      result.timedOut ? 'CLI had to be killed' : `exit ${result.code}`);
    check('the message says the Hub did not answer in time', /did not answer in time/i.test(result.out));
    reportForbidden('no token leaked', result, [t, '/connect/cli/']);
  } finally {
    await hub.close();
  }
}

async function testInsecureHttp() {
  setGroup('7. plain http is refused for a non-local host');

  const dataDir = scratch('insecure');
  const t = token();
  const link = `http://hub.example.com/api/v1/connect/cli/${t}`;

  const result = await runCli(['hub', 'connect', link, '--yes'], { dataDir });
  check('refused with exit 1', result.code === 1, `exit ${result.code}`);
  check('the message says https is required', /must use https/i.test(result.out));
  check('no connection was attempted', /example\.com\/api/.test(result.out) === false);
  reportForbidden('no token leaked', result, [t, '/connect/cli/']);
}

async function testRawConnectionString() {
  setGroup('8. a raw ezops:// string is accepted');

  const dataDir = scratch('raw');
  const secret = crypto.randomBytes(32).toString('hex');
  const cs = `ezops://http://127.0.0.1:4444|server-raw|${secret}`;

  const result = await runCli(['hub', 'connect', cs, '--yes'], { dataDir });
  check('accepted with exit 0', result.code === 0, `exit ${result.code}`);
  check('it identifies the pairing without the secret',
    result.out.includes('Linked to http://127.0.0.1:4444') && result.out.includes('server-raw'));
  check('no daemon still means the honest "not connected yet" message',
    /background service is not running/.test(result.out));
  reportForbidden('the raw connection string and secret are never printed', result, [cs, secret, 'ezops://']);

  const status = await runCli(['hub', 'status'], { dataDir });
  check('status reports the raw pairing', status.out.includes('server-raw') && status.out.includes('127.0.0.1:4444'));
  reportForbidden('status prints no secret', status, [secret, 'ezops://']);
}

async function testAlreadyLinkedNonTty() {
  setGroup('9. already linked: non-TTY refuses without --yes');

  const dataDir = scratch('already-linked');
  const firstSecret = crypto.randomBytes(32).toString('hex');
  const secondSecret = crypto.randomBytes(32).toString('hex');
  const first = `ezops://http://127.0.0.1:4444|server-a|${firstSecret}`;
  const second = `ezops://http://127.0.0.1:4445|server-b|${secondSecret}`;

  const linked = await runCli(['hub', 'connect', first, '--yes'], { dataDir });
  check('the first pairing succeeds', linked.code === 0, `exit ${linked.code}`);

  const refused = await runCli(['hub', 'connect', second], { dataDir });
  check('re-pairing a different server without --yes is refused', refused.code === 1, `exit ${refused.code}`);
  check('it names the existing link', refused.out.includes('server-a') && refused.out.includes('127.0.0.1:4444'));
  check('and says exactly what to type', /--yes/.test(refused.out));
  reportForbidden('the refusal leaks neither secret', refused, [firstSecret, secondSecret, 'ezops://']);

  const replaced = await runCli(['hub', 'connect', second, '--yes'], { dataDir });
  check('--yes replaces the link', replaced.code === 0, `exit ${replaced.code}`);

  const status = await runCli(['hub', 'status'], { dataDir });
  check('status now shows the new pairing', status.out.includes('server-b') && status.out.includes('127.0.0.1:4445'));
  reportForbidden('status leaks neither secret', status, [firstSecret, secondSecret, 'ezops://']);
}

async function testHubConnectUnitChecks() {
  setGroup('10. hubConnect.js unit checks');

  const hc = await import(srcUrl('core/hubConnect.js'));
  const t = token();
  const good = `https://hub.example.com/api/v1/connect/cli/${t}`;

  const parsed = hc.parseConnectTarget(good);
  check('a valid https link is accepted', parsed.ok === true && parsed.kind === 'link');
  check('linkOrigin() returns the origin without the token',
    hc.linkOrigin(parsed.url) === 'https://hub.example.com');

  const insecure = hc.parseConnectTarget(`http://hub.example.com/api/v1/connect/cli/${t}`);
  check('http for a non-local host is INSECURE', insecure.ok === false && insecure.code === hc.CONNECT_ERRORS.INSECURE);

  const local = hc.parseConnectTarget(`http://127.0.0.1:4000/api/v1/connect/cli/${t}`);
  check('http for loopback is accepted', local.ok === true && local.kind === 'link');

  const bogus = hc.parseConnectTarget('https://hub.example.com/not-a-link');
  check('an unrelated URL is INVALID_INPUT', bogus.ok === false && bogus.code === hc.CONNECT_ERRORS.INVALID_INPUT);
  check('the error never echoes the input', !bogus.error.includes('not-a-link'));

  const secret = crypto.randomBytes(32).toString('hex');
  const raw = await hc.resolveConnectInput(`ezops://http://127.0.0.1:4444|srv|${secret}`);
  check('a raw ezops:// string resolves without fetching',
    raw.ok === true && raw.source === 'string' && raw.connectionString.includes('srv'));
  check('the resolved value carries no token/link path',
    !raw.connectionString.includes('/connect/cli/'));

  const remoteHttpRaw = `ezops://http://hub.example.com|srv|${secret}`;
  const rawRejected = await hc.resolveConnectInput(remoteHttpRaw);
  check('a raw pairing to a remote plain-HTTP Hub is rejected before saving',
    rawRejected.ok === false && /https.*remote host/i.test(rawRejected.error ?? ''),
    rawRejected.error ?? String(rawRejected.ok));

  let fetchedBodies = 0;
  const remoteHttpFetched = await hc.fetchConnectionString(good, {
    fetch: async () => {
      fetchedBodies += 1;
      return new Response(JSON.stringify({ connectionString: remoteHttpRaw }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    timeoutMs: 1_000,
  });
  check('a fetched pairing that downgrades to remote plain HTTP is rejected',
    remoteHttpFetched.ok === false && remoteHttpFetched.code === hc.CONNECT_ERRORS.REJECTED
      && fetchedBodies === 1,
    remoteHttpFetched.error ?? remoteHttpFetched.code);

  const db = await import(srcUrl('core/db.js'));
  const links = await import(srcUrl('core/hubLink.js'));
  db.dbSet('hub-link', {
    hubUrl: 'http://legacy.example.com',
    serverId: 'legacy-server',
    secret,
  });
  check('a legacy stored remote plain-HTTP link fails closed',
    links.getHubLink() === null && links.isLinked() === false);
}

async function testStreamedResponseBounds() {
  setGroup('11. Hub responses are byte-bounded while streaming');

  const hc = await import(srcUrl('core/hubConnect.js'));
  const link = `https://hub.example.com/api/v1/connect/cli/${token()}`;
  const chunks = Array.from({ length: 16 }, () => new Uint8Array(4 * 1024).fill(0x20));

  for (const c of [
    { status: 200, code: hc.CONNECT_ERRORS.REJECTED },
    { status: 500, code: hc.CONNECT_ERRORS.UNREACHABLE },
  ]) {
    const fixture = streamedResponse(c.status, chunks);
    check(`${c.status}: fixture declares no Content-Length`,
      !fixture.response.headers.has('content-length'));

    const result = await hc.fetchConnectionString(link, {
      fetch: async () => fixture.response,
      timeoutMs: 1_000,
    });
    const stats = fixture.stats();
    check(`${c.status}: an undeclared oversized body is rejected`,
      result.ok === false && result.code === c.code);
    check(`${c.status}: reading stops in the first chunk over 16 KiB`,
      stats.chunksConsumed === 5, `${stats.chunksConsumed} chunks`);
    check(`${c.status}: the reader is cancelled`, stats.cancelCalls === 1);
    check(`${c.status}: the response body is unlocked`, fixture.isLocked() === false);
  }

  const declared = streamedResponse(200, chunks, { 'Content-Length': String(16 * 1024 + 1) });
  const declaredResult = await hc.fetchConnectionString(link, {
    fetch: async () => declared.response,
    timeoutMs: 1_000,
  });
  const declaredStats = declared.stats();
  check('a declared oversized body is rejected before any chunk is read',
    declaredResult.ok === false && declaredResult.code === hc.CONNECT_ERRORS.REJECTED);
  check('the declared oversized body is not consumed', declaredStats.chunksConsumed === 0);
  check('the declared oversized body is cancelled', declaredStats.cancelCalls === 1);
  check('the rejected response body is unlocked', declared.isLocked() === false);

  const exactChunks = Array.from({ length: 4 }, () => new Uint8Array(4 * 1024).fill(0x20));
  const exact = streamedResponse(200, exactChunks, { 'Content-Length': '16384' });
  const exactResult = await hc.fetchConnectionString(link, {
    fetch: async () => exact.response,
    timeoutMs: 1_000,
  });
  const exactStats = exact.stats();
  check('a body at exactly 16 KiB is accepted by the byte limiter',
    exactStats.chunksConsumed === 4 && exactResult.code === hc.CONNECT_ERRORS.REJECTED,
    `${exactStats.chunksConsumed} chunks, ${exactResult.code}`);

  for (const value of ['abc', '-1', '1, 1', '1.5']) {
    const malformed = streamedResponse(200, chunks, { 'Content-Length': value });
    const malformedResult = await hc.fetchConnectionString(link, {
      fetch: async () => malformed.response,
      timeoutMs: 1_000,
    });
    const malformedStats = malformed.stats();
    check('malformed or conflicting Content-Length ' + JSON.stringify(value) + ' is refused without reading',
      malformedResult.code === hc.CONNECT_ERRORS.REJECTED
        && malformedStats.chunksConsumed === 0
        && malformedStats.cancelCalls === 1,
      JSON.stringify({ code: malformedResult.code, ...malformedStats }));
  }

  const invalidUtf8 = streamedResponse(200, [new Uint8Array([0xc3, 0x28])]);
  const invalidResult = await hc.fetchConnectionString(link, {
    fetch: async () => invalidUtf8.response,
    timeoutMs: 1_000,
  });
  const invalidStats = invalidUtf8.stats();
  check('invalid UTF-8 is rejected rather than replaced',
    invalidResult.ok === false && invalidResult.code === hc.CONNECT_ERRORS.REJECTED);
  check('a UTF-8 decoding error also cancels and releases the reader',
    invalidStats.chunksConsumed === 1 && invalidStats.cancelCalls === 1 &&
      invalidUtf8.isLocked() === false);

  const encoded = new TextEncoder().encode(JSON.stringify({
    connectionString: connectionStringFor('https://hub.example.com', 'streamed-success'),
  }));
  const success = streamedResponse(200, [
    encoded.slice(0, 7),
    encoded.slice(7, 19),
    encoded.slice(19),
  ]);
  const successResult = await hc.fetchConnectionString(link, {
    fetch: async () => success.response,
    timeoutMs: 1_000,
  });
  check('a body below 16 KiB is decoded across chunks', successResult.ok === true);
  check('the successful response body is unlocked', success.isLocked() === false);

  const stalled = await startStub((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"connectionString":');
    // Deliberately leave the chunked body open. The request timeout must cover
    // body reads, not only receipt of the response headers.
  });
  try {
    const started = Date.now();
    const stalledResult = await hc.fetchConnectionString(stalled.link(token()), {
      timeoutMs: 150,
    });
    const elapsed = Date.now() - started;
    check('a Hub that sends headers and then stalls the body times out',
      stalledResult.ok === false && stalledResult.code === hc.CONNECT_ERRORS.TIMEOUT,
      JSON.stringify({ code: stalledResult.code, elapsed }));
    check('the stalled-body timeout closes promptly',
      elapsed < 2_000, `${elapsed}ms`);
  } finally {
    await stalled.close();
  }
}

async function main() {
  process.stdout.write('\nHub pairing from the CLI\n');
  process.stdout.write(`data dir: ${TEST_DATA_DIR}\n`);

  await testHubConnectUnitChecks();
  await testStreamedResponseBounds();
  await testHappyPathAndLifecycle();
  await testDeadLinks();
  await testSecondUseOfTheSameLink();
  await testRateLimited();
  await testUnreachable();
  await testTimeout();
  await testInsecureHttp();
  await testRawConnectionString();
  await testAlreadyLinkedNonTty();

  const failed = results.filter((r) => !r.passed);
  process.stdout.write(`\n${'─'.repeat(62)}\n`);
  process.stdout.write(`TOTAL ${results.length}   PASS ${results.length - failed.length}   FAIL ${failed.length}\n`);
  if (failed.length) {
    process.stdout.write('\nFailures:\n');
    for (const f of failed) process.stdout.write(`  [${f.group}] ${f.label}${f.detail ? ` — ${f.detail}` : ''}\n`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(String(e.stack || e) + '\n');
  process.exit(1);
});
