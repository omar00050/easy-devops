/**
 * Tests for the Windows Server-mode "operator": the account that installed the
 * service and may start, stop and query it without elevation.
 *
 * Run with:  npm run test:e2e -- service-operator
 *
 * Plain Node, no framework — the constitution forbids adding one here.
 *
 * ── Nothing real is ever touched ───────────────────────────────────────────
 *
 * An ACL change, a service DACL change, a UAC prompt and a Windows service all
 * need administrator rights on a real machine, so every one of them is driven
 * through an injected `run` stub and the assertions are on the COMMANDS:
 *
 *   - `icacls` and `sc.exe` never execute; `run` records the command and answers
 *     from the test's rules.
 *   - PowerShell is never started: `windowsElevatedRelaunchCmd` returns a string
 *     that is decoded here, and `requireElevation` is given a `run` stub, so the
 *     stub is what runs and the real UAC prompt is never reached.
 *   - `ProgramData` is redirected into the temp data directory for the two
 *     Windows-service install/repair cases, which therefore write only there.
 *
 * The security question these tests exist to answer is narrow and worth stating:
 * the operator grant must name ONE account SID, must never name Everyone, Users
 * or Authenticated Users, and must never hand out the rights that change the
 * service's configuration or replace its files.
 */

import './lib/guard.mjs';
import { withFileStub, aclCall } from './lib/windows-file-stub.mjs';
import { TEST_DATA_DIR, assertInsideTestDataDir } from './lib/guard.mjs';

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const results = [];
let group = '';
function setGroup(g) { group = g; process.stdout.write(`\n-- ${g}\n`); }
function check(label, passed, detail = '') {
  results.push({ group, label, passed, detail });
  process.stdout.write(`   ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`);
}

const srcUrl = (rel) => pathToFileURL(path.join(ROOT, 'src', rel)).href;

function scratch(name) {
  const dir = path.join(TEST_DATA_DIR, 'scratch', name);
  assertInsideTestDataDir(dir, `create the scratch dir ${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** A `run` stub: records every command and answers from [pattern, result] rules. */
function stubRun(rules = []) {
  const calls = [];
  const run = async (cmd) => {
    calls.push(cmd);
    for (const [pattern, answer] of rules) {
      if (pattern instanceof RegExp ? pattern.test(cmd) : cmd.includes(pattern)) {
        const result = typeof answer === 'function' ? answer(cmd) : answer;
        return { success: true, stdout: '', stderr: '', ...result };
      }
    }
    return { success: false, stdout: '', stderr: `stubRun: no rule for: ${cmd}`, unmatched: true };
  };
  run.calls = calls;
  return run;
}

const SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const ENTRA_SID = 'S-1-12-1-1111111111-2222222222-3333333333-1001';
const OTHER_SID = 'S-1-5-21-4444444444-5555555555-6666666666-1002';

/** Everyone, Users, Authenticated Users — the three that must never be granted. */
const FORBIDDEN_TRUSTEES = ['S-1-1-0', 'S-1-5-32-545', 'S-1-5-11'];

/** A service DACL as `sc.exe sdshow` prints it: SYSTEM and Administrators. */
const SERVICE_SDDL = 'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)';

/** The one ACE the operator is given, appended to the DACL. */
const OPERATOR_ACE = `(A;;CCLCLORPWP;;;${SID})`;

// ─── 1. Only an account SID is an operator ───────────────────────────────────

async function testAccountSid() {
  setGroup('1. an operator is one account, by SID');

  const op = await import(srcUrl('core/service/operator.js'));

  check('a local or domain user SID is accepted', op.isAccountSid(SID) === true, SID);
  check('an Entra ID user SID is accepted', op.isAccountSid(ENTRA_SID) === true, ENTRA_SID);

  for (const sid of ['S-1-1-0', 'S-1-5-32-545', 'S-1-5-11', 'S-1-5-18', 'S-1-5-32-544']) {
    check(`${sid} is a well-known SID, not an account`, op.isAccountSid(sid) === false);
  }

  check('a truncated SID is refused', op.isAccountSid('S-1-5-21-1-2-3') === false);
  check('a SID with a trailing part is refused', op.isAccountSid(`${SID}-99`) === false);
  check('letters in the numeric fields are refused',
    op.isAccountSid('S-1-5-21-1-2-3-abc') === false);
  check('a bare word is refused', op.isAccountSid('Administrators') === false);
  check('null is refused', op.isAccountSid(null) === false);
  check('a number is refused', op.isAccountSid(42) === false);

  // ── Whose SID is this? ───────────────────────────────────────────────────
  const userRun = stubRun([[/WindowsIdentity/, { stdout: 'noise\r\n       S-1-5-21-1-2-3-4 | DOMAIN\\me\r\n' }]]);
  const me = await op.currentUser({ run: userRun });
  check('currentUser reads the SID Windows reports', me?.sid === 'S-1-5-21-1-2-3-4', JSON.stringify(me));
  check('and keeps the display name separate', me?.name === 'DOMAIN\\me');
  check('the name never becomes the identity', me?.sid !== me?.name);
  check('it asks Windows through PowerShell, not %USERNAME%',
    /WindowsIdentity/.test(userRun.calls[0]), userRun.calls[0]);

  const junk = await op.currentUser({ run: stubRun([[/WindowsIdentity/, { stdout: 'not-a-sid|me' }]]) });
  check('unusable output is null, not a bogus SID', junk === null);

  const empty = await op.currentUser({ run: stubRun() });
  check('a failing command is null too', empty === null);

  // ── Which account the grants are for ─────────────────────────────────────
  const current = await op.resolveOperator({
    run: stubRun([[/WindowsIdentity/, { stdout: `${SID}|DOMAIN\\me` }]]),
    env: {},
  });
  check('with no relaunch it is this process\'s account', current?.sid === SID && current?.via === 'current');
  check('and the name is reported', current?.name === 'DOMAIN\\me');

  const relaunched = await op.resolveOperator({
    run: stubRun([[/WindowsIdentity/, { stdout: `${SID}|DOMAIN\\me` }]]),
    env: { EZ_OPERATOR_SID: OTHER_SID },
  });
  check('the SID the relaunch passed wins, so the installing user is granted',
    relaunched?.sid === OTHER_SID && relaunched?.via === 'relaunch', JSON.stringify(relaunched));
  check('a different account makes the name unknown rather than guessed', relaunched?.name === null);

  const sameSid = await op.resolveOperator({
    run: stubRun([[/WindowsIdentity/, { stdout: `${SID}|DOMAIN\\me` }]]),
    env: { EZ_OPERATOR_SID: SID },
  });
  check('the same SID keeps its name', sameSid?.name === 'DOMAIN\\me' && sameSid?.via === 'relaunch');

  const badEnv = await op.resolveOperator({
    run: stubRun([[/WindowsIdentity/, { stdout: `${SID}|DOMAIN\\me` }]]),
    env: { EZ_OPERATOR_SID: 'S-1-5-32-545' },
  });
  check('an environment variable naming Users is IGNORED, not trusted',
    badEnv?.sid === SID && badEnv?.via === 'current', JSON.stringify(badEnv));

  const nobody = await op.resolveOperator({ run: stubRun(), env: {} });
  check('with no readable account there is no operator', nobody === null);
}

// ─── 2. The service DACL: start and stop, nothing more ───────────────────────

async function testServiceDacl() {
  setGroup('2. the service DACL grants start, stop and query only');

  const op = await import(srcUrl('core/service/operator.js'));

  const next = op.withOperatorAce(SERVICE_SDDL, SID);
  check('the operator ACE is appended to the DACL', next.includes(OPERATOR_ACE), next);
  check('and the existing entries are kept',
    next.includes('(A;;CCLCSWRPWPDTLOCRRC;;;SY)') && next.includes(';;;BA)'));
  check('the ACE is after the existing ones, so denies stay first',
    next.indexOf(OPERATOR_ACE) > next.indexOf(';;;SY)'));
  check('no group trustee appears in the result',
    FORBIDDEN_TRUSTEES.every((sid) => !next.includes(sid)), next);

  const twice = op.withOperatorAce(next, SID);
  check('applying it again does not stack a second ACE',
    (twice.match(/CCLCLORPWP/g) ?? []).length === 1, twice);

  const without = op.withoutOperatorAce(next, SID);
  check('the operator ACE can be removed without changing the service DACL',
    without.changed === true
      && !without.sddl.includes(SID)
      && without.sddl.includes('(A;;CCLCSWRPWPDTLOCRRC;;;SY)'),
    without.sddl);

  const deniedDacl = `D:(D;;CCLCLORPWP;;;${SID})(A;;CCLCLORPWP;;;${SID})(A;;CC;;;SY)`;
  const withDeny = op.withoutOperatorAce(deniedDacl, SID);
  check('a temporary uninstall removes only the allow ACE',
    withDeny.changed === true
      && withDeny.sddl.includes(`(D;;CCLCLORPWP;;;${SID})`)
      && !withDeny.sddl.includes(`(A;;CCLCLORPWP;;;${SID})`),
    withDeny.sddl);
  let denyGrantError = null;
  try {
    op.withOperatorAce(deniedDacl, SID);
  } catch (error) {
    denyGrantError = error;
  }
  check('a repair refuses to erase an explicit deny ACE',
    /explicitly denies/.test(denyGrantError?.message ?? ''), denyGrantError?.message);

  const earlier = `D:(A;;CCLCLORPWP;;;${SID})(A;;CCLCSWRPWPDTLOCRRC;;;SY)`;
  const repaired = op.withOperatorAce(earlier, SID);
  check('an earlier ACE for the same SID is replaced, not duplicated',
    (repaired.match(new RegExp(SID, 'g')) ?? []).length === 1, repaired);
  check('and the other entries survive', repaired.includes('(A;;CCLCSWRPWPDTLOCRRC;;;SY)'));

  const lower = `D:(A;;CCLCLORPWP;;;${SID.toLowerCase()})`;
  check('the comparison is case-insensitive, so a lowercase SID is not duplicated',
    op.withOperatorAce(lower, SID).includes(OPERATOR_ACE)
    && (op.withOperatorAce(lower, SID).match(/CCLCLORPWP/g) ?? []).length === 1,
    op.withOperatorAce(lower, SID));

  const tail = op.withOperatorAce(`D:(A;;CC;;;SY)S:(AU;SA;FA;;;WD)`, SID);
  check('a SACL tail is preserved after the DACL',
    tail.endsWith('S:(AU;SA;FA;;;WD)'), tail);
  check('and the ACE sits before it', tail.indexOf(OPERATOR_ACE) < tail.indexOf('S:('));

  let threw = null;
  try { op.withOperatorAce(SERVICE_SDDL, 'S-1-5-32-545'); } catch (err) { threw = err; }
  check('a group SID is REFUSED', threw !== null && /not an account SID/.test(threw.message),
    threw?.message);

  let noDacl = null;
  try { op.withOperatorAce('S:(AU;SA;FA;;;WD)', SID); } catch (err) { noDacl = err; }
  check('a security descriptor with no DACL is REFUSED',
    noDacl !== null && /no DACL/.test(noDacl.message), noDacl?.message);

  // ── Reading the state back ───────────────────────────────────────────────
  const mine = op.operatorAceState(`D:(A;;CCLCLORPWP;;;${SID})`, SID);
  check('the granted state is read as granted', mine.granted === true && mine.excessive === false,
    JSON.stringify(mine));

  const notStartStop = op.operatorAceState(`D:(A;;RPWP;;;${SID})`, SID);
  check('without LC, start and stop is not granted',
    notStartStop.granted === false && notStartStop.excessive === false, JSON.stringify(notStartStop));

  const denied = op.operatorAceState(`D:(D;;CCLCLORPWP;;;${SID})`, SID);
  check('a deny ACE does not count as a grant', denied.granted === false);

  const other = op.operatorAceState(`D:(A;;CCLCLORPWP;;;${OTHER_SID})`, SID);
  check('another account\'s ACE does not count', other.granted === false);

  for (const [label, sddl] of [
    ['change configuration (DC)', `D:(A;;CCLCLORPWP DC;;;${SID})`],
    ['delete (SD)', `D:(A;;CCLCLORPWPSD;;;${SID})`],
    ['write the DACL (WD)', `D:(A;;CCLCLORPWPWD;;;${SID})`],
    ['take ownership (WO)', `D:(A;;CCLCLORPWPWO;;;${SID})`],
    ['generic all (GA)', `D:(A;;CCLCLORPWPGA;;;${SID})`],
    ['generic write (GW)', `D:(A;;CCLCLORPWP GW;;;${SID})`],
    ['full access (FA)', `D:(A;;FA;;;${SID})`],
  ]) {
    const state = op.operatorAceState(sddl.replace(/ /g, ''), SID);
    check(`an ACE carrying ${label} is excessive`, state.excessive === true, JSON.stringify(state));
  }

  const hex = op.operatorAceState(`D:(A;;0x1301bf;;;${SID})`, SID);
  check('a hex rights mask is excessive, because it cannot be read as codes',
    hex.excessive === true, JSON.stringify(hex));

  const noSddl = op.operatorAceState(null, SID);
  check('an unreadable DACL is not granted and not excessive',
    noSddl.granted === false && noSddl.excessive === false);
  const groupSid = op.operatorAceState(`D:(A;;CCLCLORPWP;;;${SID})`, 'S-1-1-0');
  check('asking about a group SID is never a grant',
    groupSid.granted === false && groupSid.excessive === false);

  const readRun = stubRun([[/^sc\.exe sdshow /, {
    stdout: 'SERVICE_NAME: EasyDevOps\r\n\r\nD:(A;;CC;;;SY)S:(AU;SA;FA;;;WD)',
  }]]);
  check('readServiceSddl returns the DACL line only',
    (await op.readServiceSddl({ run: readRun })) === 'D:(A;;CC;;;SY)S:(AU;SA;FA;;;WD)');
  check('readServiceSddl asks sc.exe about the service by name',
    readRun.calls[0] === 'sc.exe sdshow EasyDevOps', readRun.calls[0]);

  const directCalls = [];
  const directDacl = await op.readServiceSddl({
    runFile: async (file, args) => {
      directCalls.push({ file, args });
      return { success: true, stdout: 'D:(A;;CC;;;SY)' };
    },
  });
  check('production readServiceSddl uses direct sc.exe argv',
    directDacl === 'D:(A;;CC;;;SY)'
      && directCalls.length === 1
      && /sc\.exe$/i.test(directCalls[0].file)
      && JSON.stringify(directCalls[0].args) === JSON.stringify(['sdshow', 'EasyDevOps']),
    JSON.stringify(directCalls));

  const revokeCalls = [];
  let revokeSddl = `D:(A;;CCLCLORPWP;;;${SID})(A;;CC;;;SY)`;
  const revokeControl = await op.revokeServiceControl({
    sid: SID,
    runFile: async (file, args) => {
      revokeCalls.push({ file, args });
      if (args[0] === 'sdshow') return { success: true, stdout: revokeSddl };
      if (args[0] === 'sdset') {
        revokeSddl = args[2];
        return { success: true, stdout: '' };
      }
      return { success: false, stdout: '', stderr: `unexpected ${args.join(' ')}` };
    },
  });
  check('service control is revoked before a recursive uninstall ACL change',
    revokeControl.ok === true && revokeControl.changed === true
      && !revokeSddl.includes(SID), JSON.stringify({ revokeControl, revokeSddl }));
  check('revocation returns the exact DACL needed for an interrupted retry',
    revokeControl.previousSddl
      === `D:(A;;CCLCLORPWP;;;${SID})(A;;CC;;;SY)`,
    revokeControl.previousSddl);
  check('the service DACL change uses direct sc.exe argv',
    revokeCalls.some(({ file, args }) => /sc\.exe$/i.test(file)
      && JSON.stringify(args) === JSON.stringify(['sdset', 'EasyDevOps', revokeSddl])),
    JSON.stringify(revokeCalls));

  const noSd = stubRun([[/^sc\.exe sdshow /, { stdout: 'SERVICE_NAME: EasyDevOps' }]]);
  check('no DACL line is null, not an empty string', (await op.readServiceSddl({ run: noSd })) === null);

  let restoredSddl = '';
  const restored = await op.restoreServiceControl({
    sid: SID,
    sddl: `D:(D;;CCLCLORPWP;;;${SID})(A;;CCLCLORPWP;;;${SID})(A;;CC;;;SY)`,
    runFile: async (file, args) => {
      if (args[0] === 'sdshow') return { success: true, stdout: restoredSddl };
      if (args[0] === 'sdset') {
        restoredSddl = args[2];
        return { success: true, stdout: '' };
      }
      return { success: false, stdout: '', stderr: 'unexpected command' };
    },
  });
  check('an interrupted uninstall restores the saved DACL byte-for-byte',
    restored.ok === true
      && restoredSddl === `D:(D;;CCLCLORPWP;;;${SID})(A;;CCLCLORPWP;;;${SID})(A;;CC;;;SY)`,
    restored.reason ?? restoredSddl);
}

// ─── 3. Data directory and the protection commands ───────────────────────────

async function testDataDirCommands() {
  setGroup('3. the data directory grant and the protection commands');

  const op = await import(srcUrl('core/service/operator.js'));
  const acl = await import(srcUrl('core/service/acl.js'));
  const { SERVICE_ACCOUNT } = await import(srcUrl('core/service/winsw.js'));

  const dataDir = 'C:\\ProgramData\\easy-devops';
  const grant = op.buildDataDirGrantCommand(dataDir, SID);
  check('the grant is Modify, inherited by what the directory contains',
    JSON.stringify(grant) === JSON.stringify([dataDir, '/grant', `*${SID}:(OI)(CI)M`, '/L', '/Q']), grant);
  check('it is NOT recursive with /T, so the protected folders can opt out',
    !/\/T\b/.test(grant), grant);
  check('the SID is quoted with the * prefix, so it does not depend on the display language',
    grant.includes(`*${SID}:(OI)(CI)M`), grant);
  check('the grant names no group SID',
    FORBIDDEN_TRUSTEES.every((sid) => !grant.includes(sid)), grant);

  const dir = 'C:\\ProgramData\\easy-devops\\runtime';
  const commands = op.buildProtectCommands(dir, SID);
  check('protection resets the DACL before replacing it and removing a stale grant',
    commands.length === 4, String(commands.length));

  const [takeOwner, reset, replace, removeOperator] = commands;
  check('Administrators are made the owner FIRST, so no other account keeps the owner\'s implicit WRITE_DAC',
    aclCall(takeOwner) === `icacls "${dir}" /setowner "*S-1-5-32-544" /L /Q`, takeOwner);
  check('a per-object reset discards pre-seeded explicit allow ACEs',
    aclCall(reset) === `icacls "${dir}" /reset /L /Q`, reset);
  check('inheritance is turned off before the explicit list is written', replace.includes('/inheritance:r'), replace);
  check('and the explicit list replaces what was there', replace.includes('/grant:r'), replace);
  check('SYSTEM gets full control', replace.includes('*S-1-5-18:(OI)(CI)F'));
  check('Administrators get full control', replace.includes('*S-1-5-32-544:(OI)(CI)F'));
  check('Users get read and execute only, never Modify',
    replace.includes('*S-1-5-32-545:(OI)(CI)RX')
    && !/\*S-1-5-32-545:(OI)\(CI\)[MF]/.test(replace), replace);
  check('the service account gets read and execute only',
    replace.includes(`${SERVICE_ACCOUNT}:(OI)(CI)RX`), replace);
  check('Everyone and Authenticated Users are NOT granted anything',
    !replace.includes('S-1-1-0') && !replace.includes('S-1-5-11'), replace);
  check('the operator is not on the protected folder\'s allow list',
    !replace.includes(SID), replace);
  check('the root opts out of broad inherited access',
    replace.includes('/inheritance:r'), replace);
  check('no protection command recursively follows the filesystem',
    commands.every((command) => !command.includes('/T')), commands.map(aclCall).join(' | '));

  const childCommands = op.buildProtectCommands(path.join(dir, 'nested'), SID, {
    replaceInheritance: false,
  });
  check('a descendant is reset against its already-protected parent and keeps inheritance',
    childCommands[1].includes('/reset')
      && !childCommands[1].includes('/T')
      && childCommands[2].includes('/grant:r')
      && !childCommands[2].includes('/inheritance:r'), childCommands.map(aclCall).join(' | '));

  const dataCommands = op.buildProtectCommands(dataDir, SID, {
    serviceAccess: 'M',
    usersRead: false,
  });
  check('the data directory never grants BUILTIN\\Users read access',
    !dataCommands.some((command) => command.includes('*S-1-5-32-545')), dataCommands.join(' | '));
  check('the service account still gets Modify on the data directory',
    dataCommands[2].includes(`${SERVICE_ACCOUNT}:(OI)(CI)M`), dataCommands[2]);

  check('a stale operator entry is removed LAST, after the list is in place',
    removeOperator.includes(`/remove:g`) && removeOperator.includes(`*${SID}`), removeOperator);

  const noService = op.buildProtectCommands('C:\\x', null, { serviceAccount: false });
  check('before the service exists its account is left out of the list',
    !noService[2].includes(SERVICE_ACCOUNT), noService[2]);
  check('which otherwise still gets read and execute only',
    noService[2].includes('*S-1-5-18:(OI)(CI)F')
    && noService[2].includes('*S-1-5-32-544:(OI)(CI)F')
    && noService[2].includes('*S-1-5-32-545:(OI)(CI)RX'), noService[2]);
  check('with no account SID there is nothing to remove', noService.length === 3, String(noService.length));
  check('the default keeps the service account', op.buildProtectCommands('C:\\x')[2].includes(`${SERVICE_ACCOUNT}:(OI)(CI)RX`));
  const dataRootProtection = op.buildProtectCommands(dataDir, SID, { serviceAccess: 'M' });
  check('the data root gives the service Modify while its executable folders stay read/execute only',
    dataRootProtection[2].includes(`${SERVICE_ACCOUNT}:(OI)(CI)M`)
      && !dataRootProtection[2].includes(`${SERVICE_ACCOUNT}:(OI)(CI)RX`), dataRootProtection[2]);

  // The real Server-mode data directory and service files live below
  // ProgramData. That machine-level container remains sensitive even when the
  // test-only data-dir redirect points ProgramData somewhere disposable.
  const protectedContainer = process.platform === 'win32'
    ? 'C:\\ProgramData'
    : path.parse(TEST_DATA_DIR).root;
  let containerError = null;
  try {
    await acl.canonicalAclDirectory(protectedContainer);
  } catch (error) {
    containerError = error;
  }

  const previousProgramData = process.env.ProgramData;
  const programData = scratch('acl-approved-programdata');
  const approvedDataDir = path.join(programData, 'easy-devops');
  const approvedBin = path.join(approvedDataDir, 'bin');
  fs.mkdirSync(approvedBin, { recursive: true });
  process.env.ProgramData = programData;
  try {
    let approvedError = null;
    let approvedPath = null;
    try {
      approvedPath = await acl.canonicalAclDirectory(approvedBin);
    } catch (error) {
      approvedError = error;
    }
    check('the ProgramData container itself is refused',
      /refusing a system directory/.test(containerError?.message ?? ''), containerError?.message);
    check('the approved Easy DevOps subtree below ProgramData remains usable',
      approvedError === null && approvedPath === approvedBin, approvedError?.message);

    const calls = [];
    const result = await acl.applyGrants({
      grants: [{ path: approvedDataDir, access: acl.ACCESS.MODIFY }],
      approvedDirs: [approvedDataDir],
      runFile: async (file, args) => {
        calls.push({ file, args });
        return /powershell\.exe$/i.test(file)
          ? { success: true, stdout: '', stderr: '' }
          : { success: true, stdout: 'Successfully processed 1 files', stderr: '' };
      },
      log: () => {},
    });
    const icaclsCall = calls.find((entry) => /icacls\.exe$/i.test(entry.file));
    check('the documented ProgramData data directory can receive the service grant',
      result.ok === true
        && icaclsCall
        && icaclsCall.args[0] === approvedDataDir
        && icaclsCall.args.includes(`${SERVICE_ACCOUNT}:(OI)(CI)M`),
      JSON.stringify({ result, calls }));
  } finally {
    if (previousProgramData === undefined) delete process.env.ProgramData;
    else process.env.ProgramData = previousProgramData;
  }

  // A hard link is a second name for the same security descriptor. A
  // recursive ACL reset on the approved tree would therefore change the file
  // outside it.
  const hardLinkRoot = scratch('acl-hard-link');
  const outside = path.join(TEST_DATA_DIR, 'acl-hard-link-outside');
  const inside = path.join(hardLinkRoot, 'inside.txt');
  fs.mkdirSync(hardLinkRoot, { recursive: true });
  fs.writeFileSync(outside, 'must stay outside the ACL tree');
  fs.linkSync(outside, inside);
  let hardLinkError = null;
  const hardLinkRun = stubRun([[/powershell\.exe$/i, { success: true, stdout: '' }]]);
  const hardLinkVisits = [];
  try {
    await acl.walkAclTree(hardLinkRoot, async (target, kind) => {
      hardLinkVisits.push({ target, kind });
    }, { runFile: withFileStub({ run: hardLinkRun }).runFile });
  } catch (error) {
    hardLinkError = error;
  }
  check('ACL traversal refuses a hard-linked file inside the tree',
    /hard-linked file/i.test(hardLinkError?.message ?? ''), hardLinkError?.message ?? 'not refused');
  check('the root is locked before its children are enumerated',
    hardLinkVisits.length === 1
      && hardLinkVisits[0].target === hardLinkRoot
      && hardLinkVisits[0].kind === 'directory',
    JSON.stringify(hardLinkVisits));
  check('the hard-linked file never receives its own ACL command',
    !hardLinkRun.calls.some((call) => call.includes('inside.txt')),
    hardLinkRun.calls.join(' | '));

  // ── A path that cannot sit inside double quotes is refused, never escaped ─
  const refused = (fn) => {
    try { fn(); return null; } catch (err) { return err; }
  };
  for (const [label, bad] of [
    ['a double quote', 'C:\\ProgramData\\ev"il'],
    ['a CR', 'C:\\ProgramData\\ev\ril'],
    ['a LF', 'C:\\ProgramData\\ev\nil'],
  ]) {
    const errs = [
      refused(() => op.buildProtectCommands(bad, SID)),
      refused(() => op.buildDataDirGrantCommand(bad, SID)),
    ];
    check(`every builder refuses a path containing ${label}`,
      errs.every((err) => err !== null && /refusing an unusual path/.test(err.message)),
      errs.map((err) => err?.message).join(' | '));
  }
  for (const [label, literal] of [
    ['a backtick', 'C:\\ProgramData\\sub`calc`'],
    ['a dollar sign', 'C:\\ProgramData\\$env:USERPROFILE'],
  ]) {
    const protect = op.buildProtectCommands(literal, SID);
    const grant = op.buildDataDirGrantCommand(literal, SID);
    check(`${label} remains one literal argv value`,
      protect.every((args) => args[0] === literal) && grant[0] === literal,
      JSON.stringify({ protect, grant }));
  }
  check('a group SID is refused by the data-directory builders too',
    refused(() => op.buildDataDirGrantCommand(dataDir, 'S-1-5-32-545')) !== null);

  // Granting the operator must never grant these anywhere.
  const operatorCommands = [
    grant,
    op.withOperatorAce(SERVICE_SDDL, SID),
  ];
  check('no operator-facing command names Everyone, Users or Authenticated Users',
    operatorCommands.every((cmd) => FORBIDDEN_TRUSTEES.every((sid) => !cmd.includes(sid))),
    operatorCommands.join(' | '));
}

// ─── 4. protectServiceFiles ─────────────────────────────────────────────────

async function testProtectServiceFiles() {
  setGroup('4. protectServiceFiles is per directory and stops on failure');

  const op = await import(srcUrl('core/service/operator.js'));

  const root = scratch('protect');
  const bin = path.join(root, 'bin');
  const runtime = path.join(root, 'runtime');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(runtime, { recursive: true });

  const run = stubRun([[/icacls /, { success: true, stdout: 'Successfully processed 1 files' }]]);
  const logs = [];
  const done = await op.protectServiceFiles(withFileStub({
    dirs: [bin, runtime], sid: SID, run, log: (line) => logs.push(line),
  }));

  check('both directories are protected', done.ok === true && done.protected.length === 2,
    JSON.stringify(done.protected));
  check('each directory runs the owner, reset, list, then removal, in that order',
    JSON.stringify(run.calls) === JSON.stringify([
      ...op.buildProtectCommands(bin, SID).map(aclCall), ...op.buildProtectCommands(runtime, SID).map(aclCall),
    ]), run.calls.join(' | '));
  check('the owner is set before the reset, list and removal',
    run.calls.length === 8 && run.calls[0].includes(`/setowner`) && run.calls[0].includes(bin)
    && run.calls[1].includes('/reset') && run.calls[2].includes('/inheritance:r')
    && run.calls[3].includes('/remove:g') && run.calls[4].includes(`/setowner`)
    && run.calls[4].includes(runtime), run.calls.join(' | '));
  check('a pre-seeded explicit Everyone ACE cannot survive the reset',
    run.calls[1] === aclCall(op.buildProtectCommands(bin, SID)[1])
      && !run.calls[2].includes('S-1-1-0'), run.calls.slice(1, 3).join(' | '));
  check('the operator grant is never a write grant on the protected folders',
    !run.calls.some((c) => c.includes(`/grant "*${SID}:`)), run.calls.join(' | '));
  check('it says what was done', logs.some((l) => /administrators only/.test(l)), logs.join(' | '));

  // Shell metacharacters are literal bytes in a direct argv. They must not be
  // concatenated into a PowerShell or cmd.exe command line.
  const oddDir = path.join(root, 'odd$dir');
  fs.mkdirSync(oddDir, { recursive: true });
  const oddCalls = [];
  let oddThrew = null;
  let oddResult = null;
  try {
    oddResult = await op.protectServiceFiles({
      dirs: [oddDir, bin],
      sid: SID,
      runFile: async (file, args) => {
        oddCalls.push({ file, args });
        return { success: true, stdout: 'Successfully processed 1 files', stderr: '' };
      },
      log: () => {},
    });
  } catch (err) { oddThrew = err; }
  check('a directory containing a dollar sign is protected without throwing', oddThrew === null,
    oddThrew?.message);
  check('both folders are protected', oddResult?.ok === true
    && oddResult.protected.includes(oddDir) && oddResult.protected.includes(bin),
    JSON.stringify(oddResult?.protected));
  const oddAclCalls = oddCalls.filter((entry) => /icacls\.exe$/i.test(entry.file));
  check('icacls receives the dollar-sign path as one direct argv value',
    oddAclCalls.length > 0
      && oddAclCalls.every((entry, index) => entry.args[0] === (index < 4 ? oddDir : bin)),
    JSON.stringify(oddAclCalls));

  const missing = path.join(root, 'not-created');
  const skipRun = stubRun([[/icacls /, { success: true }]]);
  const skipped = await op.protectServiceFiles(withFileStub({ dirs: [missing], sid: SID, run: skipRun }));
  check('a directory that does not exist yet is skipped, not created',
    skipped.ok === false && skipped.protected.length === 0 && !fs.existsSync(missing));
  check('and nothing was run for it', skipRun.calls.length === 0);

  const deniedRun = stubRun([[/icacls /, { success: false, stderr: 'Access is denied.' }]]);
  const denied = await op.protectServiceFiles(withFileStub({
    dirs: [bin, runtime],
    sid: SID,
    run: deniedRun,
    log: () => {},
  }));
  check('a refusal is reported as a failure, not swallowed', denied.ok === false);
  check('with the path and the reason', denied.failed.length === 2
    && denied.failed.every((f) => f.reason.includes('Access is denied')), JSON.stringify(denied.failed));
  check('and later DACL steps for a failed directory are not attempted',
    deniedRun.calls.length === 2
      && !deniedRun.calls.some((c) => c.includes('/reset') || c.includes('/remove:g')),
    deniedRun.calls.join(' | '));
}

// ─── 5. grantServiceControl: sdshow, sdset, sdshow ───────────────────────────

async function testGrantServiceControl() {
  setGroup('5. grantServiceControl writes the ACE and reads it back');

  const op = await import(srcUrl('core/service/operator.js'));

  const expected = `${SERVICE_SDDL}${OPERATOR_ACE}`;
  const state = { gave: false };
  const run = stubRun([
    [/^sc\.exe sdshow /, () => ({ stdout: state.gave ? expected : SERVICE_SDDL })],
    [/^sc\.exe sdset /, () => { state.gave = true; return { success: true, stdout: '[SC] ChangeServiceConfig2 SUCCESS' }; }],
  ]);

  const granted = await op.grantServiceControl(withFileStub({ sid: SID, run }));
  check('the grant succeeds', granted.ok === true, granted.reason ?? '');
  check('the sequence is sdshow, sdset, sdshow',
    run.calls.map((c) => c.split(' ')[1]).join(',') === 'sdshow,sdset,sdshow',
    run.calls.map((c) => c.split(' ')[1]).join(','));
  check('the DACL that is written is the old one plus one operator ACE',
    run.calls[1] === `sc.exe sdset EasyDevOps "${expected}"`, run.calls[1]);
  check('nothing else is in the written DACL',
    !FORBIDDEN_TRUSTEES.some((sid) => run.calls[1].includes(sid)), run.calls[1]);

  const noSid = stubRun();
  const refusedNoSid = await op.grantServiceControl(withFileStub({ sid: 'S-1-5-32-545', run: noSid }));
  check('no account SID means no grant, and no command at all',
    refusedNoSid.ok === false && noSid.calls.length === 0, refusedNoSid.reason);

  const unreadable = stubRun([[/^sc\.exe sdshow /, { success: false, stderr: 'Access is denied.' }]]);
  const refusedRead = await op.grantServiceControl(withFileStub({ sid: SID, run: unreadable }));
  check('an unreadable DACL is refused, not guessed at', refusedRead.ok === false);
  check('and it names the service permissions',
    /service permissions/.test(refusedRead.reason ?? ''), refusedRead.reason);
  check('with no sdset attempted', unreadable.calls.length === 1);

  // A DACL that is not plain SDDL must never reach a shell.
  const odd = stubRun([[/^sc\.exe sdshow /, { stdout: 'D:(A;;CC;;;SY) & calc' }]]);
  const refusedOdd = await op.grantServiceControl(withFileStub({ sid: SID, run: odd }));
  check('a DACL with characters outside [A-Za-z0-9:;()-] is REFUSED', refusedOdd.ok === false);
  check('and the message says nothing was changed',
    /nothing was changed/.test(refusedOdd.reason ?? ''), refusedOdd.reason);
  check('so no sdset ran', odd.calls.length === 1, odd.calls.join(' | '));

  const failedSet = stubRun([
    [/^sc\.exe sdshow /, { stdout: SERVICE_SDDL }],
    [/^sc\.exe sdset /, { success: false, stderr: 'Access is denied.' }],
  ]);
  const refusedSet = await op.grantServiceControl(withFileStub({ sid: SID, run: failedSet }));
  check('a refused sdset is reported with its output',
    refusedSet.ok === false && /Access is denied/.test(refusedSet.reason ?? ''), refusedSet.reason);
  check('and it is not read back', failedSet.calls.length === 2);

  // A write that does not read back as granted is a failure, not a success.
  const neverLands = stubRun([
    [/^sc\.exe sdshow /, { stdout: SERVICE_SDDL }],
    [/^sc\.exe sdset /, { success: true }],
  ]);
  const refusedReadBack = await op.grantServiceControl(withFileStub({ sid: SID, run: neverLands }));
  check('a grant that does not read back is a failure',
    refusedReadBack.ok === false && /does not read back/.test(refusedReadBack.reason ?? ''),
    refusedReadBack.reason);
}

// ─── 6. grantOperator: protect first, then share the data ────────────────────

async function testGrantOperator() {
  setGroup('6. grantOperator protects first and shares the data second');

  const op = await import(srcUrl('core/service/operator.js'));

  const root = scratch('grant-operator');
  const dataDir = path.join(root, 'data');
  const bin = path.join(root, 'bin');
  const runtime = path.join(root, 'runtime');
  for (const dir of [dataDir, bin, runtime]) fs.mkdirSync(dir, { recursive: true });

  const protectCommands = [
    ...op.buildProtectCommands(dataDir, SID, { serviceAccess: 'M', usersRead: false }).map(aclCall),
    ...op.buildProtectCommands(bin, SID).map(aclCall),
    ...op.buildProtectCommands(runtime, SID).map(aclCall),
  ];
  const dataGrant = aclCall(op.buildDataDirGrantCommand(dataDir, SID));
  const expected = `${SERVICE_SDDL}${OPERATOR_ACE}`;

  const run = stubRun([
    [/^sc\.exe sdshow /, { stdout: expected }],
    [/^sc\.exe sdset /, { success: true }],
    [/icacls /, { success: true, stdout: 'Successfully processed 1 files' }],
  ]);

  const result = await op.grantOperator(withFileStub({
    operator: { sid: SID, name: 'DOMAIN\\me' },
    dataDir,
    protectedDirs: [bin, runtime],
    run,
    log: () => {},
  }));

  check('a record is produced', result.record !== null, JSON.stringify(result.record));
  check('it names the account and the SID',
    result.record.sid === SID && result.record.name === 'DOMAIN\\me');
  check('start and stop was granted', result.record.serviceControl === true);
  check('and the data directory too', result.record.dataDir === true);
  check('the record is stamped, so status can report when', typeof result.record.grantedAt === 'string');
  check('protection reports the data root and both executable folders',
    result.protection.ok === true && result.protection.protected.length === 3);

  const grantIndexes = protectCommands
    .map((cmd) => run.calls.indexOf(cmd))
    .filter((index) => index !== -1);
  const dataIndex = run.calls.indexOf(dataGrant);
  const sdsetIndex = run.calls.findIndex((c) => /^sc\.exe sdset /.test(c));
  check('every expected data-root and executable-folder protection command ran',
    grantIndexes.length === protectCommands.length,
    JSON.stringify({ expected: protectCommands.length, found: grantIndexes, calls: run.calls }));
  check('the data grant ran after them',
    dataIndex !== -1 && Math.max(...grantIndexes) < dataIndex,
    `protect ${JSON.stringify(grantIndexes)}, data ${dataIndex}`);
  check('the service ACE was written once, after the files were protected',
    sdsetIndex !== -1 && sdsetIndex > Math.max(...grantIndexes), String(sdsetIndex));
  check('the data grant carried no /T', !/\/T\b/.test(run.calls[dataIndex] ?? ''), run.calls[dataIndex]);
  check('the owner of each protected folder was Administrators before the data was shared',
    run.calls.filter((c) => c.includes('/setowner')).length === 3, run.calls.join(' | '));
  check('every protected folder was also reset before approved trustees were applied',
    run.calls.filter((c) => c.includes('/reset')).length === 3, run.calls.join(' | '));
  check('the ProgramData root is normalized before it is shared with the operator',
    grantIndexes[0] < dataIndex
      && run.calls[grantIndexes[0]].includes(dataDir)
      && run.calls[grantIndexes[0]].includes('/setowner'), run.calls.join(' | '));
  check('the service gets Modify on the data root and only read/execute on runtime and bin',
    run.calls.some((c) => c.includes(dataDir) && c.includes('NT SERVICE\\EasyDevOps:(OI)(CI)M'))
      && run.calls.some((c) => c.includes(bin) && c.includes('NT SERVICE\\EasyDevOps:(OI)(CI)RX'))
      && run.calls.some((c) => c.includes(runtime) && c.includes('NT SERVICE\\EasyDevOps:(OI)(CI)RX')),
    run.calls.join(' | '));

  const grants = run.calls.filter((c) => /\/grant/.test(c));
  check('no grant command hands anything to Everyone or Authenticated Users',
    !grants.some((c) => c.includes('S-1-1-0') || c.includes('S-1-5-11')), grants.join(' | '));
  check('Users are only ever given read and execute',
    grants.filter((c) => c.includes('S-1-5-32-545'))
      .every((c) => c.includes('*S-1-5-32-545:(OI)(CI)RX')), grants.join(' | '));

  // ── Protection failed: the data is NOT shared ────────────────────────────
  const failedRun = stubRun([
    [/^sc\.exe sdshow /, { stdout: expected }],
    [/^sc\.exe sdset /, { success: true }],
    [/inheritance:r/, { success: false, stderr: 'Access is denied.' }],
    [/icacls /, { success: true }],
  ]);
  const notShared = await op.grantOperator(withFileStub({
    operator: { sid: SID, name: 'DOMAIN\\me' },
    dataDir,
    protectedDirs: [bin, runtime],
    run: failedRun,
    log: () => {},
  }));

  check('a failed protection is reported', notShared.protection.ok === false);
  check('the data directory is NOT granted', notShared.record.dataDir === false);
  check('and no data grant command ran',
    !failedRun.calls.some((c) => c.includes(`/grant "*${SID}:(OI)(CI)M"`)), failedRun.calls.join(' | '));
  check('an earlier grant is actively REVOKED, so inheritance cannot reach an unprotected folder',
    failedRun.calls.filter((c) => c === `icacls "${dataDir}" /remove:g "*${SID}" /L /Q`).length === 1,
    failedRun.calls.join(' | '));
  check('the revoke is the last thing done to the data directory',
    failedRun.calls.indexOf(`icacls "${dataDir}" /remove:g "*${SID}" /L /Q`) > failedRun.calls.findIndex((c) => /^sc\.exe sdset /.test(c)),
    failedRun.calls.join(' | '));
  check('the revocation never uses recursive icacls',
    !failedRun.calls.some((c) => /\/remove:g/.test(c) && /\/T\b/.test(c)),
    failedRun.calls.filter((c) => /\/remove:g/.test(c)).join(' | '));
  check('the note explains why the data was not shared and what to do',
    notShared.notes.some((n) => /could not be protected/.test(n) && /service repair/.test(n)),
    notShared.notes.join(' | '));
  check('the start/stop right is still asked for, since it is on the service DACL',
    failedRun.calls.some((c) => /^sc\.exe sdset /.test(c)));

  // ── Data grant failed after protection ──────────────────────────────────
  const deniedData = await op.grantOperator(withFileStub({
    operator: { sid: SID, name: null },
    dataDir,
    protectedDirs: [bin],
    run: stubRun([
      [/^sc\.exe sdshow /, { stdout: expected }],
      [/^sc\.exe sdset /, { success: true }],
      [/\/grant "\*/i, { success: false, stderr: 'Access is denied.' }],
      [/icacls /, { success: true }],
    ]),
    log: () => {},
  }));
  check('a refused data grant leaves dataDir false', deniedData.record.dataDir === false);
  check('and is noted rather than thrown',
    deniedData.notes.some((n) => /data directory access was not granted/.test(n)),
    deniedData.notes.join(' | '));

  // ── Nobody identified ───────────────────────────────────────────────────
  const noOperator = await op.grantOperator(withFileStub({
    operator: null,
    dataDir,
    protectedDirs: [bin],
    run: stubRun([[/icacls /, { success: true }]]),
    log: () => {},
  }));
  check('with no operator there is no record', noOperator.record === null);
  check('the files are still protected with no operator entry to remove',
    noOperator.protection.ok === true);
  check('and the note says why nobody was granted',
    noOperator.notes.some((n) => /could not tell which account/.test(n)), noOperator.notes.join(' | '));

  const groupOperator = await op.grantOperator(withFileStub({
    operator: { sid: 'S-1-5-32-545', name: 'Users' },
    dataDir,
    protectedDirs: [bin],
    run: stubRun([[/icacls /, { success: true }]]),
    log: () => {},
  }));
  check('a group as operator is refused outright', groupOperator.record === null);

  // ── Revocation ──────────────────────────────────────────────────────────
  const revokeRun = stubRun([[/icacls /, { success: true }]]);
  const revoked = await op.revokeOperator(withFileStub({ operator: { sid: SID }, dataDir, run: revokeRun, log: () => {} }));
  check('revocation succeeds', revoked.ok === true);
  check('and runs a direct-argument removal for that SID on every object',
    revokeRun.calls.length >= 1
      && revokeRun.calls.every((c) => c
        === `icacls "${dataDir}" /remove:g "*${SID}" /L /Q`
        || (c.startsWith(`icacls "${dataDir}\\`) && c.includes(`/remove:g "*${SID}" /L /Q`))),
    revokeRun.calls.join(' | '));
  check('the data root itself receives the removal without a recursive /T',
    revokeRun.calls.filter((c) =>
      c === `icacls "${dataDir}" /remove:g "*${SID}" /L /Q`).length === 1
      && !revokeRun.calls.some((c) => /\/remove:g/.test(c) && /\/T\b/.test(c)),
    revokeRun.calls.join(' | '));

  const restoreRun = stubRun([[/icacls /, { success: true }]]);
  const restored = await op.restoreOperatorDataAccess(withFileStub({
    operator: { sid: SID, name: 'DOMAIN\\me' },
    dataDir,
    run: restoreRun,
    log: () => {},
  }));
  check('keeping Server data restores only the inheritable root grant',
    restored.ok === true
      && restoreRun.calls.length === 1
      && restoreRun.calls[0] === `icacls "${dataDir}" /grant "*${SID}:(OI)(CI)M" /L /Q`,
    restoreRun.calls.join(' | '));

  const nothingToRevoke = stubRun();
  check('no operator is a no-op',
    (await op.revokeOperator(withFileStub({ operator: null, dataDir, run: nothingToRevoke }))).ok === true
    && nothingToRevoke.calls.length === 0);
  check('a directory that does not exist is a no-op',
    (await op.revokeOperator(withFileStub({
      operator: { sid: SID }, dataDir: path.join(root, 'gone'), run: nothingToRevoke,
    }))).ok === true && nothingToRevoke.calls.length === 0);

  const revokeDenied = await op.revokeOperator(withFileStub({
    operator: { sid: SID }, dataDir, run: stubRun([[/icacls /, { success: false, stderr: 'Access is denied.' }]]),
    log: () => {},
  }));
  check('a refused revocation is reported', revokeDenied.ok === false && /Access is denied/.test(revokeDenied.reason));

  // A shell metacharacter is ordinary data when icacls receives a direct argv.
  const oddData = path.join(root, 'data$dir');
  fs.mkdirSync(oddData, { recursive: true });

  let grantThrew = null;
  let oddGrant = null;
  try {
    oddGrant = await op.grantOperator(withFileStub({
      operator: { sid: SID, name: 'DOMAIN\\me' },
      dataDir: oddData,
      protectedDirs: [],
      run: stubRun([
        [/^sc\.exe sdshow /, { stdout: expected }],
        [/^sc\.exe sdset /, { success: true }],
        [/icacls /, { success: true }],
      ]),
      log: () => {},
    }));
  } catch (err) { grantThrew = err; }
  check('a data directory containing a dollar sign is handled as an argument', grantThrew === null, grantThrew?.message);
  check('and receives the approved data access', oddGrant?.record?.dataDir === true);

  let revokeThrew = null;
  let oddRevoke = null;
  const oddRun = stubRun([[/icacls /, { success: true }]]);
  try {
    oddRevoke = await op.revokeOperator(withFileStub({ operator: { sid: SID }, dataDir: oddData, run: oddRun, log: () => {} }));
  } catch (err) { revokeThrew = err; }
  check('revocation handles the same literal path without throwing', revokeThrew === null, revokeThrew?.message);
  check('and succeeds without shell evaluation', oddRevoke?.ok === true, oddRevoke?.reason);
  check('the dollar sign remains ordinary argument data',
    oddRun.calls.length === 1
      && oddRun.calls[0] === `icacls "${oddData}" /remove:g "*${SID}" /L /Q`,
    oddRun.calls.join(' | '));
}

// ─── 7. The elevated relaunch command ───────────────────────────────────────

/** The PowerShell script inside the -EncodedCommand, decoded. */
function decodeRelaunch(command) {
  const base64 = /-EncodedCommand','([A-Za-z0-9+/=]+)'/.exec(command)?.[1];
  if (!base64) return null;
  return Buffer.from(base64, 'base64').toString('utf16le');
}

async function testRelaunchCommand() {
  setGroup('7. the elevated relaunch is one base64 script, no re-parsing');

  const platform = await import(srcUrl('core/platform.js'));

  const command = platform.windowsElevatedRelaunchCmd({
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    script: 'C:\\npm\\node_modules\\easy-devops\\src\\cli\\index.js',
    args: ['service', 'install'],
    cwd: 'C:\\O\'Brien\\easy devops',
    env: { EZ_OPERATOR_SID: SID },
  });

  check('it starts the fixed system PowerShell executable',
    /Start-Process -FilePath 'C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe'/.test(command));
  check('with Verb RunAs, which is the only way to elevate', /-Verb RunAs/.test(command));
  check('and stays open so the result can be read', /-NoExit/.test(command));
  check('nothing is passed as an argument that a shell would parse again',
    !command.includes('node.exe') && !command.includes('O\'Brien'), command.slice(0, 160));
  check('it reports success with a word the caller can look for', /'relaunched'/.test(command));
  check('and reports a failure it can print', /relaunch-failed:/.test(command));

  const script = decodeRelaunch(command);
  check('the encoded script decodes as UTF-16LE', typeof script === 'string' && script.length > 0);

  const unpack = script => JSON.parse(Buffer.from(script.match(/FromBase64String\('([^']+)'\)/)[1], 'base64').toString());
  const payload = unpack(script);
  check('the caller working directory is not used in the elevated process',
    payload.cwd === undefined && !script.includes('Set-Location -LiteralPath $p.cwd'));
  check('node and cli arguments are passed as separate values', payload.execPath.endsWith('node.exe') && payload.script.endsWith('index.js') && payload.args.join(' ') === 'service install' && script.includes('& $p.execPath @cliArgs'));
  check('the elevated copy receives the operator SID', payload.sid === SID);
  check('the window stays open', /stays open/.test(script));
  check('the elevated process replaces caller-controlled machine paths',
    /ProgramData = \[Environment\]::GetFolderPath/.test(script)
      && /SystemRoot = \[Environment\]::GetFolderPath/.test(script)
      && /\$env:Path = \[Environment\]::GetEnvironmentVariable\('Path', 'Machine'\)/.test(script)
      && /\$env:TEMP = \[Environment\]::GetEnvironmentVariable\('TEMP', 'Machine'\)/.test(script),
    script);
  check('the elevated process starts from a clean environment',
    /Get-ChildItem Env: \| Remove-Item/.test(script)
      && !/process\.env/i.test(script),
    script);
  check('the elevated process uses the protected Windows directory as its cwd',
    /Set-Location -LiteralPath \$env:SystemRoot -ErrorAction Stop/.test(script)
      && !/Set-Location[^\n]*\$p\.cwd/.test(script),
    script);
  check('the Node path is canonicalized and must still be a file',
    /\$nodeItem = Get-Item -LiteralPath \$p\.execPath/.test(script)
      && /if \(\$nodeItem\.PSIsContainer\)/.test(script)
      && /\$p\.execPath = \$nodeItem\.FullName/.test(script),
    script);
  check('the selected Node executable must have a valid Authenticode signature',
    /Get-AuthenticodeSignature -FilePath \$p\.execPath/.test(script)
      && /\.Status -ne 'Valid'/.test(script)
      && /&\s+\$p\.execPath @cliArgs/.test(script),
    script);
  const noEnv = unpack(decodeRelaunch(platform.windowsElevatedRelaunchCmd({execPath: 'node', script: 'cli.js', args: [], cwd: '/tmp', env: {}})));
  check('no SID is passed without an operator', noEnv.sid === undefined);

  // Refusals: this string reaches a shell as base64, but its CONTENTS must not
  // become a way to smuggle another command into an elevated process.
  const thrower = (opts) => {
    try { platform.windowsElevatedRelaunchCmd(opts); return null; } catch (err) { return err; }
  };
  const base = { execPath: 'node', script: 'cli.js', args: [], cwd: '/tmp' };

  check('an environment name that is not EZ_* is refused',
    /refusing to pass/.test(thrower({ ...base, env: { PATH: 'C:\\x' } })?.message ?? ''));
  check('a lowercase EZ name is refused',
    thrower({ ...base, env: { ez_operator_sid: SID } }) !== null);
  check('a value with a space is refused',
    thrower({ ...base, env: { EZ_OPERATOR_SID: 'S-1-5-21-1-2-3-4; calc' } }) !== null);
  check('a value with a single quote is refused',
    thrower({ ...base, env: { EZ_OPERATOR_SID: "S-1-5-21-1-2-3-4'" } }) !== null);
  check('the SID shape is what is allowed through',
    thrower({ ...base, env: { EZ_OPERATOR_SID: SID } }) === null);

  const acl = await import(srcUrl('core/service/acl.js'));
  const previousProgramData = process.env.ProgramData;
  const previousSystemRoot = process.env.SystemRoot;
  process.env.ProgramData = 'C:\\caller-controlled-program-data';
  process.env.SystemRoot = 'C:\\caller-controlled-windows';
  try {
    check('a hostile ProgramData environment cannot move the machine data root',
      platform.programDataDir() === 'C:\\ProgramData\\easy-devops', platform.programDataDir());
    check('a hostile SystemRoot environment cannot select a different icacls.exe',
      acl.systemTool('icacls.exe') === 'C:\\Windows\\System32\\icacls.exe',
      acl.systemTool('icacls.exe'));
  } finally {
    if (previousProgramData === undefined) delete process.env.ProgramData;
    else process.env.ProgramData = previousProgramData;
    if (previousSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = previousSystemRoot;
  }
}

// ─── 8. requireElevation: no prompt, no relaunch, nothing run ───────────────

async function testRequireElevation() {
  setGroup('8. requireElevation hands off, or refuses and changes nothing');

  const elevation = await import(srcUrl('cli/elevation.js'));

  let elevatedAsked = 0;
  const notWindows = await elevation.requireElevation({
    args: ['update'],
    deps: {
      isWindows: false,
      isElevated: async () => { elevatedAsked++; return false; },
      isInteractive: () => { throw new Error('must not be asked off Windows'); },
      run: () => { throw new Error('must not run anything off Windows'); },
    },
  });
  check('off Windows the command simply proceeds', notWindows.proceed === true);
  check('and elevation is never asked', elevatedAsked === 0);

  const isElevated = await elevation.requireElevation({
    args: ['update'],
    deps: { isWindows: true, isElevated: async () => true, isInteractive: () => { throw new Error('not asked'); } },
  });
  check('when already elevated the command proceeds', isElevated.proceed === true);

  const unknown = await elevation.requireElevation({
    args: ['update'],
    deps: {
      isWindows: true,
      isElevated: async () => null,
      isInteractive: () => false,
      prompt: () => { throw new Error('a failed elevation check must not prompt'); },
    },
  });
  check('unknown elevation is refused without relaunching or changing anything',
    unknown.proceed === false && unknown.code === 3, JSON.stringify(unknown));

  // ── No terminal: print the command, run nothing ─────────────────────────
  const scriptedRun = stubRun();
  const scripted = await elevation.requireElevation({
    args: ['service', 'install'],
    what: 'Installing the service',
    deps: {
      isWindows: true,
      isElevated: async () => false,
      isInteractive: () => false,
      prompt: () => { throw new Error('a non-interactive run must not prompt'); },
      run: scriptedRun,
      currentUser: () => { throw new Error('nothing is relaunched, so nobody needs identifying'); },
    },
  });
  check('a non-interactive run is refused with exit code 3',
    scripted.proceed === false && scripted.code === 3, JSON.stringify(scripted));
  check('and NO relaunch command is run', scriptedRun.calls.length === 0, scriptedRun.calls.join(' | '));

  // ── Declined prompt: same answer ────────────────────────────────────────
  const declinedRun = stubRun();
  let prompted = 0;
  const declined = await elevation.requireElevation({
    args: ['update'],
    deps: {
      isWindows: true,
      isElevated: async () => false,
      isInteractive: () => true,
      prompt: async () => { prompted++; return { relaunch: false }; },
      run: declinedRun,
    },
  });
  check('the prompt is actually asked when there is a terminal', prompted === 1);
  check('declining is exit code 3', declined.proceed === false && declined.code === 3);
  check('and nothing is run', declinedRun.calls.length === 0, declinedRun.calls.join(' | '));

  // ── Accepted: the stub is what runs, and only once ──────────────────────
  const acceptedRun = stubRun([[/Start-Process/, { success: true, stdout: 'relaunched' }]]);
  let acceptedExecutable = null;
  const accepted = await elevation.requireElevation({
    args: ['service', 'install'],
    what: 'Installing the service',
    deps: {
      isWindows: true,
      isElevated: async () => false,
      isInteractive: () => true,
      prompt: async () => ({ relaunch: true }),
      currentUser: async () => ({ sid: SID, name: 'DOMAIN\\me' }),
      runFile: (exe, args) => {
        acceptedExecutable = exe;
        return acceptedRun(args.at(-1));
      },
      argv1: 'C:\\pkg\\src\\cli\\index.js',
    },
  });
  check('an accepted relaunch is a clean hand-off (exit code 0)',
    accepted.proceed === false && accepted.code === 0, JSON.stringify(accepted));
  check('exactly one command runs, and it is the stub\'s', acceptedRun.calls.length === 1,
    String(acceptedRun.calls.length));
  check('the outer elevation helper itself is the fixed system PowerShell',
    acceptedExecutable === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    acceptedExecutable);
  const acceptedScript = decodeRelaunch(acceptedRun.calls[0] ?? '');
  check('the command is the elevated relaunch of this same CLI command',
    /Start-Process/.test(acceptedRun.calls[0] ?? '') && acceptedScript !== null);
  check('with the arguments that were asked for',
    JSON.parse(Buffer.from(acceptedScript.match(/FromBase64String\('([^']+)'\)/)[1], 'base64')).args.join(' ') === 'service install', acceptedScript?.split('\n')[2]);
  check('and the SID of the account that asked, so the elevated copy grants them',
    JSON.parse(Buffer.from(acceptedScript.match(/FromBase64String\('([^']+)'\)/)[1], 'base64')).sid === SID, acceptedScript?.split('\n')[0]);

  // ── Accepted with --yes: no question is asked ───────────────────────────
  let promptWithYes = 0;
  const yes = await elevation.requireElevation({
    args: ['update', '--yes'],
    yes: true,
    deps: {
      isWindows: true,
      isElevated: async () => false,
      isInteractive: () => true,
      prompt: async () => { promptWithYes++; return { relaunch: false }; },
      currentUser: async () => ({ sid: SID, name: null }),
      runFile: async () => ({ success: true, stdout: 'relaunched' }),
      argv1: 'cli.js',
    },
  });
  check('--yes relaunches without prompting', promptWithYes === 0 && yes.code === 0);

  // ── UAC cancelled in the elevated window ────────────────────────────────
  const cancelled = await elevation.requireElevation({
    args: ['update'],
    deps: {
      isWindows: true,
      isElevated: async () => false,
      isInteractive: () => true,
      prompt: async () => ({ relaunch: true }),
      currentUser: async () => ({ sid: SID, name: null }),
      runFile: (_exe, args) => stubRun([[
        /Start-Process/,
        { success: false, stdout: 'relaunch-failed: The operation was canceled by the user.' },
      ]])(args.at(-1)),
      argv1: 'cli.js',
    },
  });
  check('a cancelled UAC prompt is exit code 3',
    cancelled.proceed === false && cancelled.code === 3, JSON.stringify(cancelled));

  // ── offerRelaunchFor: only for a result that says it was refused ────────
  const offerRun = stubRun([[/Start-Process/, { success: true, stdout: 'relaunched' }]]);
  const offerDeps = {
    isWindows: true,
    isElevated: async () => false,
    isInteractive: () => true,
    prompt: async () => ({ relaunch: true }),
    currentUser: async () => ({ sid: SID, name: null }),
    runFile: (_exe, args) => offerRun(args.at(-1)),
    argv1: 'cli.js',
  };

  check('off Windows a refusal is not handled here',
    (await elevation.offerRelaunchFor({ needsElevation: true }, ['service', 'start'],
      { deps: { isWindows: false } })) === null);
  check('a result that did not ask for elevation is left alone',
    (await elevation.offerRelaunchFor({ ok: true }, ['service', 'start'], { deps: offerDeps })) === null
    && offerRun.calls.length === 0);

  const offered = await elevation.offerRelaunchFor({ needsElevation: true }, ['service', 'start'],
    { deps: offerDeps });
  check('a refusal that needs elevation hands off and returns 0', offered === 0, String(offered));
  check('through the stub, exactly once', offerRun.calls.length === 1);

  const offerScripted = stubRun();
  const offeredNoTty = await elevation.offerRelaunchFor({ needsElevation: true }, ['service', 'stop'], {
    deps: { ...offerDeps, isInteractive: () => false, run: offerScripted },
  });
  check('with no terminal it returns 3 and runs nothing',
    offeredNoTty === 3 && offerScripted.calls.length === 0);

  check('the exit code the CLI uses is published', elevation.NEEDS_ELEVATION_EXIT === 3);
}

// ─── 9. updater: elevation is checked before anything is stopped ────────────

async function testUpdaterElevation() {
  setGroup('9. an update without elevation stops nothing');

  const updater = await import(srcUrl('core/updater.js'));
  const platform = await import(srcUrl('core/platform.js'));

  const NPM_SOURCE = {
    kind: 'npm',
    root: path.join('C:', 'npm', 'node_modules', 'easy-devops'),
    npmUpdatable: true,
    reason: 'an npm-installed package',
    howToUpdate: [],
  };

  function serviceStub({ mode = 'personal', stopOk = true } = {}) {
    const calls = [];
    return {
      calls,
      async status() { calls.push('status'); return { service: { installed: true }, mode }; },
      async stop() { calls.push('stop'); return stopOk ? { ok: true } : { ok: false, reason: 'could not stop' }; },
      async start() { calls.push('start'); return { ok: true }; },
      async waitForDaemon() { calls.push('wait'); return { alive: true, waitedMs: 100 }; },
    };
  }

  const deps = (service, isElevated, run) => ({
    runFile: run,
    service,
    detectInstallSource: () => NPM_SOURCE,
    currentVersion: () => '1.4.2',
    isElevated,
    copyRuntime: () => ({ ok: true }),
    inspectLock: () => ({ lock: { version: '9.9.9' } }),
  });

  if (!platform.isWindows) {
    // The gate is `isWindows && serverMode` in core/updater.js: a Windows Server
    // install runs from a copy under ProgramData, and that is the part only an
    // administrator may replace. There is no way to exercise it off Windows.
    for (const label of [
      'the update refuses at the elevation step',
      'it reports needsElevation and that nothing was touched',
      'it names `ezz update` in an Administrator terminal',
      'the service was never stopped',
      'no npm command was run',
      'with elevation the gate does not fire',
    ]) {
      check(label, true, 'skipped: Windows only');
    }
    return;
  }

  const run = stubRun([[/npm install/, { success: true, stdout: 'installed' }]]);
  const service = serviceStub({ mode: 'server' });

  const refused = await updater.performUpdate({
    version: '9.9.9',
    dataDir: scratch('upd-elevation'),
    deps: deps(service, async () => false, run),
  });

  check('the update refuses at the elevation step',
    refused.ok === false && refused.step === 'elevation', refused.step);
  check('it reports needsElevation and that nothing was touched',
    refused.needsElevation === true && refused.untouched === true);
  check('it names `ezz update` in an Administrator terminal',
    refused.command === 'ezz update' && /Run as administrator/.test(refused.reason ?? ''),
    refused.command);
  check('the service was never stopped', !service.calls.includes('stop'), service.calls.join(' -> '));
  check('no npm command was run', run.calls.length === 0, run.calls.join(' | '));
  check('the status was read, so the mode was known before deciding', service.calls.includes('status'));

  // The gate is exactly `elevated === false`: when it is true the update goes
  // on to the stop (which is stubbed to fail, so nothing else happens).
  const stopping = serviceStub({ mode: 'server', stopOk: false });
  const proceeded = await updater.performUpdate({
    version: '9.9.9',
    dataDir: scratch('upd-elevation-ok'),
    deps: deps(stopping, async () => true, stubRun()),
  });
  check('with elevation the gate does not fire',
    proceeded.step === 'stop' && stopping.calls.includes('stop'), proceeded.step);
}

// ─── 10. The dashboard's update endpoints ───────────────────────────────────

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}
const makeReq = (body = {}) => ({ body, socket: { localPort: 6443 } });

async function testUpdateController() {
  setGroup('10. the dashboard says elevation is required, and starts nothing');

  const { default: UpdateController } = await import(srcUrl('dashboard/controllers/updateController.js'));
  const dataDir = scratch('update-controller');

  const NPM_SOURCE = {
    kind: 'npm',
    root: '/usr/lib/node_modules/easy-devops',
    npmUpdatable: true,
    reason: 'an npm-installed package',
    howToUpdate: [],
  };

  function controller(elevationRequired) {
    const calls = { spawns: 0, writes: 0 };
    const instance = new UpdateController({
      getDataDir: () => dataDir,
      currentVersion: () => '1.4.2',
      detectInstallSource: () => NPM_SOURCE,
      checkForUpdate: async () => ({
        reachable: true, current: '1.4.2', latest: '9.9.9', updateAvailable: true,
      }),
      readStatus: () => null,
      writeStatus: () => { calls.writes++; return { id: 'run', phase: 'starting' }; },
      spawnWorker: () => { calls.spawns++; return { pid: 4242 }; },
      runId: () => 'run-1',
      now: () => 1,
      elevationRequired,
    });
    return { instance, calls };
  }

  const required = controller(async () => true);

  const getRequired = makeRes();
  await required.instance.check(makeReq(), getRequired);
  check('GET reports elevation required',
    getRequired.statusCode === 200 && getRequired.body.elevation?.required === true,
    JSON.stringify(getRequired.body.elevation));
  check('with the exact command and shell the operator must use',
    getRequired.body.elevation.command === 'ezz update'
    && getRequired.body.elevation.shell === 'Administrator PowerShell',
    JSON.stringify(getRequired.body.elevation));
  check('and the rest of the answer is still there',
    getRequired.body.current === '1.4.2' && getRequired.body.latest === '9.9.9');

  const postRequired = makeRes();
  await required.instance.start(makeReq({ version: '9.9.9' }), postRequired);
  check('POST answers 403 elevation_required',
    postRequired.statusCode === 403 && postRequired.body.error === 'elevation_required',
    `${postRequired.statusCode} ${postRequired.body?.error}`);
  check('with the command and shell to run',
    postRequired.body.command === 'ezz update'
    && postRequired.body.shell === 'Administrator PowerShell',
    JSON.stringify(postRequired.body));
  check('and a message that says where to run it',
    /Run as administrator/.test(postRequired.body.message ?? ''), postRequired.body.message);
  check('nothing was recorded as a run', required.calls.writes === 0, String(required.calls.writes));
  check('no worker was spawned', required.calls.spawns === 0, String(required.calls.spawns));

  const notRequired = controller(async () => false);
  const getFine = makeRes();
  await notRequired.instance.check(makeReq(), getFine);
  check('GET reports elevation not required, with no command',
    getFine.body.elevation?.required === false
    && getFine.body.elevation.command === null
    && getFine.body.elevation.shell === null,
    JSON.stringify(getFine.body.elevation));

  const postFine = makeRes();
  await notRequired.instance.start(makeReq({ version: '9.9.9' }), postFine);
  check('POST starts the worker when elevation is not required',
    postFine.statusCode === 202 && postFine.body.started === true, String(postFine.statusCode));
  check('the run is recorded and a worker spawned',
    notRequired.calls.writes === 3 && notRequired.calls.spawns === 1,
    `writes ${notRequired.calls.writes}, spawns ${notRequired.calls.spawns}`);
}

// ─── 11. windowsService.restart: sc.exe stop, then start ────────────────────

/** A stub for the SCM and the wrapper: query/stop/start/delete, mutable state. */
function scmRun({ denied = false, initial = 'RUNNING' } = {}) {
  const calls = [];
  const state = { sc: initial };
  const run = async (cmd) => {
    calls.push(cmd);
    if (/^sc\.exe query /.test(cmd)) {
      return state.sc === 'MISSING'
        ? { success: false, stdout: '', stderr: 'The specified service does not exist. (1060)' }
        : { success: true, stdout: `SERVICE_NAME: EasyDevOps\n        STATE              : 4  ${state.sc}` };
    }
    if (/^sc\.exe stop /.test(cmd)) {
      if (denied) return { success: false, stdout: '', stderr: 'Access is denied.' };
      state.sc = 'STOPPED';
      return { success: true, stdout: '' };
    }
    if (/^sc\.exe start /.test(cmd)) {
      state.sc = 'RUNNING';
      return { success: true, stdout: '' };
    }
    if (/^sc\.exe delete /.test(cmd)) {
      state.sc = 'MISSING';
      return { success: true, stdout: '' };
    }
    if (/^sc\.exe qc /.test(cmd)) return { success: true, stdout: 'START_TYPE : 2  AUTO_START' };
    if (/EasyDevOps\.exe" install$/.test(cmd)) { state.sc = 'RUNNING'; return { success: true }; }
    if (/EasyDevOps\.exe" (stop|uninstall|start)$/.test(cmd)) { return { success: true }; }
    return { success: false, stdout: '', stderr: `scmRun: no rule for: ${cmd}` };
  };
  run.calls = calls;
  run.state = state;
  return run;
}

async function testWindowsRestart() {
  setGroup('11. restart uses the Service Control Manager, not the wrapper');

  const ws = await import(srcUrl('core/service/windowsService.js'));

  const run = scmRun();
  const restarted = await ws.restart({ run, stopWaitMs: 2_000 });

  check('the restart succeeds', restarted.ok === true, restarted.reason ?? '');
  const verbs = run.calls.filter((c) => /^sc\.exe (stop|start) /.test(c)).map((c) => c.split(' ')[1]);
  check('it is sc.exe stop then sc.exe start', verbs.join(',') === 'stop,start', verbs.join(','));
  check('and the stop comes before the start',
    run.calls.findIndex((c) => c.startsWith('sc.exe stop '))
    < run.calls.findIndex((c) => c.startsWith('sc.exe start ')));
  check('it never uses the wrapper\'s restart', !run.calls.some((c) => /EasyDevOps\.exe" restart/.test(c)),
    run.calls.join(' | '));
  check('it never asks whether this process is elevated, because the SCM answers',
    !run.calls.some((c) => /IsInRole/.test(c)), run.calls.join(' | '));
  check('it waits for the service to be STOPPED, not merely accepted',
    run.calls.filter((c) => /^sc\.exe query /.test(c)).length >= 2,
    String(run.calls.filter((c) => /^sc\.exe query /.test(c)).length));

  const deniedRun = scmRun({ denied: true });
  const refused = await ws.restart({ run: deniedRun, stopWaitMs: 2_000 });
  check('Access is denied is reported as needing elevation',
    refused.ok === false && refused.needsElevation === true, refused.reason?.split('\n')[0]);
  check('and the message names `ezz service restart` in an Administrator terminal',
    /ezz service restart/.test(refused.reason ?? '') && /Run as administrator/.test(refused.reason ?? ''),
    refused.reason?.split('\n')[0]);
  check('nothing was started after a refused stop',
    !deniedRun.calls.some((c) => /^sc\.exe start /.test(c)), deniedRun.calls.join(' | '));
}

// ─── 12. windowsService.status: the DACL decides operatorControl ────────────

async function testWindowsStatusOperator() {
  setGroup('12. status reads the operator\'s control from the service DACL');

  const ws = await import(srcUrl('core/service/windowsService.js'));
  const dataDir = scratch('status-operator');

  const statusRun = (sddl) => stubRun([
    [/^sc\.exe query /, { success: true, stdout: 'SERVICE_NAME: EasyDevOps\n        STATE              : 4  RUNNING' }],
    [/^sc\.exe qc /, { success: true, stdout: 'START_TYPE : 2  AUTO_START' }],
    [/^sc\.exe sdshow /, { stdout: sddl }],
  ]);

  const grantedRun = statusRun(`D:(A;;CCLCLORPWP;;;${SID})`);
  const granted = await ws.status({ dataDir, config: {}, run: grantedRun, granted: [], operatorSid: SID });

  check('the service reads as running', granted.running === true && granted.state === 'running');
  check('the DACL is consulted for the recorded operator',
    grantedRun.calls.some((c) => c === 'sc.exe sdshow EasyDevOps'), grantedRun.calls.join(' | '));
  check('and operatorControl reports the grant',
    granted.operatorControl?.granted === true && granted.operatorControl?.excessive === false,
    JSON.stringify(granted.operatorControl));

  const excessiveRun = statusRun(`D:(A;;CCLCLORPWPGA;;;${SID})`);
  const excessive = await ws.status({ dataDir, config: {}, run: excessiveRun, granted: [], operatorSid: SID });
  check('an ACE with more than start/stop is reported as excessive',
    excessive.operatorControl?.excessive === true, JSON.stringify(excessive.operatorControl));

  const noSidRun = statusRun(`D:(A;;CCLCLORPWP;;;${SID})`);
  const noSid = await ws.status({ dataDir, config: {}, run: noSidRun, granted: [] });
  check('with no recorded operator the DACL is NOT read',
    !noSidRun.calls.some((c) => /^sc\.exe sdshow /.test(c)), noSidRun.calls.join(' | '));
  check('and operatorControl is null, never a guess', noSid.operatorControl === null);

  const unreadableRun = statusRun('SERVICE_NAME: EasyDevOps');
  const unreadable = await ws.status({ dataDir, config: {}, run: unreadableRun, granted: [], operatorSid: SID });
  check('an unreadable DACL leaves operatorControl null',
    unreadable.operatorControl === null && unreadable.installed === true,
    JSON.stringify(unreadable.operatorControl));

  const revoked = await ws.status({
    dataDir, config: {}, run: statusRun('D:(A;;CC;;;SY)'), granted: [], operatorSid: SID,
  });
  check('an operator absent from the DACL is reported as not granted',
    revoked.operatorControl?.granted === false, JSON.stringify(revoked.operatorControl));
}

// ─── 13. windowsService install/repair hand the operator through ────────────

/**
 * Redirects ProgramData into the temp area, so the wrapper, its XML, the
 * runtime copy and the logs all land under the test data directory.
 */
async function withProgramData(root, fn) {
  const platform = await import(srcUrl('core/platform.js'));
  const previous = process.env.ProgramData;
  process.env.ProgramData = root;
  platform.resetDataDirCache();
  try {
    return await fn(platform.programDataDir());
  } finally {
    if (previous === undefined) delete process.env.ProgramData;
    else process.env.ProgramData = previous;
    platform.resetDataDirCache();
  }
}

async function testWindowsServiceOperatorWiring() {
  setGroup('13. install and repair pass the operator, after the ACLs, before the start');

  const ws = await import(srcUrl('core/service/windowsService.js'));
  const rt = await import(srcUrl('core/service/runtime.js'));

  const root = scratch('operator-wiring');
  const appRoot = path.join(root, 'app');
  fs.mkdirSync(path.join(appRoot, 'src', 'cli'), { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'package.json'), '{}\n');
  fs.writeFileSync(path.join(appRoot, 'src', 'cli', 'index.js'), '// entry\n');

  const operator = { sid: SID, name: 'DOMAIN\\me', via: 'current' };
  const record = { sid: SID, name: 'DOMAIN\\me', serviceControl: true, dataDir: true, grantedAt: 'T' };

  await withProgramData(root, async (dataDir) => {
    const bin = path.join(dataDir, 'bin');
    const runtime = path.join(dataDir, 'runtime');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(ws.winswPath(), 'dummy wrapper');
    fs.writeFileSync(ws.serviceXmlPath(), '<service/>');
    fs.writeFileSync(path.join(runtime, 'node.exe'), 'dummy node');

    const events = [];
    const ledger = scmRun({ initial: 'MISSING' });
    const run = async (cmd) => { events.push(cmd); return ledger(cmd); };

    const prepared = [];
    const installDeps = {
      isWindows: true,
      isElevated: async () => true,
      canWrite: () => true,
      prepareProtectedDir: async (opts) => {
        events.push(`PREPARE:${opts.dir}`);
        prepared.push({
          dir: opts.dir,
          sid: opts.sid,
          serviceAccount: opts.serviceAccount,
          fresh: opts.fresh,
        });
        if (opts.fresh) fs.rmSync(opts.dir, { recursive: true, force: true });
        fs.mkdirSync(opts.dir, { recursive: true });
        return { ok: true };
      },
      copyRuntime: () => {
        events.push('COPY');
        fs.mkdirSync(runtime, { recursive: true });
        return { ok: true, dir: runtime, nodeExe: path.join(runtime, 'node.exe'), entry: 'ENTRY' };
      },
      verifyNativeModules: async () => ({ ok: true, version: 'v20.0.0', abi: '115' }),
      verifyWinsw: async () => { events.push('VERIFY_WINSW'); return { ok: true, sha256: 'stub' }; },
      grantOperator: async (opts) => {
        events.push('GRANT_OPERATOR');
        events.operator = opts.operator;
        events.protectedDirs = opts.protectedDirs;
        return { record, protection: { ok: true, protected: opts.protectedDirs, failed: [] }, notes: [] };
      },
    };

    const installed = await ws.install(withFileStub({
      dataDir,
      appRoot,
      config: {},
      operator,
      run,
      log: () => {},
      fetchImpl: async () => {
        events.push('FETCH');
        return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('fresh wrapper') };
      },
      deps: installDeps,
    }));

    check('the install succeeds', installed.ok === true, installed.reason ?? '');
    check('the result carries the operator record, for service-state',
      installed.operator === record, JSON.stringify(installed.operator));
    check('the resolver\'s operator is what was granted',
      events.operator?.sid === SID, JSON.stringify(events.operator));
    check('the wrapper folder and the runtime folder are the ones protected',
      events.protectedDirs?.[0] === ws.binDir() && events.protectedDirs?.[1] === rt.runtimeDir(dataDir),
      JSON.stringify(events.protectedDirs));

    // ── The folders are prepared while empty, before anything is copied in ──
    check('the data root, runtime folder and wrapper folder are prepared in order',
      prepared.length === 3
        && prepared[0].dir === dataDir
        && prepared[1].dir === rt.runtimeDir(dataDir)
        && prepared[2].dir === ws.binDir(),
      JSON.stringify(prepared.map((p) => p.dir)));
    check('both are prepared for the operator\'s SID', prepared.every((p) => p.sid === SID));
    check('and WITHOUT the service account, which does not exist before registration',
      prepared.every((p) => p.serviceAccount === false), JSON.stringify(prepared));
    check('the data directory is kept while runtime and bin are fresh',
      prepared[0].fresh === false && prepared[1].fresh === true && prepared[2].fresh === true,
      JSON.stringify(prepared.map((p) => ({ dir: p.dir, fresh: p.fresh }))));
    check('the preparation happens before the runtime is copied',
      events.indexOf(`PREPARE:${rt.runtimeDir(dataDir)}`) < events.indexOf('COPY'),
      events.join(' -> '));
    check('and before the wrapper is downloaded or verified',
      events.indexOf(`PREPARE:${ws.binDir()}`) < events.indexOf('VERIFY_WINSW')
      && events.indexOf(`PREPARE:${ws.binDir()}`) < events.indexOf('FETCH')
      && events.includes('VERIFY_WINSW'), events.join(' -> '));
    check('the wrapper folder is prepared before any icacls grant on it',
      events.indexOf(`PREPARE:${ws.binDir()}`) < events.findIndex((e) => /^icacls /.test(e)),
      events.join(' -> '));

    const grantAt = events.indexOf('GRANT_OPERATOR');
    const aclAt = events.findIndex((e) => /^icacls /.test(e));
    const startAt = events.findIndex((e) => /EasyDevOps\.exe" start$/.test(e));
    check('the grant runs after the service-account ACLs', aclAt !== -1 && grantAt > aclAt,
      `acl ${aclAt}, grant ${grantAt}`);
    check('and before the service is started', startAt !== -1 && grantAt < startAt,
      `grant ${grantAt}, start ${startAt}`);

    // ── A folder that cannot be protected stops the install, before it registers
    const blockedLedger = scmRun({ initial: 'MISSING' });
    const blocked = await ws.install(withFileStub({
      dataDir,
      appRoot,
      config: {},
      operator,
      run: blockedLedger,
      log: () => {},
      fetchImpl: async () => { throw new Error('must not download the wrapper'); },
      deps: {
        ...installDeps,
        copyRuntime: () => { throw new Error('must not copy into an unprotected folder'); },
        prepareProtectedDir: async () => ({ ok: false, reason: 'Access is denied.' }),
      },
    }));
    check('a folder that cannot be protected fails the install', blocked.ok === false);
    check('and says nothing was registered', /Nothing was registered/.test(blocked.reason ?? ''),
      blocked.reason);
    check('so no mutating command reaches the SCM or the wrapper',
      !blockedLedger.calls.some((c) => /^sc\.exe (stop|start|delete) /.test(c)
        || /EasyDevOps\.exe" (install|start)$/.test(c)),
      blockedLedger.calls.join(' | '));

    // ── Repair re-grants, because a fresh runtime copy inherits again ──────
    const repairEvents = [];
    const repairLedger = scmRun();
    const repairRun = async (cmd) => { repairEvents.push(cmd); return repairLedger(cmd); };
    let repairedOperator = null;
    let repairedDirs = null;
    let prevExistedAtPrepare = null;

    const repaired = await ws.repair(withFileStub({
      dataDir,
      appRoot,
      config: {},
      operator,
      run: repairRun,
      log: () => {},
      waitForStart: async () => ({ alive: true }),
      deps: {
        isWindows: true,
        isElevated: async () => true,
        canWrite: () => true,
        verifyWinsw: async () => ({ ok: true }),
        prepareProtectedDir: async (opts) => {
          repairEvents.push(`PREPARE:${opts.dir}`);
          prevExistedAtPrepare = fs.existsSync(`${opts.dir}.prev`);
          fs.mkdirSync(opts.dir, { recursive: true });
          return { ok: true };
        },
        copyRuntime: () => {
          repairEvents.push('COPY');
          fs.mkdirSync(runtime, { recursive: true });
          fs.writeFileSync(path.join(runtime, 'node.exe'), 'dummy node');
          return { ok: true, dir: runtime, nodeExe: path.join(runtime, 'node.exe'), entry: 'ENTRY' };
        },
        verifyNativeModules: async () => ({ ok: true, version: 'v20.0.0', abi: '115' }),
        stopWaitMs: 2_000,
        grantOperator: async (opts) => {
          repairEvents.push('GRANT_OPERATOR');
          repairedOperator = opts.operator;
          repairedDirs = opts.protectedDirs;
          return { record, protection: { ok: true, protected: opts.protectedDirs, failed: [] }, notes: [] };
        },
      },
    }));

    check('the repair succeeds', repaired.ok === true, repaired.reason ?? '');
    check('and carries the operator record', repaired.operator === record);
    check('repair passes the same operator', repairedOperator?.sid === SID, JSON.stringify(repairedOperator));
    check('and protects the wrapper and the runtime folder again',
      repairedDirs?.[0] === ws.binDir() && repairedDirs?.[1] === rt.runtimeDir(dataDir),
      JSON.stringify(repairedDirs));

    check('the fresh runtime folder is prepared, not copied first',
      repairEvents.indexOf(`PREPARE:${rt.runtimeDir(dataDir)}`) !== -1
      && repairEvents.indexOf(`PREPARE:${rt.runtimeDir(dataDir)}`) < repairEvents.indexOf('COPY'),
      repairEvents.join(' -> '));
    check('and only after the old copy was renamed aside to .prev', prevExistedAtPrepare === true);

    const repairGrantAt = repairEvents.indexOf('GRANT_OPERATOR');
    const repairAclAt = repairEvents.findIndex((e) => /^icacls /.test(e));
    const repairStartAt = repairEvents.findIndex((e) => /^sc\.exe start /.test(e));
    check('the repair grant follows the ACLs', repairAclAt !== -1 && repairGrantAt > repairAclAt,
      `acl ${repairAclAt}, grant ${repairGrantAt}`);
    check('and precedes the start on the new runtime copy',
      repairStartAt !== -1 && repairGrantAt < repairStartAt,
      `grant ${repairGrantAt}, start ${repairStartAt}`);

    // ── A failed preparation restores the previous runtime and starts on it ─
    const restoreLedger = scmRun();
    let restoreCopied = false;
    const restored = await ws.repair(withFileStub({
      dataDir,
      appRoot,
      config: {},
      operator,
      run: async (cmd) => restoreLedger(cmd),
      log: () => {},
      waitForStart: async () => ({ alive: true }),
      deps: {
        isWindows: true,
        isElevated: async () => true,
        canWrite: () => true,
        verifyWinsw: async () => ({ ok: true }),
        prepareProtectedDir: async () => ({ ok: false, reason: 'Access is denied.' }),
        copyRuntime: () => { restoreCopied = true; throw new Error('must not copy into an unprotected folder'); },
        stopWaitMs: 2_000,
      },
    }));
    check('a fresh runtime folder that cannot be protected fails the repair',
      restored.ok === false && /could not be protected/.test(restored.reason ?? ''), restored.reason);
    check('the previous copy is put back, not left behind', restored.restored === true
      && fs.readFileSync(path.join(runtime, 'node.exe'), 'utf8') === 'dummy node',
      JSON.stringify({ restored: restored.restored, exists: fs.existsSync(runtime) }));
    check('the service runs on it again', restored.restarted === true);
    check('and nothing was ever copied into the unprotected folder', restoreCopied === false);

    // ── A failed protection withholds the data grant ───────────────────────
    const withheldRun = stubRun([
      [/^sc\.exe query /, { success: false, stdout: '', stderr: 'The specified service does not exist (1060)' }],
      [/^sc\.exe qc /, { success: true, stdout: 'START_TYPE : 2  AUTO_START' }],
      [/^sc\.exe sdshow /, { stdout: SERVICE_SDDL }],
      [/^sc\.exe sdset /, { success: true }],
      [/inheritance:r/, { success: false, stderr: 'Access is denied.' }],
      [/EasyDevOps\.exe" (install|start)$/, { success: true }],
    ]);
    const withheld = await ws.install(withFileStub({
      dataDir,
      appRoot,
      config: {},
      operator,
      run: withheldRun,
      log: () => {},
      fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from('fresh wrapper') }),
      deps: { ...installDeps, grantOperator: undefined },
    }));
    check('failed protection leaves the service registered and stopped',
      withheld.ok === false && withheld.registered === true && !withheldRun.calls.some(c => /EasyDevOps\.exe" start$/.test(c)), withheld.reason ?? '');
    check('the recorded operator has no data directory access',
      withheld.operator?.dataDir === false, JSON.stringify(withheld.operator));
    check('and no data-directory grant command was run',
      !withheldRun.calls.some((c) => c.includes(`/grant "*${SID}:(OI)(CI)M"`)),
      withheldRun.calls.filter((c) => /\/grant/.test(c)).join(' | '));
    check('while an earlier data-directory grant is revoked',
      withheldRun.calls.some((c) => c === `icacls "${dataDir}" /remove:g "*${SID}" /L /Q`)
        && !withheldRun.calls.some((c) => /\/remove:g/.test(c) && /\/T\b/.test(c)),
      withheldRun.calls.join(' | '));
  });
}

// ─── 14. prepareProtectedDir: create, then protect while it is empty ────────

async function testPrepareProtectedDir() {
  setGroup('14. prepareProtectedDir creates the folder and protects it before a copy');

  const op = await import(srcUrl('core/service/operator.js'));
  const { SERVICE_ACCOUNT } = await import(srcUrl('core/service/winsw.js'));

  const root = scratch('prepare-dir');
  const dir = path.join(root, 'created', 'runtime');
  fs.mkdirSync(path.dirname(dir));

  const run = stubRun([[/icacls /, { success: true }]]);
  const prepared = await op.prepareProtectedDir(withFileStub({
    dir, sid: SID, serviceAccount: false, run, log: () => {},
  }));

  check('the missing folder is created', prepared.ok === true && fs.existsSync(dir), prepared.reason ?? '');
  check('and protected in the same call, before anything could be placed in it',
    JSON.stringify(run.calls) === JSON.stringify(op.buildProtectCommands(dir, SID, { serviceAccount: false }).map(aclCall)),
    run.calls.join(' | '));
  check('the owner is Administrators first', run.calls[0]?.includes(`/setowner "*S-1-5-32-544"`), run.calls[0]);
  check('the old DACL is reset next', run.calls[1] === aclCall(op.buildProtectCommands(dir, SID, { serviceAccount: false })[1]),
    run.calls[1]);
  check('the service account is omitted while the service does not exist yet',
    !run.calls[2]?.includes(SERVICE_ACCOUNT), run.calls[2]);
  check('and the operator\'s own SID is removed, not granted', run.calls[3]?.includes(`/remove:g "*${SID}"`),
    run.calls[3]);

  const again = await op.prepareProtectedDir(withFileStub({
    dir, sid: SID, run: stubRun([[/icacls /, { success: true }]]), log: () => {},
  }));
  check('preparing a folder that already exists is not an error', again.ok === true);

  const deniedDir = path.join(root, 'denied');
  const denied = await op.prepareProtectedDir(withFileStub({
    dir: deniedDir, sid: SID, run: stubRun([[/icacls /, { success: false, stderr: 'Access is denied.' }]]),
    log: () => {},
  }));
  check('a folder that cannot be protected is {ok:false}', denied.ok === false);
  check('with the icacls output as the reason', /Access is denied/.test(denied.reason ?? ''), denied.reason);
  check('and it is left empty, so nothing ran from it',
    fs.existsSync(deniedDir) && fs.readdirSync(deniedDir).length === 0);

  const hiddenRun = stubRun([[/icacls /, { success: true }]]);
  const hidden = await op.prepareProtectedDir({
    dir: path.join(root, 'acl-hidden'),
    sid: SID,
    runFile: withFileStub({ run: hiddenRun }).runFile,
    fsApi: {
      lstatSync: () => {
        const error = new Error('EPERM: operation not permitted, lstat runtime');
        error.code = 'EPERM';
        throw error;
      },
    },
  });
  check('an EPERM while inspecting the destination fails closed',
    hidden.ok === false && /EPERM/.test(hidden.reason ?? ''), hidden.reason ?? '');
  check('and no ACL command runs against a path that could not be inspected',
    hiddenRun.calls.length === 0, hiddenRun.calls.join(' | '));

  const oddDir = path.join(root, 'odd$dir');
  const oddRun = stubRun([[/icacls /, { success: true }]]);
  const odd = await op.prepareProtectedDir(withFileStub({
    dir: oddDir, sid: SID, run: oddRun, log: () => {},
  }));
  check('a newly created directory containing a dollar sign is protected',
    odd.ok === true && fs.existsSync(oddDir), odd.reason);
  check('its path stays a literal direct-argument value',
    oddRun.calls.length === 4 && oddRun.calls.every((call) => call.includes(oddDir)),
    oddRun.calls.join(' | '));

  const stale = path.join(root, 'stale-runtime');
  const staleStub = path.join(stale, 'app', 'node_modules', 'bufferutil', 'easy-devops-optional.cjs');
  fs.mkdirSync(path.dirname(staleStub), { recursive: true });
  fs.writeFileSync(staleStub, 'require("child_process").exec("malicious");\n');
  fs.writeFileSync(path.join(stale, 'marker'), 'old runtime\n');
  const freshRun = stubRun([[/icacls /, { success: true }]]);
  const fresh = await op.prepareProtectedDir(withFileStub({
    dir: stale, sid: SID, serviceAccount: false, fresh: true, run: freshRun, log: () => {},
  }));
  check('a fresh runtime replaces the whole pre-existing tree', fresh.ok === true
    && fs.existsSync(stale) && fs.readdirSync(stale).length === 0, fresh.reason ?? '');
  check('so attacker-created optional-package code is gone before copy',
    !fs.existsSync(staleStub), staleStub);
  check('and the replacement directory is protected while empty',
    freshRun.calls[1]?.includes(' /reset ') && freshRun.calls[2]?.includes('/inheritance:r'),
    freshRun.calls.join(' | '));
}

// ─── 15. runtimeUpdate.update: elevation before install, smoke or stop ──────

async function testRuntimeUpdateElevation() {
  setGroup('15. a runtime update checks elevation before installing or stopping');

  const ru = await import(srcUrl('core/service/runtimeUpdate.js'));
  const { isWindows } = await import(srcUrl('core/platform.js'));

  const TARGET = { version: '22.11.0', source: 'system' };

  if (!isWindows) {
    for (const label of [
      'the update refuses at the elevation step',
      'reporting needsElevation and that nothing was touched',
      'and naming the Administrator terminal, never a password',
      'nothing was installed, smoke-tested, swapped or stopped',
      'the service was never asked to stop',
      'with elevation the gate does not fire',
      'and the run gets as far as the stop',
      'Personal mode is not gated on elevation',
    ]) {
      check(label, true, 'skipped: Windows only');
    }
    return;
  }

  const order = [];
  const service = {
    calls: [],
    async stop() { order.push('stop'); service.calls.push('stop'); return { ok: true }; },
    async start() { order.push('start'); service.calls.push('start'); return { ok: true }; },
  };

  const refused = await ru.update({
    target: TARGET,
    dataDir: scratch('rt-elevation'),
    deps: {
      run: stubRun(),
      service,
      mechanism: { platform: 'windows', mode: 'server', mechanism: 'winsw' },
      isElevated: async () => false,
      installTarget: async () => { order.push('install'); return { ok: true, nodeExe: 'C:\\node22\\node.exe' }; },
      smokeTest: async () => { order.push('smoke'); return { ok: true, version: '22.11.0', abi: '127' }; },
      applyRuntime: async () => { order.push('apply'); return { ok: true }; },
    },
  });

  check('the update refuses at the elevation step',
    refused.ok === false && refused.step === 'elevation', refused.step);
  check('reporting needsElevation and that nothing was touched',
    refused.needsElevation === true && refused.untouched === true);
  check('and naming the Administrator terminal, never a password',
    /administrator/i.test(refused.reason ?? '') && !/password required|enter your password/i.test(refused.reason ?? ''),
    refused.reason);
  check('nothing was installed, smoke-tested, swapped or stopped', order.length === 0, order.join(' -> '));
  check('the service was never asked to stop', !service.calls.includes('stop'), service.calls.join(' -> '));

  const elevateOrder = [];
  const proceeded = await ru.update({
    target: TARGET,
    dataDir: scratch('rt-elevation-ok'),
    deps: {
      run: stubRun(),
      service: {
        async stop() { elevateOrder.push('stop'); return { ok: false, reason: 'stop refused' }; },
        async start() { return { ok: true }; },
      },
      mechanism: { platform: 'windows', mode: 'server', mechanism: 'winsw' },
      isElevated: async () => true,
      installTarget: async () => { elevateOrder.push('install'); return { ok: true, nodeExe: 'C:\\node22\\node.exe' }; },
      smokeTest: async () => { elevateOrder.push('smoke'); return { ok: true, version: '22.11.0', abi: '127' }; },
    },
  });
  check('with elevation the gate does not fire', proceeded.step !== 'elevation', proceeded.step);
  check('and the run gets as far as the stop', elevateOrder.join(',') === 'install,smoke,stop',
    elevateOrder.join(' -> '));

  let personalStopped = false;
  const personal = await ru.update({
    target: TARGET,
    dataDir: scratch('rt-elevation-personal'),
    deps: {
      run: stubRun(),
      service: {
        async stop() { personalStopped = true; return { ok: false, reason: 'stop refused' }; },
        async start() { return { ok: true }; },
      },
      mechanism: { platform: 'windows', mode: 'personal', mechanism: 'startup-supervisor' },
      isElevated: async () => false,
      installTarget: async () => ({ ok: true, nodeExe: 'C:\\node22\\node.exe' }),
      smokeTest: async () => ({ ok: true, version: '22.11.0', abi: '127' }),
    },
  });
  check('Personal mode is not gated on elevation', personal.step === 'stop' && personalStopped,
    personal.step);
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write('\nWindows Server mode: the operator, the DACL, the relaunch, the update gate\n');
  process.stdout.write(`data dir: ${TEST_DATA_DIR}\n`);

  const { isWindows } = await import(srcUrl('core/platform.js'));

  await testAccountSid();
  await testServiceDacl();
  await testDataDirCommands();
  await testProtectServiceFiles();
  await testGrantServiceControl();
  await testGrantOperator();
  await testRelaunchCommand();
  await testRequireElevation();
  await testUpdaterElevation();
  await testUpdateController();
  await testWindowsRestart();
  await testWindowsStatusOperator();
  await testPrepareProtectedDir();
  if (isWindows) {
    await testWindowsServiceOperatorWiring();
    await testRuntimeUpdateElevation();
  } else {
    setGroup('13. install and repair pass the operator, after the ACLs, before the start');
    for (const label of [
      'the install succeeds',
      'the result carries the operator record, for service-state',
      'the resolver\'s operator is what was granted',
      'the wrapper folder and the runtime folder are the ones protected',
      'the data root, runtime folder and wrapper folder are prepared in order',
      'both are prepared for the operator\'s SID',
      'and WITHOUT the service account, which does not exist before registration',
      'the preparation happens before the runtime is copied',
      'and before the wrapper is downloaded or verified',
      'the wrapper folder is prepared before any icacls grant on it',
      'the grant runs after the service-account ACLs',
      'and before the service is started',
      'a folder that cannot be protected fails the install',
      'and says nothing was registered',
      'so no command reaches the SCM or the wrapper',
      'the repair succeeds',
      'and carries the operator record',
      'repair passes the same operator',
      'and protects the wrapper and the runtime folder again',
      'the fresh runtime folder is prepared, not copied first',
      'and only after the old copy was renamed aside to .prev',
      'the repair grant follows the ACLs',
      'and precedes the start on the new runtime copy',
      'a fresh runtime folder that cannot be protected fails the repair',
      'the previous copy is put back, not left behind',
      'the service runs on it again',
      'and nothing was ever copied into the unprotected folder',
      'with a failed protection the install still fails its notes, not the service',
      'the recorded operator has no data directory access',
      'and no data-directory grant command was run',
      'while an earlier data-directory grant is revoked',
    ]) {
      check(label, true, 'skipped: Windows only');
    }
    await testRuntimeUpdateElevation();
  }

  const failed = results.filter((r) => !r.passed);
  process.stdout.write(`\n${'-'.repeat(62)}\n`);
  process.stdout.write(`TOTAL ${results.length}   PASS ${results.length - failed.length}   FAIL ${failed.length}\n`);
  if (failed.length) {
    process.stdout.write('\nFailures:\n');
    for (const f of failed) process.stdout.write(`  [${f.group}] ${f.label}${f.detail ? ` - ${f.detail}` : ''}\n`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(String(e.stack || e) + '\n');
  process.exit(1);
});
