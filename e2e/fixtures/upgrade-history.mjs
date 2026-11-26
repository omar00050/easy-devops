/**
 * Historical service states left by Easy DevOps 1.4.0, 1.4.3, 1.4.5 and
 * 1.4.6.
 *
 * This module only writes disposable files and data below the caller's test
 * root. It never imports src/, never runs a process and never touches a real
 * ACL: the Windows DACL state is a *model* (see acl-records.json), consumed by
 * the stateful `icacls` fake in e2e/service-upgrade-matrix.test.mjs.
 *
 * What each version left behind, from docs-rev/fix-1.4.7-evidence.md:
 *
 *   1.4.0  a legacy unit and WinSW XML, no protections, a very old runtime copy
 *   1.4.3  a well-formed unit, operator grants, an old runtime copy
 *   1.4.5  the malformed unit (Environment= inside [Unit], in the middle of a
 *          comment), a truncated WinSW XML, empty DACLs on the files under
 *          bin/ and runtime/ (finding A1)
 *   1.4.6  the same broken artifacts, plus runtime.prev left by the failed
 *          update and a runtime copy still reporting 1.4.4 (finding A3)
 *
 * Every version also carries: a stale daemon.stop request, a recorded
 * service-state stop timestamp (finding A5), the .server-mode marker, the
 * service-operator record with the real `sc.exe sdshow` descriptor from the
 * evidence (finding A2), and real user data (database, settings, certificates,
 * nginx configs, deploy folders) that no upgrade path may change.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const HISTORICAL_VERSIONS = Object.freeze(['1.4.0', '1.4.3', '1.4.5', '1.4.6']);

/**
 * Every version the owner names in Part 2, 1.4.0 through 1.4.7. The four above
 * are the *broken* seeds; these eight are the healthy state each release left,
 * which a repair must be able to leave alone (or bring onto the new CLI) on
 * Windows Server and on Linux as root and as a normal user.
 */
export const PUBLISHED_VERSIONS = Object.freeze([
  '1.4.0', '1.4.1', '1.4.2', '1.4.3', '1.4.4', '1.4.5', '1.4.6', '1.4.7',
]);

/** The user data an upgrade must never change. Relative to the data directory. */
export const USER_DATA_ENTRIES = Object.freeze([
  'easy-devops.sqlite',
  'easy-devops.sqlite-wal',
  'settings.json',
  'certs',
  'nginx',
  'deploy',
]);

/** The exact SDDL `sc.exe sdshow EasyDevOps` printed on the broken server (A2). */
export const HISTORICAL_SERVICE_SDDL = 'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)'
  + '(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)'
  + '(A;;CCLCSWLOCRRC;;;IU)'
  + '(A;;CCLCSWLOCRRC;;;SU)'
  + '(A;;CCLCRPWPLO;;;S-1-5-21-1111111111-2222222222-3333333333-1001)'
  + 'S:(AU;FA;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;WD)';

/** The trustee names icacls prints for the well-known SIDs the code grants. */
export const TRUSTEES = Object.freeze({
  SYSTEM: 'NT AUTHORITY\\SYSTEM',
  ADMINISTRATORS: 'BUILTIN\\Administrators',
  USERS: 'BUILTIN\\Users',
  SERVICE: 'NT SERVICE\\EasyDevOps',
});

const OPERATOR = Object.freeze({
  sid: 'S-1-5-21-1111111111-2222222222-3333333333-1001',
  name: 'EXAMPLE\\operator',
});

const HISTORICAL_STATE = Object.freeze({
  '1.4.0': {
    linuxUnit: 'legacy',
    windowsXml: 'legacy',
    runtimeVersion: '1.3.11',
    pinnedNodeVersion: 'v18.20.4',
    emptyAcl: false,
    runtimePrevVersion: null,
    operator: { ...OPERATOR, serviceControl: false, dataDir: false },
  },
  '1.4.3': {
    linuxUnit: 'well-formed',
    windowsXml: 'well-formed',
    runtimeVersion: '1.4.2',
    pinnedNodeVersion: 'v20.19.0',
    emptyAcl: false,
    runtimePrevVersion: null,
    operator: { ...OPERATOR, serviceControl: false, dataDir: true },
  },
  '1.4.5': {
    linuxUnit: 'malformed-comment',
    windowsXml: 'malformed',
    runtimeVersion: '1.4.4',
    pinnedNodeVersion: 'v22.0.0',
    emptyAcl: true,
    runtimePrevVersion: null,
    operator: { ...OPERATOR, serviceControl: true, dataDir: true },
  },
  '1.4.6': {
    linuxUnit: 'malformed-comment',
    windowsXml: 'malformed',
    runtimeVersion: '1.4.4',
    pinnedNodeVersion: 'v22.23.5',
    emptyAcl: true,
    runtimePrevVersion: '1.3.11',
    operator: { ...OPERATOR, serviceControl: true, dataDir: true },
  },
});

/**
 * The malformed line 1.4.6 really wrote into `[Unit]`: a repair that inserted
 * `Environment=` where it had matched the text `[Service]` inside a comment.
 * No `#` in front of it: systemd read it as a key in the wrong section and
 * ignored the value.
 */
export const MALFORMED_UNIT_LINE = 'Environment=WS_NO_BUFFER_UTIL=1: systemd moved them in v229 and still';

function mkdir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function write(file, contents) {
  mkdir(path.dirname(file));
  fs.writeFileSync(file, contents);
}

function buildUnit(version, variant, dataDir, user = 'root') {
  const runtime = path.join(dataDir, 'runtime', 'node');
  const entry = '/usr/lib/node_modules/easy-devops/src/cli/index.js';
  const loader = '--experimental-loader=file:///usr/lib/node_modules/easy-devops/src/core/service/runtime-loader.mjs';

  if (variant === 'legacy') {
    // 1.4.0: no runtime loader (it arrived in 1.4.4), no data-directory line.
    return `[Unit]
Description=Easy DevOps background service (${version})
After=network-online.target

[Service]
Type=simple
User=${user}
ExecStart=${runtime} ${entry} daemon
Restart=always
Environment=NODE_OPTIONS=
Environment=NODE_PATH=

[Install]
WantedBy=multi-user.target
`;
  }

  if (variant === 'malformed-comment') {
    // 1.4.5/1.4.6: the failed insertion. The two `Environment=` lines landed in
    // the middle of a comment in [Unit], so systemd ignored them, and the
    // service ran without the pinned environment.
    return `[Unit]
Description=Easy DevOps background service (${version})
Documentation=https://github.com/farghaly/easy-devops
After=network-online.target nginx.service

# Stop restarting after 5 failures inside 60s, so a daemon that cannot
# start ends in a state 'systemctl status' reports plainly.
${MALFORMED_UNIT_LINE}
Environment=WS_NO_UTF_8_VALIDATE=1: accepts this only with a warning.
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=${user}
WorkingDirectory=/usr/lib/node_modules/easy-devops
ExecStart=${runtime} ${loader} ${entry} daemon
Restart=always
RestartSec=5
Environment=NODE_OPTIONS=
Environment=NODE_PATH=
Environment=NODE_ENV=production
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
`;
  }

  return `[Unit]
Description=Easy DevOps background service (${version})
After=network-online.target

[Service]
Type=simple
User=${user}
ExecStart=${runtime} ${loader} ${entry} daemon
Restart=always
RestartSec=5
Environment=NODE_OPTIONS=
Environment=NODE_PATH=
Environment=NODE_ENV=production
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
`;
}

function buildServiceXml(version, variant, dataDir) {
  const exe = path.join(dataDir, 'bin', 'EasyDevOps.exe');
  const node = path.join(dataDir, 'runtime', 'node.exe');
  const entry = path.join(dataDir, 'runtime', 'app', 'src', 'cli', 'index.js');

  if (variant === 'malformed') {
    // 1.4.5/1.4.6: WinSW refused this, and the repair that rewrote it was the
    // step that failed on the empty DACLs.
    return `<service>
  <id>EasyDevOps</id>
  <name>Easy DevOps</name>
  <executable>${node}</executable>
  <arguments>${entry} daemon</arguments>
  <env name="EASY_DEVOPS_DATA_DIR" value="${dataDir}"/>
  <!-- written by ${version}; no closing element and no service account -->
`;
  }

  if (variant === 'legacy') {
    // 1.4.0: the wrapper ran from the data directory and argv was a bare path
    // list, before the pinned runtime copy and the loader existed.
    return `<service>
  <id>EasyDevOps</id>
  <name>Easy DevOps</name>
  <executable>${exe}</executable>
  <arguments>%BASE%\\runtime\\node.exe %BASE%\\runtime\\app\\src\\cli\\index.js daemon</arguments>
  <logmode>roll</logmode>
</service>
`;
  }

  return `<service>
  <id>EasyDevOps</id>
  <name>Easy DevOps</name>
  <description>Easy DevOps background service from ${version}</description>
  <executable>${node}</executable>
  <arguments>${entry} daemon</arguments>
  <env name="EASY_DEVOPS_DATA_DIR" value="${dataDir}"/>
  <onfailure action="restart" delay="5 sec"/>
  <logmode>roll</logmode>
</service>
`;
}

/**
 * One ACE, in the shape the fake icacls keeps.
 *
 * @param {string} trustee
 * @param {'F'|'M'|'RX'} level
 * @param {string[]} [flags] `OI` and `CI` only; omitted means "this object only"
 */
function ace(trustee, level, flags = []) {
  return { trustee, level, flags };
}

/** The ACEs a protected executable folder carries (evidence A1: the folders kept these). */
function folderAces() {
  return [
    ace(TRUSTEES.SYSTEM, 'F', ['OI', 'CI']),
    ace(TRUSTEES.ADMINISTRATORS, 'F', ['OI', 'CI']),
    ace(TRUSTEES.USERS, 'RX', ['OI', 'CI']),
    ace(TRUSTEES.SERVICE, 'RX', ['OI', 'CI']),
  ];
}

/** The ACL records: a model of the DACLs, never an assertion. */
function aclRecords({ version, state, roots, probeFiles }) {
  const dataRootAces = [
    ace(TRUSTEES.SYSTEM, 'F', ['OI', 'CI']),
    ace(TRUSTEES.ADMINISTRATORS, 'F', ['OI', 'CI']),
    ace(TRUSTEES.USERS, 'RX', ['OI', 'CI']),
  ];
  if (state.operator.dataDir) dataRootAces.push(ace(state.operator.name, 'M', ['OI', 'CI']));

  // Finding A1: on the affected servers EVERY file under these folders was
  // left with NO ACEs at all, and with inheritance removed, so nothing could
  // open them - not even SYSTEM. The probe files are the ones the evidence
  // names, but the model has the real tree.
  const files = {};
  for (const [name, directory] of Object.entries(roots)) {
    for (const file of walkFiles(directory)) {
      files[`${name}/${path.relative(directory, file).split(path.sep).join('/')}`] = {
        aces: [],
        inherit: !state.emptyAcl,
      };
    }
  }
  for (const relative of probeFiles) {
    if (!files[relative]) files[relative] = { aces: [], inherit: !state.emptyAcl };
  }

  const folders = { bin: { aces: folderAces(), inherit: false }, runtime: { aces: folderAces(), inherit: false } };
  if (roots['runtime.prev']) folders['runtime.prev'] = { aces: folderAces(), inherit: false };

  return {
    representation: 'icacls-dacl-model/v1',
    version,
    description: 'Seeded DACL model for the fake icacls. The suite asserts on the model after the code ran.',
    emptyDacls: state.emptyAcl,
    owner: { folders: TRUSTEES.ADMINISTRATORS, files: state.operator.sid },
    dataRoot: { aces: dataRootAces, inherit: false },
    folders,
    files,
  };
}

/** Every file below `root`, sorted. */
function walkFiles(root) {
  const found = [];
  const visit = (directory) => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else found.push(full);
    }
  };
  visit(root);
  return found;
}

/** The database bytes: a real SQLite header, so a "copy" that truncates shows. */
function sqliteBytes(version) {
  const header = Buffer.from('SQLite format 3\0', 'binary');
  const body = Buffer.alloc(512);
  body.write(`easy-devops database left by ${version}`, 0, 'utf8');
  for (let i = 32; i < body.length; i += 1) body[i] = (i * 37 + Number(version.split('.').pop())) & 0xff;
  return Buffer.concat([header, body]);
}

function writeUserData(dataDir, version, platform) {
  write(path.join(dataDir, 'easy-devops.sqlite'), sqliteBytes(version));
  write(path.join(dataDir, 'easy-devops.sqlite-wal'),
    Buffer.from(`${platform}:${version}:uncheckpointed-wal\u0000\u0001\u00ff`, 'binary'));
  write(path.join(dataDir, 'settings.json'),
    `${JSON.stringify({
      fixture: true,
      version,
      platform,
      dashboardPort: 6443,
      dashboardBindAddress: '127.0.0.1',
      nginxDir: 'C:\\nginx',
      sslDir: 'C:\\ssl',
      acmeEmail: 'ops@example.com',
    }, null, 2)}\n`);

  write(path.join(dataDir, 'certs', 'example.com', 'fullchain.pem'),
    `-----BEGIN CERTIFICATE-----\nfixture-${platform}-${version}\n-----END CERTIFICATE-----\n`);
  write(path.join(dataDir, 'certs', 'example.com', 'privkey.pem'),
    `-----BEGIN PRIVATE KEY-----\nfixture-${platform}-${version}\n-----END PRIVATE KEY-----\n`);

  write(path.join(dataDir, 'nginx', 'sites', 'example.com.conf'),
    `server {\n  server_name example.com;\n  # ${platform} ${version}\n  location / { proxy_pass http://127.0.0.1:3000; }\n}\n`);
  write(path.join(dataDir, 'nginx', 'nginx.conf'), `worker_processes 1;\n# ${version}\n`);

  write(path.join(dataDir, 'deploy', 'blog', 'releases', version, 'index.js'),
    `// deployed release ${version} (${platform})\nmodule.exports = 'blog';\n`);
  write(path.join(dataDir, 'deploy', 'blog', 'current.json'),
    `${JSON.stringify({ release: version, platform }, null, 2)}\n`);
}

function writeRuntimeCopy(runtimeRoot, version) {
  write(path.join(runtimeRoot, 'node.exe'), `historical-node-for-easy-devops-${version}`);
  write(path.join(runtimeRoot, 'EasyDevOps.exe'), `historical-winsw-${version}`);
  write(path.join(runtimeRoot, 'app', 'package.json'),
    `${JSON.stringify({ name: 'easy-devops', version }, null, 2)}\n`);
  write(path.join(runtimeRoot, 'app', 'src', 'cli', 'index.js'),
    `// Easy DevOps ${version} runtime entrypoint (the service runs this)\n`);
  write(path.join(runtimeRoot, 'app', 'src', 'core', 'service', 'runtime-loader.mjs'),
    `// Easy DevOps ${version} runtime loader\n`);
}

function writeStopRecord(dataDir, version) {
  // A5: the stale live request, and the recorded stop timestamp that used to be
  // misread as "stopped by you" while the service was running.
  write(path.join(dataDir, 'daemon.stop'),
    `${JSON.stringify({
      at: '2026-11-24T16:18:00.000Z',
      by: 10376,
      reason: `stopped before the ${version} update`,
    }, null, 2)}\n`);
  write(path.join(dataDir, 'service-state.json'),
    `${JSON.stringify({
      version,
      mode: 'server',
      stoppedAt: '2026-11-25T16:28:00.000Z',
      installedAt: '2026-11-24T15:30:00.000Z',
    }, null, 2)}\n`);
}

/**
 * Materializes every historical fixture below `root`.
 *
 * @param {string} root An absolute directory inside the run's test data root
 * @returns {Array<Object>} one entry per historical version
 */
export function materializeUpgradeFixtures(root) {
  if (!root || !path.isAbsolute(root)) throw new Error('fixture root must be absolute');
  mkdir(root);

  const fixtures = [];
  for (const version of HISTORICAL_VERSIONS) {
    const state = HISTORICAL_STATE[version];
    const versionRoot = path.join(root, version);

    // ── Linux: root install under /usr/lib/node_modules ────────────────────
    const linuxRoot = path.join(versionRoot, 'linux');
    const linuxDataDir = path.join(linuxRoot, 'data');
    const linuxUnitPath = path.join(linuxRoot, 'easy-devops.service');
    write(linuxUnitPath, buildUnit(version, state.linuxUnit, linuxDataDir));
    // The pinned runtime is a link to a Node OLDER than the package needs.
    write(path.join(linuxDataDir, 'runtime', 'node.version'), `${state.pinnedNodeVersion}\n`);
    write(path.join(linuxDataDir, 'runtime', 'node'),
      `historical-pinned-node:${state.pinnedNodeVersion}\n`);
    writeStopRecord(linuxDataDir, version);
    writeUserData(linuxDataDir, version, 'linux');

    // ── Windows Server: WinSW under ProgramData ───────────────────────────
    const windowsRoot = path.join(versionRoot, 'windows');
    const windowsProgramData = path.join(windowsRoot, 'ProgramData');
    const windowsDataDir = path.join(windowsProgramData, 'easy-devops');
    write(path.join(windowsDataDir, 'bin', 'EasyDevOps.exe'), `historical-winsw:${version}`);
    write(path.join(windowsDataDir, 'bin', 'EasyDevOps.xml'),
      buildServiceXml(version, state.windowsXml, windowsDataDir));
    write(path.join(windowsDataDir, 'bin', 'EasyDevOps.exe.prev'),
      `historical-winsw-previous:${version}`);
    write(path.join(windowsDataDir, '.server-mode'),
      `${JSON.stringify({ version, installedAt: '2026-11-24T15:30:00.000Z' })}\n`);
    writeRuntimeCopy(path.join(windowsDataDir, 'runtime'), state.runtimeVersion);
    if (state.runtimePrevVersion) {
      writeRuntimeCopy(path.join(windowsDataDir, 'runtime.prev'), state.runtimePrevVersion);
    }
    writeStopRecord(windowsDataDir, version);
    writeUserData(windowsDataDir, version, 'windows');

    const metadata = path.join(windowsRoot, 'metadata');
    const probeFiles = ['bin/EasyDevOps.exe', 'runtime/node.exe', 'runtime/app/src/cli/index.js'];
    const codeRoots = {
      bin: path.join(windowsDataDir, 'bin'),
      runtime: path.join(windowsDataDir, 'runtime'),
    };
    if (state.runtimePrevVersion) codeRoots['runtime.prev'] = path.join(windowsDataDir, 'runtime.prev');
    write(path.join(metadata, 'acl-records.json'), `${JSON.stringify(aclRecords({
      version,
      state,
      roots: codeRoots,
      probeFiles,
    }), null, 2)}\n`);

    const operatorRecord = {
      version,
      mechanism: 'winsw',
      mode: 'server',
      operator: state.operator,
      service: {
        id: 'EasyDevOps',
        account: TRUSTEES.SERVICE,
        registered: true,
        // A2: the descriptor was correct on the broken server; the binary was
        // not. Recover keeps both defaults and renews the additive user grant.
        sddl: state.operator.serviceControl
          ? HISTORICAL_SERVICE_SDDL
          : 'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)'
            + '(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)S:(AU;FA;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;WD)',
      },
    };
    write(path.join(metadata, 'service-operator.json'), `${JSON.stringify(operatorRecord, null, 2)}\n`);

    fixtures.push({
      version,
      root: versionRoot,
      linux: {
        root: linuxRoot,
        dataDir: linuxDataDir,
        unitPath: linuxUnitPath,
        unitVariant: state.linuxUnit,
        runtimeRoot: path.join(linuxDataDir, 'runtime'),
        pinnedNodePath: path.join(linuxDataDir, 'runtime', 'node'),
        pinnedNodeVersion: state.pinnedNodeVersion,
        stopRequestPath: path.join(linuxDataDir, 'daemon.stop'),
        serviceStatePath: path.join(linuxDataDir, 'service-state.json'),
        userDataPaths: USER_DATA_ENTRIES.map((entry) => path.join(linuxDataDir, entry)),
      },
      windows: {
        root: windowsRoot,
        programData: windowsProgramData,
        dataDir: windowsDataDir,
        binDir: path.join(windowsDataDir, 'bin'),
        runtimeRoot: path.join(windowsDataDir, 'runtime'),
        runtimePrevRoot: state.runtimePrevVersion ? path.join(windowsDataDir, 'runtime.prev') : null,
        runtimeVersion: state.runtimeVersion,
        runtimePrevVersion: state.runtimePrevVersion,
        xmlPath: path.join(windowsDataDir, 'bin', 'EasyDevOps.xml'),
        xmlVariant: state.windowsXml,
        markerPath: path.join(windowsDataDir, '.server-mode'),
        metadataDir: metadata,
        aclRecordsPath: path.join(metadata, 'acl-records.json'),
        operatorRecordPath: path.join(metadata, 'service-operator.json'),
        operator: state.operator,
        serviceDescriptor: operatorRecord.service.sddl,
        stopRequestPath: path.join(windowsDataDir, 'daemon.stop'),
        serviceStatePath: path.join(windowsDataDir, 'service-state.json'),
        probeFiles,
        userDataPaths: USER_DATA_ENTRIES.map((entry) => path.join(windowsDataDir, entry)),
        emptyAcl: state.emptyAcl,
      },
    });
  }
  return fixtures;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1.4.8: the states a release must repair (owner's evidence, Part 2)
// ═══════════════════════════════════════════════════════════════════════════
//
// Everything below is ADDITIVE. `materializeUpgradeFixtures()` and its exports
// are untouched, so e2e/service-upgrade-matrix.test.mjs keeps the exact states
// it had. The matrix lane drives these new states; each one returns the paths
// and the expectations, never an assertion.
//
// The states come from the owner's report of the real 1.4.7 failure
// (docs-rev/fix-1.4.7-evidence.md) and from Part 2's list.

/** The 15 keys the REAL database in C:\ProgramData held on the broken server. */
export const EVIDENCE_DATA_KEYS = Object.freeze([
  'config',
  'domains',
  'hub-link',
  'hub-permissions',
  'hub-revision',
  'service-state',
  'sslAutoRenewState',
  'deployApps',
  'dashboard-pid',
  'dashboard-port',
  'setup-code',
  'session_secret',
  'system-detection',
  'notification_channels',
  'notification_state',
]);

/** The 4 keys the near-empty %APPDATA% database held (config, detection, ...). */
export const EVIDENCE_APPDATA_KEYS = Object.freeze([
  'config',
  'system-detection',
  'update-pre-dashboard',
  'service-state',
]);

/** Where getStartupFolder() resolves under a redirected %APPDATA%. */
export const STARTUP_RELATIVE = Object.freeze([
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
]);

/** The two Personal-mode files (core/service/windowsPersonal.js). */
export const PERSONAL_LAUNCHER_FILE = 'easy-devops-daemon.cmd';
export const PERSONAL_SUPERVISOR_FILE = 'daemon-supervisor.cmd';

/** The install progress record core/service/windowsService.js writes. */
export const INSTALL_PROGRESS_FILE = 'install-progress.json';

/** The document a dashboard-initiated update leaves behind. */
export const UPDATE_STATUS_FILE = 'update-status.json';

/** Every new state this module can materialize, in the order to run them. */
export const UPGRADE_STATE_NAMES = Object.freeze([
  'server-evidence',
  'personal-launcher-on-server',
  'install-interrupted',
  'runtime-older-than-cli',
  'stale-stop-request',
  'large-runtime',
  'linux-unit-tuning',
  'linux-failed-update-rollback',
  'linux-database-held',
]);

function assertAbsolute(root, what) {
  if (!root || !path.isAbsolute(root)) throw new Error(`${what} must be an absolute path`);
}

/**
 * A real `gooddb` database with `keys`, built by the same better-sqlite3 the
 * application uses, so `core/db.js` `inspectDatabaseFile()` reports the key
 * count instead of "not a database".
 *
 * If better-sqlite3 cannot be loaded at all, a header-only file is written and
 * `real: false` says so: the fixture must not be the reason a suite cannot run.
 */
function writeKeyDatabase(file, keys, version = '1.4.7') {
  mkdir(path.dirname(file));
  let real = false;
  try {
    const Database = require('better-sqlite3');
    // Start from nothing: an existing header-only fixture file is not a
    // database better-sqlite3 can add a table to.
    fs.rmSync(file, { force: true });
    const handle = new Database(file);
    handle.exec('CREATE TABLE IF NOT EXISTS gooddb (key TEXT PRIMARY KEY, value TEXT)');
    const insert = handle.prepare('INSERT OR REPLACE INTO gooddb (key, value) VALUES (?, ?)');
    for (const key of keys) insert.run(key, JSON.stringify({ fixture: version, key }));
    handle.close();
    real = true;
  } catch {
    write(file, sqliteBytes(version));
  }
  return { file, keyCount: keys.length, keys: [...keys], real };
}

/** `<appData>\Microsoft\Windows\Start Menu\Programs\Startup` for a redirected %APPDATA%. */
function startupFolder(appDataDir) {
  return path.join(appDataDir, ...STARTUP_RELATIVE);
}

/** bin\ (WinSW wrapper) plus runtime\ and, optionally, runtime.prev\. */
function writeCodeTree(dataDir, { runtimeVersion, runtimePrevVersion = null }) {
  write(path.join(dataDir, 'bin', 'EasyDevOps.exe'), `winsw-wrapper:${runtimeVersion}`);
  write(path.join(dataDir, 'bin', 'EasyDevOps.exe.prev'), `winsw-wrapper-previous:${runtimeVersion}`);
  write(path.join(dataDir, 'bin', 'EasyDevOps.xml'),
    buildServiceXml(runtimeVersion, 'well-formed', dataDir));
  writeRuntimeCopy(path.join(dataDir, 'runtime'), runtimeVersion);
  if (runtimePrevVersion) writeRuntimeCopy(path.join(dataDir, 'runtime.prev'), runtimePrevVersion);
}

/**
 * The DACL model for a code tree the fake icacls eats.
 *
 * `emptyAcl` is the evidence's A1: every file under bin\ and runtime\ left with
 * NO ACEs and with inheritance removed, which is why Copy-Item and the
 * verification both failed.
 */
function codeTreeAclRecords({ version, dataDir, roots, emptyAcl, perFile = true }) {
  const probeFiles = ['bin/EasyDevOps.exe', 'runtime/node.exe', 'runtime/app/src/cli/index.js'];
  const records = aclRecords({
    version,
    state: { emptyAcl, operator: { ...OPERATOR, dataDir: true } },
    roots,
    probeFiles,
  });
  if (!perFile) {
    // An 11,000-file tree does not need 11,000 seed records: the fake computes
    // inheritance, so the healthy state is the folder's ACL plus nothing.
    records.files = {};
    records.description += ' Folder-level only: every file inherits (the healthy state).';
  }
  return { records, probeFiles, dataDir };
}

function writeOperatorRecord(file, { version, registered, operator = OPERATOR, sddl = null }) {
  write(file, `${JSON.stringify({
    version,
    mechanism: 'winsw',
    mode: 'server',
    operator: { ...operator, serviceControl: false, dataDir: false },
    service: {
      id: 'EasyDevOps',
      account: TRUSTEES.SERVICE,
      registered,
      sddl,
    },
  }, null, 2)}\n`);
}

function windowsCodeRoots(dataDir, { withRuntimePrev = true } = {}) {
  const roots = {
    bin: path.join(dataDir, 'bin'),
    runtime: path.join(dataDir, 'runtime'),
  };
  if (withRuntimePrev && fs.existsSync(path.join(dataDir, 'runtime.prev'))) {
    roots['runtime.prev'] = path.join(dataDir, 'runtime.prev');
  }
  return roots;
}

/**
 * The broken Windows Server from the owner's evidence, before 1.4.8:
 *
 *   - no service registered (`sc query` answered 1060);
 *   - C:\ProgramData\easy-devops holds an earlier Server-mode install: bin,
 *     runtime, runtime.prev, claims, logs, sessions and the REAL 15-key
 *     database, with empty DACLs on the runtime files;
 *   - %APPDATA%\easy-devops holds a near-empty 4-key database, created when the
 *     CLI found no Server-mode marker;
 *   - no .server-mode marker, so `ezz service status` called it Personal.
 */
export function materializeServerEvidenceFixture(root) {
  assertAbsolute(root, 'the fixture root');
  const fixtureRoot = path.join(root, 'server-evidence');
  const programData = path.join(fixtureRoot, 'ProgramData');
  const dataDir = path.join(programData, 'easy-devops');
  const appDataDir = path.join(fixtureRoot, 'AppData');
  const userDataDir = path.join(appDataDir, 'easy-devops');
  const version = '1.4.7';

  writeCodeTree(dataDir, { runtimeVersion: '1.4.7', runtimePrevVersion: '1.4.5' });
  for (const folder of ['claims', 'logs', 'sessions']) mkdir(path.join(dataDir, folder));
  writeUserData(dataDir, version, 'windows');
  // The real database replaces the header-only fixture one, and the bogus -wal
  // next to it goes: SQLite must open this file, not recover a fake journal.
  fs.rmSync(path.join(dataDir, 'easy-devops.sqlite-wal'), { force: true });
  const programDatabase = writeKeyDatabase(path.join(dataDir, 'easy-devops.sqlite'), EVIDENCE_DATA_KEYS, version);

  mkdir(userDataDir);
  const userDatabase = writeKeyDatabase(path.join(userDataDir, 'easy-devops.sqlite'), EVIDENCE_APPDATA_KEYS, version);

  const metadata = path.join(fixtureRoot, 'metadata');
  const { records, probeFiles } = codeTreeAclRecords({
    version,
    dataDir,
    roots: windowsCodeRoots(dataDir),
    emptyAcl: true,
  });
  write(path.join(metadata, 'acl-records.json'), `${JSON.stringify(records, null, 2)}\n`);
  writeOperatorRecord(path.join(metadata, 'service-operator.json'), { version, registered: false });

  const startupDir = startupFolder(appDataDir);

  return {
    name: 'server-evidence',
    kind: 'windows',
    root: fixtureRoot,
    description: 'The real 1.4.7 Windows Server: no service, ProgramData with the real data, '
      + 'a near-empty %APPDATA% database, empty DACLs on the code, no marker.',
    windows: {
      programData,
      dataDir,
      appDataDir,
      userDataDir,
      binDir: path.join(dataDir, 'bin'),
      runtimeRoot: path.join(dataDir, 'runtime'),
      runtimePrevRoot: path.join(dataDir, 'runtime.prev'),
      claimsDir: path.join(dataDir, 'claims'),
      logsDir: path.join(dataDir, 'logs'),
      sessionsDir: path.join(dataDir, 'sessions'),
      dbPath: programDatabase.file,
      userDbPath: userDatabase.file,
      databases: {
        programData: { keyCount: programDatabase.keyCount, real: programDatabase.real },
        user: { keyCount: userDatabase.keyCount, real: userDatabase.real },
      },
      markerPath: path.join(dataDir, '.server-mode'),
      markerPresent: false,
      serviceRegistered: false,
      edition: 'server',
      mode: 'server',
      runtimeVersion: '1.4.7',
      runtimePrevVersion: '1.4.5',
      cliVersion: version,
      getComponentVersions: { cli: version, daemonRuntime: '1.4.7' },
      startupDir,
      launcherPath: path.join(startupDir, PERSONAL_LAUNCHER_FILE),
      supervisorPath: path.join(dataDir, PERSONAL_SUPERVISOR_FILE),
      aclRecordsPath: path.join(metadata, 'acl-records.json'),
      aclRecords: records,
      operatorRecordPath: path.join(metadata, 'service-operator.json'),
      probeFiles,
      userDataPaths: USER_DATA_ENTRIES.filter((entry) => entry !== 'easy-devops.sqlite-wal')
        .map((entry) => path.join(dataDir, entry)),
    },
    expectations: {
      serviceRegistered: false,
      markerPresent: false,
      leftoverData: true,
      recommended: 'adopt',
      programDataKeys: EVIDENCE_DATA_KEYS.length,
      userDataKeys: EVIDENCE_APPDATA_KEYS.length,
      emptyDacls: true,
      noStartupFilesOnServer: true,
    },
  };
}

/**
 * A Personal launcher left on a Windows SERVER by 1.4.7's repair: the bootstrap
 * in the Startup folder and the supervisor in the data directory.
 */
export function materializePersonalLauncherOnServerFixture(root) {
  assertAbsolute(root, 'the fixture root');
  const fixtureRoot = path.join(root, 'personal-launcher-on-server');
  const programData = path.join(fixtureRoot, 'ProgramData');
  const dataDir = path.join(programData, 'easy-devops');
  const appDataDir = path.join(fixtureRoot, 'AppData');
  const version = '1.4.7';

  writeCodeTree(dataDir, { runtimeVersion: version });
  mkdir(path.join(dataDir, 'logs'));
  writeUserData(dataDir, version, 'windows');
  writeKeyDatabase(path.join(dataDir, 'easy-devops.sqlite'), EVIDENCE_DATA_KEYS, version);
  write(path.join(dataDir, '.server-mode'),
    `${JSON.stringify({ version, enabledAt: '2026-11-24T15:30:00.000Z' }, null, 2)}\n`);

  const startupDir = startupFolder(appDataDir);
  mkdir(startupDir);
  const launcherPath = path.join(startupDir, PERSONAL_LAUNCHER_FILE);
  const supervisorPath = path.join(dataDir, PERSONAL_SUPERVISOR_FILE);
  write(launcherPath,
    '@echo off\r\nrem Personal launcher written by 1.4.7 repair on a Server edition\r\n'
    + `start "" powershell -NoProfile -WindowStyle Hidden -Command "${supervisorPath}"\r\n`);
  write(supervisorPath,
    '@echo off\r\n:loop\r\nnode "%BASE%\\runtime\\node.exe" "%BASE%\\runtime\\app\\src\\cli\\index.js" daemon\r\n'
    + 'timeout /t 5 >nul\r\ngoto loop\r\n');
  write(path.join(dataDir, 'daemon-supervisor.log'), 'supervisor started (fixture)\n');

  const metadata = path.join(fixtureRoot, 'metadata');
  const { records, probeFiles } = codeTreeAclRecords({
    version,
    dataDir,
    roots: windowsCodeRoots(dataDir),
    emptyAcl: false,
  });
  write(path.join(metadata, 'acl-records.json'), `${JSON.stringify(records, null, 2)}\n`);
  writeOperatorRecord(path.join(metadata, 'service-operator.json'), { version, registered: false });

  return {
    name: 'personal-launcher-on-server',
    kind: 'windows',
    root: fixtureRoot,
    description: 'Windows Server edition with no service but 1.4.7\'s Personal launcher in the '
      + 'Startup folder and the supervisor in the data directory.',
    windows: {
      programData,
      dataDir,
      appDataDir,
      userDataDir: path.join(appDataDir, 'easy-devops'),
      binDir: path.join(dataDir, 'bin'),
      runtimeRoot: path.join(dataDir, 'runtime'),
      dbPath: path.join(dataDir, 'easy-devops.sqlite'),
      markerPath: path.join(dataDir, '.server-mode'),
      markerPresent: true,
      serviceRegistered: false,
      edition: 'server',
      mode: 'server',
      runtimeVersion: version,
      cliVersion: version,
      startupDir,
      launcherPath,
      supervisorPath,
      personalLauncher: { present: true, files: [launcherPath, supervisorPath] },
      aclRecordsPath: path.join(metadata, 'acl-records.json'),
      aclRecords: records,
      operatorRecordPath: path.join(metadata, 'service-operator.json'),
      probeFiles,
      userDataPaths: USER_DATA_ENTRIES.map((entry) => path.join(dataDir, entry)),
    },
    expectations: {
      serviceRegistered: false,
      edition: 'server',
      personalLauncherPresent: true,
      // Part 1 item 4: install/repair back the two files up, then remove exactly them.
      removeOnly: [launcherPath, supervisorPath],
      backupBeforeRemove: true,
      noStartupFilesAfter: true,
      installOffers: 'ezz service install',
    },
  };
}

/**
 * 1.4.7's install stopped at the runtime step. The progress record says so, so
 * `ezz service install` resumes there instead of starting over or claiming the
 * permissions were never granted.
 */
export function materializeInterruptedInstallFixture(root) {
  assertAbsolute(root, 'the fixture root');
  const fixtureRoot = path.join(root, 'install-interrupted');
  const programData = path.join(fixtureRoot, 'ProgramData');
  const dataDir = path.join(programData, 'easy-devops');
  const appDataDir = path.join(fixtureRoot, 'AppData');
  const version = '1.4.7';

  writeCodeTree(dataDir, { runtimeVersion: version });
  mkdir(path.join(dataDir, 'logs'));
  write(path.join(dataDir, '.server-mode'),
    `${JSON.stringify({ version, enabledAt: '2026-11-25T09:10:00.000Z' }, null, 2)}\n`);
  writeUserData(dataDir, version, 'windows');
  writeKeyDatabase(path.join(dataDir, 'easy-devops.sqlite'), EVIDENCE_DATA_KEYS, version);

  const progressPath = path.join(dataDir, INSTALL_PROGRESS_FILE);
  const error = `C:\\ProgramData\\easy-devops\\runtime: verifying the new permissions failed: `
    + `C:\\ProgramData\\easy-devops\\runtime\\node.exe is missing from the read-back. `
    + 'The previous permissions were restored.';
  write(progressPath, `${JSON.stringify({
    version,
    startedAt: '2026-11-25T09:10:00.000Z',
    updatedAt: '2026-11-25T09:12:41.000Z',
    steps: { dataDir: 'done', bin: 'done', runtime: 'failed' },
    failedStep: 'runtime',
    error,
  }, null, 2)}\n`);

  const metadata = path.join(fixtureRoot, 'metadata');
  const { records, probeFiles } = codeTreeAclRecords({
    version,
    dataDir,
    roots: windowsCodeRoots(dataDir, { withRuntimePrev: false }),
    emptyAcl: true,
  });
  write(path.join(metadata, 'acl-records.json'), `${JSON.stringify(records, null, 2)}\n`);
  writeOperatorRecord(path.join(metadata, 'service-operator.json'), { version, registered: false });

  return {
    name: 'install-interrupted',
    kind: 'windows',
    root: fixtureRoot,
    description: 'The install that stopped at the runtime permission step: dataDir and bin done, '
      + 'runtime failed, and nothing left to guess.',
    windows: {
      programData,
      dataDir,
      appDataDir,
      userDataDir: path.join(appDataDir, 'easy-devops'),
      binDir: path.join(dataDir, 'bin'),
      runtimeRoot: path.join(dataDir, 'runtime'),
      dbPath: path.join(dataDir, 'easy-devops.sqlite'),
      markerPath: path.join(dataDir, '.server-mode'),
      markerPresent: true,
      serviceRegistered: false,
      edition: 'server',
      mode: 'server',
      runtimeVersion: version,
      cliVersion: version,
      installProgressPath: progressPath,
      installProgress: {
        version,
        steps: { dataDir: 'done', bin: 'done', runtime: 'failed' },
        failedStep: 'runtime',
      },
      aclRecordsPath: path.join(metadata, 'acl-records.json'),
      aclRecords: records,
      operatorRecordPath: path.join(metadata, 'service-operator.json'),
      probeFiles,
      userDataPaths: USER_DATA_ENTRIES.map((entry) => path.join(dataDir, entry)),
    },
    expectations: {
      serviceRegistered: false,
      installProgressPresent: true,
      resumeFrom: 'runtime',
      statusSays: 'install not finished: run ezz service install to resume',
    },
  };
}

/**
 * The daemon still runs the runtime copy from 1.4.4 while the CLI is 1.4.6: the
 * drift `ezz service status` reported as "Service version" without saying which
 * side it came from.
 */
export function materializeOldDaemonRuntimeFixture(root) {
  assertAbsolute(root, 'the fixture root');
  const fixtureRoot = path.join(root, 'runtime-older-than-cli');
  const programData = path.join(fixtureRoot, 'ProgramData');
  const dataDir = path.join(programData, 'easy-devops');
  const appDataDir = path.join(fixtureRoot, 'AppData');
  const cliVersion = '1.4.6';
  const runtimeVersion = '1.4.4';

  writeCodeTree(dataDir, { runtimeVersion });
  mkdir(path.join(dataDir, 'logs'));
  write(path.join(dataDir, '.server-mode'),
    `${JSON.stringify({ version: cliVersion, enabledAt: '2026-11-20T08:00:00.000Z' }, null, 2)}\n`);
  writeUserData(dataDir, cliVersion, 'windows');
  writeKeyDatabase(path.join(dataDir, 'easy-devops.sqlite'), EVIDENCE_DATA_KEYS, cliVersion);
  const now = Date.now();
  write(path.join(dataDir, 'daemon.lock'), `${JSON.stringify({
    pid: 4242,
    startedAt: now - 3_600_000,
    heartbeatAt: now - 5_000,
    version: runtimeVersion,
    mode: 'daemon',
  }, null, 2)}\n`);

  const metadata = path.join(fixtureRoot, 'metadata');
  const { records, probeFiles } = codeTreeAclRecords({
    version: cliVersion,
    dataDir,
    roots: windowsCodeRoots(dataDir, { withRuntimePrev: false }),
    emptyAcl: false,
  });
  write(path.join(metadata, 'acl-records.json'), `${JSON.stringify(records, null, 2)}\n`);
  writeOperatorRecord(path.join(metadata, 'service-operator.json'), {
    version: cliVersion,
    registered: true,
    sddl: HISTORICAL_SERVICE_SDDL,
  });

  return {
    name: 'runtime-older-than-cli',
    kind: 'windows',
    root: fixtureRoot,
    description: 'The service runs runtime\\app at 1.4.4 while the CLI is 1.4.6.',
    windows: {
      programData,
      dataDir,
      appDataDir,
      userDataDir: path.join(appDataDir, 'easy-devops'),
      binDir: path.join(dataDir, 'bin'),
      runtimeRoot: path.join(dataDir, 'runtime'),
      runtimeAppPackagePath: path.join(dataDir, 'runtime', 'app', 'package.json'),
      dbPath: path.join(dataDir, 'easy-devops.sqlite'),
      markerPath: path.join(dataDir, '.server-mode'),
      markerPresent: true,
      serviceRegistered: true,
      edition: 'server',
      mode: 'server',
      runtimeVersion,
      daemonVersion: runtimeVersion,
      cliVersion,
      daemonLockPath: path.join(dataDir, 'daemon.lock'),
      aclRecordsPath: path.join(metadata, 'acl-records.json'),
      aclRecords: records,
      operatorRecordPath: path.join(metadata, 'service-operator.json'),
      probeFiles,
      userDataPaths: USER_DATA_ENTRIES.map((entry) => path.join(dataDir, entry)),
    },
    expectations: {
      versionDrift: true,
      runtimeVersion,
      cliVersion,
      // "Service version" must come from the runtime copy, not the CLI package.
      serviceVersionSource: 'runtime\\app\\package.json',
      statusOffers: 'ezz service repair',
    },
  };
}

/** A live daemon and a stop request that was never consumed. */
export function materializeStaleStopRequestFixture(root) {
  assertAbsolute(root, 'the fixture root');
  const fixtureRoot = path.join(root, 'stale-stop-request');
  const programData = path.join(fixtureRoot, 'ProgramData');
  const dataDir = path.join(programData, 'easy-devops');
  const version = '1.4.7';

  writeCodeTree(dataDir, { runtimeVersion: version });
  mkdir(path.join(dataDir, 'logs'));
  writeUserData(dataDir, version, 'windows');
  writeKeyDatabase(path.join(dataDir, 'easy-devops.sqlite'), EVIDENCE_DATA_KEYS, version);
  write(path.join(dataDir, '.server-mode'),
    `${JSON.stringify({ version, enabledAt: '2026-11-24T15:30:00.000Z' }, null, 2)}\n`);

  const now = Date.now();
  write(path.join(dataDir, 'daemon.lock'), `${JSON.stringify({
    pid: 4242,
    startedAt: now - 7_200_000,
    heartbeatAt: now - 3_000,
    version,
    mode: 'daemon',
  }, null, 2)}\n`);
  write(path.join(dataDir, 'daemon.stop'), `${JSON.stringify({
    at: '2026-11-24T16:18:00.000Z',
    by: 10376,
    reason: 'stopped before the 1.4.7 update',
  }, null, 2)}\n`);
  write(path.join(dataDir, 'service-state.json'), `${JSON.stringify({
    version,
    mode: 'server',
    stoppedAt: '2026-11-25T16:28:00.000Z',
    installedAt: '2026-11-24T15:30:00.000Z',
  }, null, 2)}\n`);

  const metadata = path.join(fixtureRoot, 'metadata');
  const { records, probeFiles } = codeTreeAclRecords({
    version,
    dataDir,
    roots: windowsCodeRoots(dataDir, { withRuntimePrev: false }),
    emptyAcl: false,
    perFile: false,
  });
  write(path.join(metadata, 'acl-records.json'), `${JSON.stringify(records, null, 2)}\n`);
  writeOperatorRecord(path.join(metadata, 'service-operator.json'), {
    version,
    registered: true,
    sddl: HISTORICAL_SERVICE_SDDL,
  });

  return {
    name: 'stale-stop-request',
    kind: 'windows',
    root: fixtureRoot,
    description: 'A daemon that is running (fresh heartbeat) next to a stop request nobody consumed.',
    windows: {
      programData,
      dataDir,
      binDir: path.join(dataDir, 'bin'),
      runtimeRoot: path.join(dataDir, 'runtime'),
      dbPath: path.join(dataDir, 'easy-devops.sqlite'),
      markerPath: path.join(dataDir, '.server-mode'),
      markerPresent: true,
      serviceRegistered: true,
      edition: 'server',
      runtimeVersion: version,
      cliVersion: version,
      daemonLockPath: path.join(dataDir, 'daemon.lock'),
      stopRequestPath: path.join(dataDir, 'daemon.stop'),
      serviceStatePath: path.join(dataDir, 'service-state.json'),
      aclRecordsPath: path.join(metadata, 'acl-records.json'),
      aclRecords: records,
      operatorRecordPath: path.join(metadata, 'service-operator.json'),
      probeFiles,
      userDataPaths: USER_DATA_ENTRIES.map((entry) => path.join(dataDir, entry)),
    },
    expectations: {
      daemonRunning: true,
      stopRequestPending: true,
      // A stale request is a leftover, not "the user stopped it".
      statusMustNotSay: 'stopped by you',
    },
  };
}

/** Writes a runtime tree large enough for the 1.4.7 ordering bug. */
function writeLargeRuntime(runtimeRoot, packages) {
  let files = 0;
  const mkdirCounted = (dir) => { mkdir(dir); };
  const touch = (relative) => {
    const full = path.join(runtimeRoot, ...relative);
    mkdir(path.dirname(full));
    fs.writeFileSync(full, '// fixture\n');
    files += 1;
    return full;
  };

  mkdirCounted(runtimeRoot);
  touch(['node.exe']);
  touch(['package.json']);
  touch(['app', 'package.json']);
  touch(['app', 'src', 'cli', 'index.js']);
  touch(['app', 'src', 'core', 'service', 'acl.js']);
  mkdirCounted(path.join(runtimeRoot, 'app', 'node_modules'));
  for (let p = 0; p < packages; p += 1) {
    const pkg = `pkg${String(p).padStart(3, '0')}`;
    const base = ['app', 'node_modules', pkg];
    mkdirCounted(path.join(runtimeRoot, ...base));
    touch([...base, 'package.json']);
    touch([...base, 'index.js']);
    for (const bucket of [
      { dir: ['lib'], count: 20 },
      { dir: ['lib', 'esm'], count: 20 },
      { dir: ['lib', 'umd'], count: 20 },
      { dir: ['test'], count: 20 },
      { dir: ['test', 'fixtures'], count: 26 },
    ]) {
      mkdirCounted(path.join(runtimeRoot, ...base, ...bucket.dir));
      for (let i = 0; i < bucket.count; i += 1) {
        touch([...base, ...bucket.dir, `file${String(i).padStart(3, '0')}.js`]);
      }
    }
  }
  return files;
}

/**
 * The real scale: an 11,000+ file runtime where `app\node_modules\...` sorts
 * before `node.exe`'s siblings, so a /T listing read from a 64 KiB tail loses
 * the file that matters. `files` is the count actually written.
 */
export function materializeLargeRuntimeFixture(root, { packages = 102 } = {}) {
  assertAbsolute(root, 'the fixture root');
  const fixtureRoot = path.join(root, 'large-runtime');
  const programData = path.join(fixtureRoot, 'ProgramData');
  const dataDir = path.join(programData, 'easy-devops');
  const version = '1.4.7';

  const runtimeRoot = path.join(dataDir, 'runtime');
  const files = writeLargeRuntime(runtimeRoot, packages);
  write(path.join(dataDir, 'bin', 'EasyDevOps.exe'), `winsw-wrapper:${version}`);
  write(path.join(dataDir, 'bin', 'EasyDevOps.xml'), buildServiceXml(version, 'well-formed', dataDir));
  writeUserData(dataDir, version, 'windows');
  writeKeyDatabase(path.join(dataDir, 'easy-devops.sqlite'), EVIDENCE_DATA_KEYS, version);
  write(path.join(dataDir, '.server-mode'),
    `${JSON.stringify({ version, enabledAt: '2026-11-24T15:30:00.000Z' }, null, 2)}\n`);

  const metadata = path.join(fixtureRoot, 'metadata');
  const { records, probeFiles } = codeTreeAclRecords({
    version,
    dataDir,
    roots: windowsCodeRoots(dataDir, { withRuntimePrev: false }),
    emptyAcl: false,
    perFile: false,
  });
  write(path.join(metadata, 'acl-records.json'), `${JSON.stringify(records, null, 2)}\n`);

  return {
    name: 'large-runtime',
    kind: 'windows',
    root: fixtureRoot,
    description: `A ${files}-file runtime tree: node.exe at the top, app\\node_modules below it.`,
    windows: {
      programData,
      dataDir,
      binDir: path.join(dataDir, 'bin'),
      runtimeRoot,
      runtimeFileCount: files,
      dbPath: path.join(dataDir, 'easy-devops.sqlite'),
      markerPath: path.join(dataDir, '.server-mode'),
      markerPresent: true,
      serviceRegistered: true,
      edition: 'server',
      runtimeVersion: version,
      cliVersion: version,
      aclRecordsPath: path.join(metadata, 'acl-records.json'),
      aclRecords: records,
      probeFiles,
      userDataPaths: USER_DATA_ENTRIES.map((entry) => path.join(dataDir, entry)),
    },
    expectations: {
      runtimeFiles: files,
      // The listing must be read as a stream: 4-7 MB, never through a tail.
      listingBytesAtLeast: 4 * 1024 * 1024,
      protectBudgetMs: 30_000,
      maxRecursivePasses: 1,
    },
  };
}

/**
 * Linux: the unit 1.4.6 left behind - an `Environment=` line inside a COMMENT in
 * `[Unit]` (so systemd ignored it) - and an operator-tuned unit that only adds
 * `LimitNOFILE`, which a repair must not silently discard.
 */
export function materializeLinuxUnitTuningFixture(root) {
  assertAbsolute(root, 'the fixture root');
  const fixtureRoot = path.join(root, 'linux-unit-tuning');
  const dataDir = path.join(fixtureRoot, 'data');
  const version = '1.4.6';

  const malformedUnitPath = path.join(fixtureRoot, 'easy-devops.service');
  write(malformedUnitPath, buildUnit(version, 'malformed-comment', dataDir));

  const tunedUnitPath = path.join(fixtureRoot, 'easy-devops.tuned.service');
  write(tunedUnitPath, `[Unit]
Description=Easy DevOps background service (${version})
After=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/usr/lib/node_modules/easy-devops
ExecStart=${path.join(dataDir, 'runtime', 'node')} --experimental-loader=file:///usr/lib/node_modules/easy-devops/src/core/service/runtime-loader.mjs /usr/lib/node_modules/easy-devops/src/cli/index.js daemon
Restart=always
RestartSec=5
Environment=NODE_OPTIONS=
Environment=NODE_PATH=
Environment=NODE_ENV=production
LimitNOFILE=1048576
# operator tuning: keep it when repair rewrites the unit

[Install]
WantedBy=multi-user.target
`);

  write(path.join(dataDir, 'runtime', 'node.version'), 'v20.19.0\n');
  write(path.join(dataDir, 'runtime', 'node'), 'historical-pinned-node:v20.19.0\n');
  writeUserData(dataDir, version, 'linux');
  // A stop request left by an earlier `ezz service stop`: recovery must clear
  // it, or the daemon it restarts would exit at once.
  write(path.join(dataDir, 'daemon.stop'),
    `${JSON.stringify({ at: '2026-11-25T06:00:00.000Z', by: 771, reason: 'slow restart' }, null, 2)}\n`);

  return {
    name: 'linux-unit-tuning',
    kind: 'linux',
    root: fixtureRoot,
    description: 'The malformed 1.4.6 unit (Environment= inside [Unit]) and an operator-tuned unit '
      + 'with LimitNOFILE that repair must preserve.',
    linux: {
      root: fixtureRoot,
      dataDir,
      malformedUnitPath,
      tunedUnitPath,
      unitVersion: version,
      expectedEnvironmentSection: 'Service',
      tunedLimitNofile: '1048576',
      runtimeRoot: path.join(dataDir, 'runtime'),
      stopRequestPath: path.join(dataDir, 'daemon.stop'),
      userDataPaths: USER_DATA_ENTRIES.map((entry) => path.join(dataDir, entry)),
    },
    expectations: {
      malformedLineInUnit: true,
      mustMoveEnvironmentTo: 'Service',
      keepOperatorTuning: ['LimitNOFILE'],
      unitPathAfterRepair: '/etc/systemd/system/easy-devops.service',
    },
  };
}

/**
 * Linux: an update that failed and rolled back to the previous version. The
 * record is what the dashboard reads on the way back up, and the runtime on disk
 * is the OLD one, which is the point: a rollback keeps the old copy.
 */
export function materializeLinuxFailedUpdateRollbackFixture(root) {
  assertAbsolute(root, 'the fixture root');
  const fixtureRoot = path.join(root, 'linux-failed-update-rollback');
  const dataDir = path.join(fixtureRoot, 'data');
  const from = '1.4.5';
  const to = '1.4.6';

  write(path.join(dataDir, 'runtime', 'node.version'), 'v20.19.0\n');
  write(path.join(dataDir, 'runtime', 'node'), 'historical-pinned-node:v20.19.0\n');
  write(path.join(dataDir, 'runtime', 'app', 'package.json'),
    `${JSON.stringify({ name: 'easy-devops', version: from }, null, 2)}\n`);
  writeUserData(dataDir, from, 'linux');
  write(path.join(dataDir, UPDATE_STATUS_FILE), `${JSON.stringify({
    id: 'fixture-failed-update',
    phase: 'failed',
    from,
    to,
    startedAt: '2026-11-24T21:02:11.000Z',
    updatedAt: '2026-11-24T21:04:52.000Z',
    error: 'the daemon did not come up on 1.4.6 within 60 s',
    rollback: {
      attempted: true,
      restoredVersion: from,
      confirmedBy: 'heartbeat',
      at: '2026-11-24T21:05:30.000Z',
    },
  }, null, 2)}\n`);
  write(path.join(dataDir, 'service-state.json'), `${JSON.stringify({
    version: from,
    mode: 'systemd',
    installedAt: '2026-11-01T10:00:00.000Z',
  }, null, 2)}\n`);
  // The unit the running (rolled-back) service still uses. Post-update rewrites
  // exactly this file, and must not touch the runtime copy the rollback kept.
  const unitPath = path.join(fixtureRoot, 'easy-devops.service');
  write(unitPath, buildUnit(from, 'well-formed', dataDir));

  return {
    name: 'linux-failed-update-rollback',
    kind: 'linux',
    root: fixtureRoot,
    description: `A failed ${from} -> ${to} update that rolled back to ${from}.`,
    linux: {
      root: fixtureRoot,
      dataDir,
      unitPath,
      updateStatusPath: path.join(dataDir, UPDATE_STATUS_FILE),
      serviceStatePath: path.join(dataDir, 'service-state.json'),
      runtimeRoot: path.join(dataDir, 'runtime'),
      runtimePackagePath: path.join(dataDir, 'runtime', 'app', 'package.json'),
      runtimeVersion: from,
      failedTargetVersion: to,
      userDataPaths: USER_DATA_ENTRIES.map((entry) => path.join(dataDir, entry)),
    },
    expectations: {
      updatePhase: 'failed',
      rolledBackTo: from,
      rollbackConfirmedBy: 'heartbeat',
      userDataUnchanged: true,
    },
  };
}

/**
 * Linux: the database is held by a leftover process. The fixture ships the real
 * `fuser` and `lsof` answers a stub `runFile` should return, plus the pid and
 * command a report must name - it never ships a kill.
 */
export function materializeLinuxDatabaseHeldFixture(root) {
  assertAbsolute(root, 'the fixture root');
  const fixtureRoot = path.join(root, 'linux-database-held');
  const dataDir = path.join(fixtureRoot, 'data');
  const version = '1.4.7';
  const pid = 48213;
  const command = 'node /usr/lib/node_modules/easy-devops/src/cli/index.js daemon';

  writeUserData(dataDir, version, 'linux');
  writeKeyDatabase(path.join(dataDir, 'easy-devops.sqlite'), EVIDENCE_DATA_KEYS, version);
  write(path.join(dataDir, 'daemon.lock'), `${JSON.stringify({
    pid,
    startedAt: Date.parse('2026-11-25T07:00:00.000Z'),
    heartbeatAt: Date.parse('2026-11-25T07:00:30.000Z'),
    version,
    mode: 'daemon',
  }, null, 2)}\n`);

  const databasePath = path.join(dataDir, 'easy-devops.sqlite');
  const answers = {
    // `fuser -v <db>*`
    fuser: [
      '                     USER        PID ACCESS COMMAND',
      `${databasePath}:`,
      `                     root     ${pid} F.... ${command.split(' ').slice(0, 2).join(' ')}`,
      `${databasePath}-wal:`,
      `                     root     ${pid} F.... ${command.split(' ').slice(0, 2).join(' ')}`,
      '',
    ].join('\n'),
    // `lsof <db>`
    lsof: [
      'COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF     NODE NAME',
      `node    ${pid} root   12u   REG  253,0   409600   912345 ${databasePath}`,
      `node    ${pid} root   13u   REG  253,0    32768   912346 ${databasePath}-wal`,
      '',
    ].join('\n'),
  };

  return {
    name: 'linux-database-held',
    kind: 'linux',
    root: fixtureRoot,
    description: 'A leftover Easy DevOps process holds the database (SQLITE_BUSY).',
    linux: {
      root: fixtureRoot,
      dataDir,
      dbPath: databasePath,
      daemonLockPath: path.join(dataDir, 'daemon.lock'),
      userDataPaths: USER_DATA_ENTRIES.map((entry) => path.join(dataDir, entry)),
      holder: {
        pid,
        command,
        isEasyDevOpsProcess: true,
        answers,
      },
    },
    expectations: {
      reportsPid: pid,
      reportsCommand: command,
      neverKillsAnUnknownProcess: true,
      neverDeletesFiles: true,
      // The message names the holder; it must not be "delete the database".
      mustNotSay: 'do not delete the database',
    },
  };
}

/**
 * Every 1.4.8 state, materialized under `root`.
 *
 * @param {string} root An absolute directory inside the run's test data root
 * @returns {Object<string, Object>} state objects keyed by UPGRADE_STATE_NAMES
 */
export function materializeUpgradeStates(root) {
  assertAbsolute(root, 'the fixture root');
  mkdir(root);
  return {
    'server-evidence': materializeServerEvidenceFixture(root),
    'personal-launcher-on-server': materializePersonalLauncherOnServerFixture(root),
    'install-interrupted': materializeInterruptedInstallFixture(root),
    'runtime-older-than-cli': materializeOldDaemonRuntimeFixture(root),
    'stale-stop-request': materializeStaleStopRequestFixture(root),
    'large-runtime': materializeLargeRuntimeFixture(root),
    'linux-unit-tuning': materializeLinuxUnitTuningFixture(root),
    'linux-failed-update-rollback': materializeLinuxFailedUpdateRollbackFixture(root),
    'linux-database-held': materializeLinuxDatabaseHeldFixture(root),
  };
}

/**
 * The HEALTHY state every published release left, for each of 1.4.0-1.4.7.
 *
 * This is the other half of Part 2: not "can a broken server be repaired" but
 * "does repair leave a working one working" - on Windows Server, and on Linux
 * as root and as a normal user. Each entry is the same shape as the evidence
 * states, so one harness drives them all.
 *
 * @param {string} root An absolute directory inside the run's test data root
 * @param {{ versions?: string[] }} [options]
 * @returns {Array<Object>} one entry per published version
 */
export function materializeHealthyVersionFixtures(root, { versions = PUBLISHED_VERSIONS } = {}) {
  assertAbsolute(root, 'the fixture root');
  mkdir(root);

  return versions.map((version) => {
    const versionRoot = path.join(root, `healthy-${version}`);

    // ── Windows Server ─────────────────────────────────────────────────────
    const windowsRoot = path.join(versionRoot, 'windows');
    const programData = path.join(windowsRoot, 'ProgramData');
    const dataDir = path.join(programData, 'easy-devops');
    const appDataDir = path.join(windowsRoot, 'AppData');
    writeCodeTree(dataDir, { runtimeVersion: version });
    mkdir(path.join(dataDir, 'logs'));
    writeUserData(dataDir, version, 'windows');
    write(path.join(dataDir, '.server-mode'),
      `${JSON.stringify({ version, enabledAt: '2026-11-24T15:30:00.000Z' }, null, 2)}\n`);
    write(path.join(dataDir, 'daemon.lock'), `${JSON.stringify({
      pid: 5150,
      startedAt: Date.parse('2026-11-25T07:00:00.000Z'),
      heartbeatAt: Date.parse('2026-11-25T07:30:00.000Z'),
      version,
      mode: 'daemon',
    }, null, 2)}\n`);

    const metadata = path.join(windowsRoot, 'metadata');
    const { records, probeFiles } = codeTreeAclRecords({
      version,
      dataDir,
      roots: windowsCodeRoots(dataDir, { withRuntimePrev: false }),
      emptyAcl: false,
      // Folder-level seeds only: a healthy tree inherits, and 11,000 records
      // per version would make the fixture, not the code, the slow part.
      perFile: false,
    });
    write(path.join(metadata, 'acl-records.json'), `${JSON.stringify(records, null, 2)}\n`);
    writeOperatorRecord(path.join(metadata, 'service-operator.json'), {
      version,
      registered: true,
      sddl: HISTORICAL_SERVICE_SDDL,
    });

    // ── Linux, root and a normal user ──────────────────────────────────────
    const linuxBranch = (label, user) => {
      const branchRoot = path.join(versionRoot, label);
      const linuxDataDir = path.join(branchRoot, 'data');
      const unitPath = path.join(branchRoot, 'easy-devops.service');
      write(unitPath, `${buildUnit(version, 'well-formed', linuxDataDir, user)}`);
      write(path.join(linuxDataDir, 'runtime', 'node.version'), 'v20.19.0\n');
      write(path.join(linuxDataDir, 'runtime', 'node'), 'historical-pinned-node:v20.19.0\n');
      writeUserData(linuxDataDir, version, 'linux');
      write(path.join(linuxDataDir, 'service-state.json'), `${JSON.stringify({
        version,
        mode: 'systemd',
        installedAt: '2026-11-01T10:00:00.000Z',
      }, null, 2)}\n`);
      write(path.join(linuxDataDir, 'daemon.lock'), `${JSON.stringify({
        pid: 5151,
        startedAt: Date.parse('2026-11-25T07:00:00.000Z'),
        heartbeatAt: Date.parse('2026-11-25T07:30:00.000Z'),
        version,
        mode: 'daemon',
      }, null, 2)}\n`);
      return {
        root: branchRoot,
        dataDir: linuxDataDir,
        unitPath,
        user,
        isRoot: user === 'root',
        unitVersion: version,
        runtimeRoot: path.join(linuxDataDir, 'runtime'),
        runtimeVersion: version,
        cliVersion: version,
        daemonLockPath: path.join(linuxDataDir, 'daemon.lock'),
        userDataPaths: USER_DATA_ENTRIES.map((entry) => path.join(linuxDataDir, entry)),
      };
    };

    return {
      version,
      name: `healthy-${version}`,
      root: versionRoot,
      description: `${version} healthy on Windows Server and Linux (root and non-root).`,
      windows: {
        programData,
        dataDir,
        appDataDir,
        userDataDir: path.join(appDataDir, 'easy-devops'),
        binDir: path.join(dataDir, 'bin'),
        runtimeRoot: path.join(dataDir, 'runtime'),
        runtimePackagePath: path.join(dataDir, 'runtime', 'app', 'package.json'),
        xmlPath: path.join(dataDir, 'bin', 'EasyDevOps.xml'),
        dbPath: path.join(dataDir, 'easy-devops.sqlite'),
        markerPath: path.join(dataDir, '.server-mode'),
        markerPresent: true,
        serviceRegistered: true,
        edition: 'server',
        mode: 'server',
        runtimeVersion: version,
        cliVersion: version,
        daemonLockPath: path.join(dataDir, 'daemon.lock'),
        aclRecordsPath: path.join(metadata, 'acl-records.json'),
        aclRecords: records,
        operatorRecordPath: path.join(metadata, 'service-operator.json'),
        probeFiles,
        userDataPaths: USER_DATA_ENTRIES.map((entry) => path.join(dataDir, entry)),
      },
      linuxRoot: linuxBranch('linux-root', 'root'),
      linuxUser: linuxBranch('linux-user', 'deploy'),
      expectations: {
        healthy: true,
        serviceRunning: true,
        noStartupFilesOnServer: true,
        // A repair or recovery of a working server changes no data.
        userDataUnchanged: true,
      },
    };
  });
}
