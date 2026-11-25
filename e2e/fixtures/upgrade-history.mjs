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

export const HISTORICAL_VERSIONS = Object.freeze(['1.4.0', '1.4.3', '1.4.5', '1.4.6']);

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

function buildUnit(version, variant, dataDir) {
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
User=root
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
User=root
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
User=root
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

/** The ACEs a protected executable folder carries before 1.4.7 (evidence A1). */
function folderAces() {
  return [
    ace(TRUSTEES.SYSTEM, 'F', ['OI', 'CI']),
    ace(TRUSTEES.ADMINISTRATORS, 'F', ['OI', 'CI']),
    ace(TRUSTEES.USERS, 'RX', ['OI', 'CI']),
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
