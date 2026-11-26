/**
 * e2e/service-menu.test.mjs
 *
 * Run with:  node e2e/run.mjs service-menu
 *
 * The `ezz service` menu's decisions, asserted without a terminal, a service or
 * a real installation. The suite only calls the module's pure helpers: the
 * status report builder, the warning filter, the leftover-data report and the
 * leftover-choice plan. Nothing here reaches core/service/index.js's status()
 * or install(); the module itself is imported for its exports only, which opens
 * the test database and nothing else (EZ_TEST + a throwaway data dir).
 *
 * It covers the 1.4.8 items this menu owns:
 *   4. install resume / not-installed messages,
 *   5. the leftover Server-data choice,
 *   6. the install-progress line instead of missing-permission warnings,
 *   7. status truth: no "Service version" without a service, access only from
 *      the live read, and no contradictory operator lines.
 */

import './lib/guard.mjs';

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const results = [];
let group = '';
function setGroup(name) {
  group = name;
  process.stdout.write(`\n── ${name}\n`);
}
function check(label, passed, detail = '') {
  results.push({ group, label, passed, detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}

const srcUrl = (rel) => pathToFileURL(path.join(ROOT, 'src', rel)).href;
const text = (lines) => lines.join('\n');

// ─── Fixtures ────────────────────────────────────────────────────────────────

const RUNTIME = {
  systemNode: { version: 'v20.11.0', path: 'C:\\Program Files\\nodejs\\node.exe' },
  pinned: {
    kind: 'copy',
    path: 'C:\\ProgramData\\easy-devops\\runtime\\node.exe',
    version: 'v20.11.0',
  },
};

/** The real server's state: Windows Server, no service, leftover Server data. */
const NO_SERVICE = {
  platform: 'win32',
  mode: 'server',
  mechanism: 'winsw',
  // No .server-mode marker: this process really uses %APPDATA%, even though an
  // earlier Server install's data is sitting in ProgramData.
  dataDir: 'C:\\Users\\omar\\AppData\\Roaming\\easy-devops',
  serverMode: false,
  serviceInstalled: false,
  registered: false,
  // 1.4.7 printed this even with no service registered.
  serviceVersion: '1.4.7',
  cliVersion: '1.4.8',
  service: {
    installed: false,
    registered: false,
    running: false,
    enabledOnBoot: false,
    state: 'not installed',
    restarts: 0,
  },
  daemon: { running: false, detail: 'no daemon lock file' },
  runtime: RUNTIME,
  operator: null,
  liveGrants: { checked: true, missing: [], errors: [] },
  warnings: [
    'The Easy DevOps service is not installed on this Windows Server. '
      + 'Run `ezz service install` from an Administrator PowerShell.',
  ],
};

const HEALTHY = {
  ...NO_SERVICE,
  // The marker is present, so the CLI and the service share ProgramData.
  dataDir: 'C:\\ProgramData\\easy-devops',
  serverMode: true,
  serviceInstalled: true,
  registered: true,
  serviceVersion: '1.4.8',
  service: {
    installed: true,
    registered: true,
    running: true,
    enabledOnBoot: true,
    state: 'running',
    restarts: 0,
  },
  daemon: { running: true, pid: 4242, startedAt: Date.now() - 60_000, detail: 'ok' },
  operator: {
    name: 'OMAR',
    sid: 'S-1-5-21-111-222-333-1001',
    serviceControl: true,
    dataDir: true,
    verified: true,
  },
  warnings: [
    // Stale lines from a record the live read has superseded.
    'Starting and stopping the service need an Administrator terminal for your account. '
      + 'Run `ezz service repair` once from an Administrator PowerShell to allow it without elevation.',
    'The service files have no recorded permission check, so they may be missing or out of date. '
      + 'Run `ezz service repair` in an Administrator PowerShell before relying on this service.',
  ],
};

/** The 1.4.7 install that stopped at the runtime step. */
const UNFINISHED = {
  ...NO_SERVICE,
  serviceVersion: null,
  installProgress: {
    version: '1.4.8',
    startedAt: '2026-11-24T10:00:00.000Z',
    updatedAt: '2026-11-24T10:04:00.000Z',
    steps: { dataDir: 'done', runtime: 'failed' },
    failedStep: 'runtime',
    error: 'verifying the new permissions failed',
  },
  warnings: [
    'The service account (NT SERVICE\\EasyDevOps) has no access to C:\\ProgramData\\easy-devops.',
    'Starting and stopping the service need an Administrator terminal for your account.',
    'Install not finished (stopped at runtime): run `ezz service install` to resume.',
  ],
};

const LEFTOVER_ADOPT = {
  leftover: true,
  programData: {
    dir: 'C:\\ProgramData\\easy-devops',
    db: {
      exists: true,
      ok: true,
      keyCount: 15,
      keys: [
        'domains', 'hub-link', 'hub-permissions', 'sslAutoRenewState',
        'config', 'deployApps', 'notification_channels',
      ],
      size: 4_300_000,
      mtime: '2026-11-20T12:03:00.000Z',
    },
  },
  userData: {
    dir: 'C:\\Users\\omar\\AppData\\Roaming\\easy-devops',
    db: {
      exists: true,
      ok: true,
      keyCount: 4,
      keys: ['config', 'system-detection', 'update-pre-dashboard', 'service-state'],
      size: 90_000,
      mtime: '2026-11-24T08:11:00.000Z',
    },
  },
  recommended: 'adopt',
  codeOnly: false,
};

const LEFTOVER_ASIDE = {
  ...LEFTOVER_ADOPT,
  programData: {
    dir: 'C:\\ProgramData\\easy-devops',
    db: { ...LEFTOVER_ADOPT.programData.db, keyCount: 4, keys: ['config', 'service-state'] },
  },
  userData: {
    dir: 'C:\\Users\\omar\\AppData\\Roaming\\easy-devops',
    db: { ...LEFTOVER_ADOPT.userData.db, keyCount: 15, keys: ['domains', 'hub-link', 'config'] },
  },
  recommended: 'keep-aside',
};

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testExports(menu) {
  setGroup('1. the module keeps its interface');
  check('serviceCommand is exported', typeof menu.serviceCommand === 'function');
  check('buildStatusLines is exported', typeof menu.buildStatusLines === 'function');
  check('statusView is exported', typeof menu.statusView === 'function');
  check('filterStatusWarnings is exported', typeof menu.filterStatusWarnings === 'function');
  check('leftoverReportLines is exported', typeof menu.leftoverReportLines === 'function');
  check('leftoverChoicePlan is exported', typeof menu.leftoverChoicePlan === 'function');
  check('LEFTOVER_COMMANDS is exported', Array.isArray(menu.LEFTOVER_COMMANDS));

  // Both call shapes the bootstrap may use, and an unknown action.
  check('an unknown action exits 1 (options object)',
    (await menu.serviceCommand('nope', { leftoverChoice: 'adopt' })) === 1);
  check('an unknown action exits 1 (bare choice)',
    (await menu.serviceCommand('nope', 'adopt')) === 1);
}

async function testNoServiceStatus(menu) {
  setGroup('2. no service and no marker (the evidence server)');
  const out = text(menu.buildStatusLines(NO_SERVICE, { leftover: LEFTOVER_ADOPT }));
  const dataLine = out.split('\n').find((line) => /Data directory/.test(line)) ?? '';

  check('says the service is not installed', /Service\s+.*not installed/.test(out), out.split('\n')[1]);
  check('shows the directory this process really uses', /Roaming[\\/]easy-devops/.test(dataLine), dataLine.trim());
  check('labels it "(per-user)", never "server mode"',
    /\(per-user\)/.test(dataLine) && !/server mode/.test(dataLine), dataLine.trim());
  check('never prints "Service version" for a version it does not have',
    !/Service version/.test(out) && !/1\.4\.7/.test(out));
  check('names the install command', /ezz service install/.test(out));
  check('names the Administrator PowerShell on Windows Server', /Administrator PowerShell/.test(out));
  check('warns about the leftover Server data', /An earlier Server-mode install's data/.test(out));
  check('shows both key counts only', /\(15 keys\)/.test(out) && /\(4 keys\)/.test(out)
    && !/domains/.test(out) && !/system-detection/.test(out));
  check('gives both leftover flags', /--adopt-existing-data/.test(out) && /--set-aside-existing-data/.test(out));
  check('prints the not-installed sentence once', (out.match(/not installed/gi) ?? []).length <= 2,
    `${(out.match(/not installed/gi) ?? []).length} occurrence(s)`);

  const view = menu.statusView(NO_SERVICE);
  check('the view never claims a service version', view.showServiceVersion === false);
  check('the view says the hint is "install"', view.hint === 'install');
}

async function testUnfinishedInstall(menu) {
  setGroup('3. an install that stopped at the runtime step');
  const out = text(menu.buildStatusLines(UNFINISHED));

  check('prints one install line', (out.match(/Install not finished/g) ?? []).length === 1,
    `${(out.match(/Install not finished/g) ?? []).length} line(s)`);
  check('names the step that failed', /stopped at runtime/.test(out));
  check('says to resume with the install command', /Resume it with: .*ezz service install/.test(out));
  check('prints NO missing-access warning', !/has no access/i.test(out));
  check('prints NO Administrator-terminal warning', !/Administrator terminal/i.test(out));
  check('prints NO recorded-permission-check warning', !/recorded permission check/i.test(out));
  check('still hides "Service version"', !/Service version/.test(out));

  const view = menu.statusView(UNFINISHED);
  check('the view marks the install unfinished', view.installUnfinished === true);
  check('the view carries the failed step', view.failedStep === 'runtime');
}

async function testHealthyStatus(menu) {
  setGroup('4. a healthy server with the marker: live operator, no contradictions');
  const out = text(menu.buildStatusLines(HEALTHY, { leftover: LEFTOVER_ADOPT }));
  const dataLine = out.split('\n').find((line) => /Data directory/.test(line)) ?? '';

  check('prints the service version when the service is registered',
    /Service version\s+1\.4\.8/.test(out));
  check('shows ProgramData labelled "(server mode)"',
    /ProgramData[\\/]easy-devops/.test(dataLine) && /\(server mode\)/.test(dataLine), dataLine.trim());
  check('prints NO leftover-data warning when the marker exists',
    !/An earlier Server-mode install's data/.test(out));
  check('shows the live start/stop grant', /start\/stop\/restart/.test(out));
  check('marks it as checked on the service', /checked on the service/.test(out));
  check('does NOT also say an Administrator terminal is needed',
    !/Administrator terminal/i.test(out));
  check('drops the recorded permission-check warning', !/recorded permission check/i.test(out));

  const perms = (out.match(/Without admin/g) ?? []).length;
  check('prints exactly one "Without admin" line', perms === 1, `${perms} line(s)`);
}

async function testOperatorDenied(menu) {
  setGroup('5. a live operator without the start/stop grant');
  const denied = {
    ...HEALTHY,
    operator: { ...HEALTHY.operator, serviceControl: false },
    warnings: [
      'Starting and stopping the service need an Administrator terminal for your account. '
        + 'Run `ezz service repair` once from an Administrator PowerShell to allow it without elevation.',
    ],
  };
  const out = text(menu.buildStatusLines(denied));

  check('keeps the warning the live field supports', /Administrator terminal/i.test(out));
  const admin = out.split('\n').find((line) => /Without admin/.test(line)) ?? '';
  check('does not also claim start/stop/restart works', !/start\/stop\/restart/.test(admin), admin.trim());
  check('says nothing is possible without admin', /nothing/.test(admin), admin.trim());
}

async function testUnverifiedOperator(menu) {
  setGroup('6. an unverified operator record is never dressed up as live');
  const recorded = {
    ...HEALTHY,
    operator: { ...HEALTHY.operator, verified: false },
    warnings: [],
  };
  const out = text(menu.buildStatusLines(recorded));
  const admin = out.split('\n').find((line) => /Without admin/.test(line)) ?? '';
  check('says the rights are recorded, not re-checked', /recorded; not re-checked/.test(admin), admin.trim());
  check('does not print "checked on the service"', !/checked on the service/.test(admin));
}

async function testLeftoverReport(menu) {
  setGroup('7. leftover data: both databases, names only, two choices');
  const out = text(menu.leftoverReportLines(LEFTOVER_ADOPT));

  check('shows the ProgramData database path', /C:\\ProgramData\\easy-devops\\easy-devops\.sqlite/.test(out));
  check('shows the %APPDATA% database path', /Users\\omar\\AppData\\Roaming\\easy-devops\\easy-devops\.sqlite/.test(out));
  check('shows the ProgramData key count', /15 keys/.test(out));
  check('shows the %APPDATA% key count', /4 keys/.test(out));
  check('shows a readable size', /4\.1 MB/.test(out) && /88 KB/.test(out), '4.1 MB / 88 KB');
  check('shows a modified time', /modified \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(out));
  check('shows key NAMES', /keys: .*domains/.test(out) && /keys: .*system-detection/.test(out));
  check('does not print a value (no "key=value")', !/\w+=\S/.test(out));
  check('says which database has more keys', /more keys \(15 vs 4\)/.test(out));
  check('recommends adopt when ProgramData has more keys', /Recommended: adopt/.test(out));
  check('names the adopt effect (marker, %APPDATA% untouched)',
    /restores the Server-mode marker and leaves %APPDATA% untouched/.test(out));
  check('names the keep-aside effect (rename + migrate)',
    /easy-devops\.old-<date>, then migrates %APPDATA%/.test(out));

  const aside = text(menu.leftoverReportLines(LEFTOVER_ASIDE));
  check('recommends keep-aside when %APPDATA% has more keys', /Recommended: set aside/.test(aside));
  check('says %APPDATA% has more keys', /more keys \(15 vs 4\)/.test(aside));

  check('the two exact commands are exported and printed',
    menu.LEFTOVER_COMMANDS?.includes('ezz service install --adopt-existing-data')
    && menu.LEFTOVER_COMMANDS?.includes('ezz service install --set-aside-existing-data'));
}

async function testChoicePlan(menu) {
  setGroup('8. how a leftover choice is taken');
  const flag = menu.leftoverChoicePlan({ leftoverChoice: 'adopt', interactive: false });
  check('a flag wins without a terminal', flag.action === 'use' && flag.choice === 'adopt');

  const asideFlag = menu.leftoverChoicePlan({ leftoverChoice: 'keep-aside', interactive: true });
  check('keep-aside is accepted too', asideFlag.action === 'use' && asideFlag.choice === 'keep-aside');

  const unattended = menu.leftoverChoicePlan({ leftoverChoice: undefined, interactive: false });
  check('no terminal and no flag refuses', unattended.action === 'refuse');

  const yes = menu.leftoverChoicePlan({ leftoverChoice: undefined, interactive: true, assumeYes: true });
  check('--yes without a flag refuses', yes.action === 'refuse');

  const asked = menu.leftoverChoicePlan({ leftoverChoice: undefined, interactive: true });
  check('a person is asked', asked.action === 'ask');

  const bogus = menu.leftoverChoicePlan({ leftoverChoice: 'delete', interactive: true });
  check('an unknown choice is never used', bogus.action === 'ask');
}

async function main() {
  process.stdout.write('\nService menu\n');
  process.stdout.write(`data dir: ${process.env.EASY_DEVOPS_DATA_DIR}\n`);

  setGroup('0. the test environment');

  // The guard aims at a directory the runner created; just prove it is there
  // so a broken environment is a clear failure, not a confusing import error.
  const dataDir = process.env.EASY_DEVOPS_DATA_DIR;
  check('the runner gave this suite a temporary data directory',
    Boolean(dataDir) && fs.existsSync(dataDir), dataDir);

  const menu = await import(srcUrl('cli/menus/service.js'));

  await testExports(menu);
  await testNoServiceStatus(menu);
  await testUnfinishedInstall(menu);
  await testHealthyStatus(menu);
  await testOperatorDenied(menu);
  await testUnverifiedOperator(menu);
  await testLeftoverReport(menu);
  await testChoicePlan(menu);

  const failed = results.filter((r) => !r.passed);
  process.stdout.write(`\n${'─'.repeat(62)}\n`);
  process.stdout.write(`TOTAL ${results.length}   PASS ${results.length - failed.length}   FAIL ${failed.length}\n`);
  if (failed.length) {
    process.stdout.write('\nFailures:\n');
    for (const failure of failed) {
      process.stdout.write(`  [${failure.group}] ${failure.label}${failure.detail ? ` — ${failure.detail}` : ''}\n`);
    }
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(String(error?.stack || error) + '\n');
  process.exit(1);
});
