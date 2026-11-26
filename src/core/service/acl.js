/**
 * core/service/acl.js
 *
 * Granting the Windows service account the access it needs — and nothing else.
 *
 * The service runs as `NT SERVICE\EasyDevOps`, a virtual account with no
 * password and, by default, no rights to anything outside its own service key.
 * That is the right starting point, and it means every directory it genuinely
 * needs has to be granted explicitly:
 *
 *   - the data directory      — Modify: it writes the database, the lock, logs
 *   - the pinned runtime      — Read & execute: it runs node.exe from there
 *   - `nginxDir` from Settings — Modify: it writes and reloads domain configs
 *   - `sslDir` from Settings   — Modify: it writes renewed certificates
 *
 * ── Why the paths come from Settings and are never hardcoded ───────────────
 *
 * `C:\nginx` and `C:\ssl` are only the defaults. A user who installed nginx
 * somewhere else, or moved their certificates, would get a service that
 * silently cannot read its own configuration — while the grant sat on two
 * directories that may not even exist. Worse, granting a hardcoded path would
 * hand a service account write access to a directory the user never pointed us
 * at. So the grants are computed from the live config, recorded, and compared
 * on every `status`: if the user changes a path in Settings afterwards, the
 * service is told to run `ezz service repair` rather than quietly losing
 * access.
 *
 * ── Why inheritance flags matter ───────────────────────────────────────────
 *
 * `(OI)(CI)` makes the grant apply to files and subdirectories created later.
 * Existing entries are visited depth-first. Each directory is locked before it
 * is enumerated, so a same-account process cannot swap in a reparse point or
 * hard link after validation and before the ACL mutation.
 *
 * Nothing in this module runs without an elevated terminal; `icacls` fails with
 * "Access is denied" otherwise, which is reported as such rather than retried.
 */

import fs from 'fs';
import path from 'path';

import { runFile as shellRunFile } from '../shell.js';
import {
  isWindows,
  programDataDir,
  WINDOWS_PROGRAM_DATA_ROOT,
  WINDOWS_PROGRAM_FILES_ROOT,
  WINDOWS_PROGRAM_FILES_X86_ROOT,
  WINDOWS_SYSTEM_ROOT,
} from '../platform.js';
import { SERVICE_ACCOUNT } from './winsw.js';
import {
  UNINSTALL_STAGE_TIMEOUT_MS,
  remainingStageMs,
} from './stageTimeout.js';

/** Access levels, in icacls's own notation. */
export const ACCESS = Object.freeze({
  /** Read, write, delete within the tree. Not "take ownership" or "change permissions". */
  MODIFY: 'M',
  /** Read and execute only. */
  READ_EXECUTE: 'RX',
});

/**
 * Which directories the service needs, and at what level.
 *
 * @param {Object} opts
 * @param {string} opts.dataDir
 * @param {string} [opts.runtimeDir]
 * @param {string} [opts.nginxDir] From Settings — never a default
 * @param {string} [opts.sslDir]   From Settings — never a default
 * @returns {Array<{ path: string, access: string, why: string }>}
 */
export function requiredGrants({ dataDir, nginxDir = null, sslDir = null } = {}) {
  const grants = [
    { path: dataDir, access: ACCESS.MODIFY, why: 'the database, the daemon lock and logs' },
  ];

  if (nginxDir) {
    grants.push({ path: nginxDir, access: ACCESS.MODIFY, why: 'writing and reloading domain configs' });
  }
  if (sslDir) {
    grants.push({ path: sslDir, access: ACCESS.MODIFY, why: 'writing renewed certificates' });
  }

  // A user can point nginxDir and sslDir at the same tree, or nest one inside
  // the other. Granting twice is harmless but produces confusing output, so
  // duplicates are collapsed — keeping the broader access where they differ.
  const seen = new Map();
  for (const grant of grants) {
    if (!grant.path) continue;
    const key = path.resolve(grant.path).toLowerCase();
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, grant);
    } else if (existing.access === ACCESS.READ_EXECUTE && grant.access === ACCESS.MODIFY) {
      seen.set(key, grant);
    }
  }

  return [...seen.values()];
}

/** Pin native tools to the Windows installation, bypassing the current directory and PATH. */
export function systemTool(name) {
  return path.win32.join(WINDOWS_SYSTEM_ROOT, 'System32', name);
}

export const WINDOWS_POWERSHELL = systemTool('WindowsPowerShell\\v1.0\\powershell.exe');

// ─── Reading an icacls listing back ─────────────────────────────────────────

const ACE_TAIL = /^(?:\([^()]*\))+$/;

// A trustee as icacls prints it at the end of a line. SID form is included
// because a localized Windows may not resolve a name for every account.
const TRUSTEE_AT_END = new RegExp(
  '('
  + '(?:\\*?S-1-[0-9-]+)'
  + '|(?:NT AUTHORITY\\\\[^\\\\:]+)'
  + '|(?:NT SERVICE\\\\[^\\\\:]+)'
  + '|(?:BUILTIN\\\\[^\\\\:]+)'
  + '|(?:APPLICATION PACKAGE AUTHORITY\\\\[^\\\\:]+)'
  + '|(?:CREATOR OWNER)'
  + '|(?:Everyone)'
  + '|(?:[^\\s\\\\]+\\\\[^\\s:]+)'
  + ')\\s*$',
  'i',
);

function parseIcaclsAce(line) {
  const colon = line.lastIndexOf(':');
  if (colon === -1) return null;
  const tail = line.slice(colon + 1).trim();
  if (!ACE_TAIL.test(tail)) return null;
  const before = line.slice(0, colon);
  const match = TRUSTEE_AT_END.exec(before);
  if (!match) return null;
  return {
    prefix: before.slice(0, match.index).trim(),
    trustee: match[1].trim(),
    permissions: [...tail.matchAll(/\(([^()]*)\)/g)].map((entry) => entry[1].trim()),
  };
}

/** The summary `icacls` prints after a recursive pass. */
const ICACLS_SUMMARY = /Successfully processed\s+([\d,]+)\s+files?(?:;?\s*Failed processing\s+([\d,]+)\s+files?)?/i;

/** The messages `icacls` prints for one object it could not process. */
const ICACLS_FAILURE = /^(?:Access is denied|The system cannot find|The filename, directory name, or volume label syntax is incorrect|No mapping between account names and security IDs was done|Invalid parameter|The parameter is incorrect)\b/i;

/**
 * The failure text of one printed line, or null.
 *
 * `icacls` prefixes a per-file error with the path and a colon
 * (`C:\dir\file.txt: Access is denied.`), so the text after the last colon is
 * checked as well as the whole line. Windows cannot put a colon inside a path
 * beyond the drive letter, so this cannot mistake a path for an error.
 */
function icaclsFailureOf(line) {
  const text = String(line ?? '').trim();
  const colon = text.lastIndexOf(':');
  const tail = colon > 1 ? text.slice(colon + 1).trim() : text;
  return ICACLS_FAILURE.test(tail) || ICACLS_FAILURE.test(text) ? text : null;
}

/**
 * Classifies one line of `icacls` output.
 *
 * One parser for both readers, so a listing read from captured output and a
 * listing streamed while it is produced can never disagree about what an ACE
 * line is, or about what an empty DACL looks like.
 *
 * @param {string} raw
 * @returns {{ kind: 'blank'|'summary'|'error'|'path'|'ace', path?: string,
 *   ace?: { trustee: string, permissions: string[] }, text?: string,
 *   succeeded?: number|null, failed?: number }}
 */
function classifyIcaclsLine(raw) {
  const line = String(raw ?? '').replace(/\s+$/, '');
  if (!line.trim()) return { kind: 'blank' };
  if (/\b(?:Successfully processed|Failed processing)\b/i.test(line)) {
    const summary = ICACLS_SUMMARY.exec(line);
    return {
      kind: 'summary',
      succeeded: summary ? Number(summary[1].replace(/,/g, '')) : null,
      // A summary without the second half reported no failures.
      failed: summary?.[2] ? Number(summary[2].replace(/,/g, '')) : 0,
    };
  }
  const failure = icaclsFailureOf(line);
  if (failure) return { kind: 'error', text: failure };
  const ace = parseIcaclsAce(line);
  if (!ace) return { kind: 'path', path: line.trim(), ace: null };
  const parsed = { trustee: ace.trustee, permissions: ace.permissions };
  // Continuation lines are indented to the path width, so they carry no path.
  return ace.prefix
    ? { kind: 'path', path: ace.prefix, ace: parsed }
    : { kind: 'ace', ace: parsed };
}

/**
 * The entry state machine behind both readers.
 *
 * A path line opens an entry; the ACE on that same line is its first, and the
 * indented lines that follow belong to it. A path line with no ACE at all is an
 * EMPTY DACL and is kept as an entry with no ACEs — that is the broken state
 * this read-back exists to catch. An entry is closed by the next path line or
 * by the end of the output.
 *
 * @param {(entry: { path: string, aces: Array<{ trustee: string, permissions: string[] }> }) => void} [onEntry]
 * @param {{ retain?: boolean }} [options] `retain: false` keeps no history, for a streamed tree.
 */
function createIcaclsEntryBuilder(onEntry, { retain = true } = {}) {
  const entries = [];
  let current = null;
  const close = () => {
    if (!current) return null;
    const entry = current;
    current = null;
    if (retain) entries.push(entry);
    if (typeof onEntry === 'function') onEntry(entry);
    return entry;
  };
  return {
    feed(rawLine) {
      const parsed = classifyIcaclsLine(rawLine);
      if (parsed.kind === 'path') {
        close();
        current = { path: parsed.path, aces: parsed.ace ? [parsed.ace] : [] };
      } else if (parsed.kind === 'ace' && current) {
        current.aces.push(parsed.ace);
      }
      return parsed;
    },
    end() {
      close();
      return entries;
    },
  };
}

/**
 * Parses `icacls <path>` and `icacls <path>\* /T /C` output that was already
 * captured.
 *
 * Kept for a single object (`icacls <folder>`), where the output is one short
 * listing. A whole tree is never parsed this way: see streamIcaclsTree.
 *
 * @param {string} output
 * @returns {Array<{ path: string, aces: Array<{ trustee: string, permissions: string[] }> }>}
 */
export function parseIcaclsListing(output) {
  const builder = createIcaclsEntryBuilder(null);
  for (const line of String(output ?? '').split(/\r?\n/)) builder.feed(line);
  return builder.end();
}

/** A whole-tree listing may legitimately take minutes on a slow disk. */
export const ICACLS_TREE_TIMEOUT_MS = 10 * 60_000;

/** How often a streamed scan offers a progress update. */
const STREAM_PROGRESS_INTERVAL_MS = 2_000;

/**
 * Reads a whole tree's DACLs without ever depending on captured output.
 *
 * `shell.js` is asked for `output: 'stream'`, which keeps NOTHING of stdout or
 * stderr, and every chunk is split into lines as it arrives: no size cap, no
 * buffer that can drop the beginning, and no captured text that could be
 * mistaken for the whole listing. (The old capture kept only the newest 64 KiB;
 * `icacls` lists a folder's own entries first, so a large tree lost exactly the
 * entries at the front and a real server reported `runtime\node.exe is missing
 * from the read-back` while the ACL was correct.)
 *
 * A read that streams nothing is a FAILURE ("icacls produced no output"), never
 * a pass: the one exception is a code root with no children yet, where icacls
 * has nothing to report and there is nothing to verify.
 *
 * @param {string} root  The folder to scan; its children are read, not the folder itself.
 * @param {Object} [opts]
 * @param {Function} [opts.runFile]
 * @param {(entry: { path: string, aces: Array }) => void} [opts.onEntry]
 * @param {(progress: { count: number, elapsedMs: number }) => void} [opts.onProgress]
 * @param {number} [opts.timeout]
 * @returns {Promise<{ ok: boolean, count: number, error: string|null,
 *   failed: string[] }>}
 */
export async function streamIcaclsTree(root, {
  runFile = shellRunFile,
  onEntry = null,
  onProgress = null,
  timeout = ICACLS_TREE_TIMEOUT_MS,
  progressIntervalMs = STREAM_PROGRESS_INTERVAL_MS,
} = {}) {
  const target = path.win32.join(String(root), '*');
  const limit = Number.isFinite(timeout) && timeout > 0 ? timeout : ICACLS_TREE_TIMEOUT_MS;
  const interval = Number.isFinite(progressIntervalMs) && progressIntervalMs > 0
    ? progressIntervalMs
    : STREAM_PROGRESS_INTERVAL_MS;
  const started = Date.now();
  const failures = [];
  let count = 0;
  let summaryFailed = 0;
  let sawStdout = false;
  let sawStderr = false;
  let lastProgress = 0;

  /**
   * The failing lines the owner needs, first five only: a tree with thousands
   * of unreadable files must not print thousands of lines. The count of
   * failures comes from icacls's own summary.
   */
  const noteFailure = (text) => {
    const line = String(text ?? '').trim();
    if (!line || failures.length >= 5) return;
    failures.push(line);
  };

  const reportProgress = () => {
    if (typeof onProgress !== 'function') return;
    const elapsedMs = Date.now() - started;
    if (elapsedMs - lastProgress < interval) return;
    lastProgress = elapsedMs;
    try {
      onProgress({ count, elapsedMs });
    } catch { /* a progress listener cannot fail the scan */ }
  };

  const builder = createIcaclsEntryBuilder((entry) => {
    count += 1;
    if (typeof onEntry === 'function') {
      try {
        onEntry(entry);
      } catch { /* an entry listener cannot fail the scan */ }
    }
  }, { retain: false });

  /**
   * A chunk can end in the middle of a line, and a CRLF can be split across
   * two chunks. Complete lines are handed over as soon as their newline
   * arrives; the remainder waits for the next chunk.
   */
  const splitLines = (state, text) => {
    if (!text) return '';
    const pending = state.pending + String(text);
    const lines = pending.split('\n');
    state.pending = lines.pop() ?? '';
    for (const line of lines) {
      handleLine(line.endsWith('\r') ? line.slice(0, -1) : line);
    }
    return state.pending;
  };

  const stdout = { pending: '' };
  const stderr = { pending: '' };

  const handleLine = (line) => {
    const parsed = builder.feed(line);
    if (parsed.kind === 'error') noteFailure(parsed.text);
    if (parsed.kind === 'summary' && parsed.failed) {
      summaryFailed = Math.max(summaryFailed, parsed.failed);
    }
    if (parsed.kind !== 'blank') reportProgress();
  };

  // stderr never carries entries; its complete lines are failures.
  const splitFailures = (state, text) => {
    if (!text) return;
    const pending = state.pending + String(text);
    const lines = pending.split('\n');
    state.pending = lines.pop() ?? '';
    for (const line of lines) noteFailure(line.replace(/\r$/, ''));
  };

  let result;
  try {
    result = await runFile(systemTool('icacls.exe'), [target, '/T', '/C', '/Q'], {
      timeout: limit,
      // `stream`: shell.js keeps NOTHING of stdout or stderr. Every chunk comes
      // through onData, so a listing larger than any buffer cannot be cut, and
      // no captured text can be mistaken for the whole listing.
      output: 'stream',
      onData: (text, stream = 'stdout') => {
        if (stream === 'stderr') {
          sawStderr = true;
          splitFailures(stderr, text);
          return;
        }
        sawStdout = true;
        splitLines(stdout, text);
      },
    });
  } catch (error) {
    return { ok: false, count, error: error?.message ?? String(error), failed: failures.slice(0, 5) };
  }

  // Close the last line, then the last entry.
  if (stdout.pending) handleLine(stdout.pending.replace(/\r$/, ''));
  if (stderr.pending) noteFailure(stderr.pending.replace(/\r$/, ''));
  builder.end();

  const problems = [];
  if (!result?.success) {
    const output = `${result?.stdout ?? ''} ${result?.stderr ?? ''}`.trim();
    problems.push(output.slice(0, 300) || 'icacls failed');
  }
  if (!sawStdout && !sawStderr) {
    // Nothing was streamed at all. `output: 'stream'` keeps no capture to fall
    // back to, and a listing that never arrived must never read as "every file
    // is fine". The one real case is a code root with no children yet - a
    // folder protected before its first copy - where icacls has nothing to
    // report and there is nothing to verify.
    if (!treeIsEmpty(root)) problems.push('icacls produced no output');
  }
  if (summaryFailed > 0) problems.push(`${summaryFailed} file${summaryFailed === 1 ? '' : 's'} could not be processed`);
  if (failures.length) problems.push(failures.slice(0, 5).join('; '));

  return {
    ok: problems.length === 0,
    count,
    error: problems.length ? [...new Set(problems)].join(' — ') : null,
    failed: failures.slice(0, 5),
  };
}

/** Whether a folder really has no children, used only when icacls said nothing. */
function treeIsEmpty(root) {
  try {
    return fs.readdirSync(String(root ?? '')).length === 0;
  } catch {
    // Unreadable is not empty: that must fail, not pass silently.
    return false;
  }
}

/** Matches a trustee name or SID the way `normalizeTrustee` does below. */
function aclPathKey(value) {
  return path.win32.normalize(String(value ?? '')).toLowerCase();
}

/** Whether one entry gives any of `trustees` write access (Modify or more). */
function entryAllowsModify(entry, trustees) {
  return entryAllows(entry, trustees, /^(?:F|M|GA)$/i);
}

/**
 * Reads ONE path's ACL for a status answer — never a tree.
 *
 * One `icacls <target>` spawn, no `/T`: the answer is about that object alone.
 * The captured output is fine here because a single listing is a few lines.
 *
 * @param {string} target
 * @param {Object} [opts]
 * @param {Function} [opts.runFile]
 * @param {string[]} [opts.trustees]  Accounts to report on; the service account by default.
 * @returns {Promise<{ exists: boolean, ok: boolean, readable: boolean|null,
 *   modify: boolean|null, full: boolean|null, aces: Array, error: string|null }>}
 */
export async function readPathAccess(target, {
  runFile = shellRunFile,
  trustees = [SERVICE_ACCOUNT],
  timeout = 60_000,
} = {}) {
  const requested = String(target ?? '');
  const limit = Number.isFinite(timeout) && timeout > 0 ? timeout : 60_000;
  const empty = { exists: false, ok: true, readable: null, modify: null, full: null, aces: [], error: null };
  if (!requested) return { ...empty, ok: false, error: 'no path was given' };

  let result;
  try {
    result = await runFile(systemTool('icacls.exe'), [requested], { timeout: limit });
  } catch (error) {
    return { ...empty, exists: true, ok: false, error: error?.message ?? String(error) };
  }
  const output = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`.trim();
  if (/The system cannot find|The filename, directory name, or volume label syntax is incorrect|could not find the path/i.test(output)) {
    return empty;
  }
  if (!result?.success) {
    return {
      ...empty,
      exists: true,
      ok: false,
      error: output.slice(0, 300) || 'icacls failed',
    };
  }
  const entries = parseIcaclsListing(result?.stdout ?? '');
  const entry = entries.find((candidate) => aclPathKey(candidate.path) === aclPathKey(requested))
    ?? entries[0];
  if (!entry) {
    return {
      ...empty,
      exists: true,
      ok: false,
      error: `the read-back of ${requested} contained no entry`
      + (/Successfully processed/i.test(output) ? ' (the DACL is empty)' : ''),
      aces: [],
    };
  }
  const accounts = (trustees ?? []).filter(Boolean);
  return {
    exists: true,
    ok: true,
    readable: accounts.length ? aclEntryAllowsReadExecute(entry, accounts) : null,
    modify: accounts.length ? entryAllowsModify(entry, accounts) : null,
    full: accounts.length ? aclEntryAllowsFullControl(entry, accounts) : null,
    aces: entry.aces,
    error: null,
  };
}

function normalizeTrustee(value) {
  return String(value ?? '').trim().replace(/^\*/, '').toUpperCase();
}

function entryAllows(entry, trustees, levels) {
  const wanted = trustees.map(normalizeTrustee);
  return (entry?.aces ?? []).some((ace) => {
    if (ace.permissions.some((permission) => /^deny$/i.test(permission))) return false;
    return wanted.includes(normalizeTrustee(ace.trustee))
      && ace.permissions.some((permission) => levels.test(permission));
  });
}

/** Whether one parsed entry grants full control to any of `trustees`. */
export function aclEntryAllowsFullControl(entry, trustees) {
  return entryAllows(entry, trustees, /^(?:F|GA)$/i);
}

/** Whether one parsed entry grants read and execute to any of `trustees`. */
export function aclEntryAllowsReadExecute(entry, trustees) {
  return entryAllows(entry, trustees, /^(?:F|M|RX|R|GA)$/i);
}

/** ACE permission tokens that icacls uses for more than read and execute. */
const WRITE_PERMISSIONS = new Set(['W', 'M', 'F', 'D', 'WD', 'AD', 'WA', 'WEA', 'DC', 'GA', 'GW']);

/** Whether an ACE is marked inherited by icacls (`(I)`). */
export function aclAceIsInherited(ace) {
  return (ace?.permissions ?? []).some((permission) => /^I$/i.test(permission));
}

/**
 * The first ACE in an entry that gives a trustee outside `allowedTrustees`
 * anything beyond read and execute. `SYSTEM` and Administrators must be in
 * `allowedTrustees` by the caller; anyone else with write access is a
 * privilege-escalation path into a runtime the service executes from.
 *
 * @returns {{ trustee: string, permissions: string[] }|null}
 */
export function aclEntryExcessPermission(entry, allowedTrustees) {
  const allowed = (allowedTrustees ?? []).map(normalizeTrustee);
  for (const ace of entry?.aces ?? []) {
    if (ace.permissions.some((permission) => /^deny$/i.test(permission))) continue;
    if (allowed.includes(normalizeTrustee(ace.trustee))) continue;
    const excessive = ace.permissions.some((permission) => {
      const value = String(permission ?? '').trim().toUpperCase();
      // A hex rights mask cannot be read here; fail closed rather than guess.
      return WRITE_PERMISSIONS.has(value) || /^0X/i.test(value);
    });
    if (excessive) return { trustee: ace.trustee, permissions: ace.permissions };
  }
  return null;
}

function inside(dir, base) {
  const rel = path.relative(base, dir);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function sameDirectory(left, right) {
  if (!left || !right) return false;
  const normalize = (value) => (
    isWindows ? path.win32.normalize(path.resolve(value)).toLowerCase()
      : path.posix.normalize(path.resolve(value))
  );
  return normalize(left) === normalize(right);
}

/** Validate before examining a settings-controlled location or passing it to an OS utility. */
export async function canonicalAclDirectory(dir, {
  deadline = Infinity,
  stage = 'ACL validation',
  timeoutMs = UNINSTALL_STAGE_TIMEOUT_MS,
  signal,
} = {}) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || /["*?<>|\x00-\x1f]/.test(dir)
      || dir.split(/[\\/]/).some(part => part === '.' || part === '..' || /[. ]$/.test(part))
      || (isWindows && (!/^[A-Za-z]:[\\/]/.test(dir) || dir.slice(2).includes(':')))) {
    throw new Error('refusing an unusual path: use an absolute local directory');
  }
  const target = path.resolve(dir);
  const root = path.parse(target).root;
  const windows = WINDOWS_SYSTEM_ROOT;
  const protectedTrees = [
    windows,
    WINDOWS_PROGRAM_FILES_ROOT,
    WINDOWS_PROGRAM_FILES_X86_ROOT,
    path.join(root, 'System Volume Information'),
    path.join(root, '$Recycle.Bin'),
  ];
  // Dedicated Easy DevOps directories live below these OS container roots.
  // Deny the containers themselves, not every legitimate child. Callers that
  // accept a configured path also require it to equal a machine-level approval.
  const protectedContainers = [
    WINDOWS_PROGRAM_DATA_ROOT,
    path.join(root, 'Users'),
  ];
  if (target === root || (isWindows && (protectedTrees.some(base => inside(target, base))
      || protectedTrees.some(base => inside(base, target))
      || protectedContainers.some(base => sameDirectory(base, target))))) {
    throw new Error('refusing a system directory');
  }
  // Check every component before descending. realpath additionally catches aliases such as 8.3 names.
  let current = root;
  for (const part of target.slice(root.length).split(path.sep)) {
    remainingStageMs(deadline, stage, timeoutMs);
    signal?.throwIfAborted();
    current = path.join(current, part);
    let stat;
    try {
      stat = await fs.promises.lstat(current);
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error('the directory does not exist yet');
      throw error;
    }
    if (!stat) throw new Error('the directory does not exist yet');
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('refusing a reparse point or non-directory');
  }
  const realpath = await fs.promises.realpath(target);
  if (path.relative(target, realpath) !== '') throw new Error('refusing a directory alias');
  remainingStageMs(deadline, stage, timeoutMs);
  signal?.throwIfAborted();
  return target;
}

// Node reports junctions and symbolic links through lstat, but Windows has other reparse tags.
// Inspect native attributes without expanding the path, including descendants before recursive operations.
const CHECK_ATTRIBUTES = [
  "$ErrorActionPreference = 'Stop'",
  '$p = [IO.DirectoryInfo]$env:EZ_ACL_TARGET',
  'for ($a = $p; $null -ne $a; $a = $a.Parent) { if ($a.Attributes -band 1024) { throw "reparse point" } }',
  'if ($env:EZ_ACL_TREE -eq "1") {',
  '  $stack = New-Object System.Collections.Stack; $stack.Push($p)',
  '  while ($stack.Count) { foreach ($item in $stack.Pop().EnumerateFileSystemInfos()) {',
  '    if ($item.Attributes -band 1024) { throw "reparse point" }',
  '    if ($item.Attributes -band 16) { $stack.Push($item) }',
  '  } }',
  '}',
].join('\n');

export async function checkedAclDirectory(dir, runFile, recursive = false, {
  deadline = Infinity,
  stage = 'ACL validation',
  timeoutMs = UNINSTALL_STAGE_TIMEOUT_MS,
  signal,
} = {}) {
  signal?.throwIfAborted();
  const target = await canonicalAclDirectory(dir, {
    deadline,
    stage,
    timeoutMs,
    signal,
  });
  // The native walk checks reparse attributes before this process traverses
  // anything below the root. Hard-linked files are checked in walkAclTree only
  // after their parent DACL has been locked, which avoids a JavaScript tree
  // walk following a reparse tag that lstat did not classify as a symlink.
  const timeout = Number.isFinite(deadline)
    ? remainingStageMs(deadline, stage, timeoutMs)
    : 120_000;
  const result = await runFile(WINDOWS_POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', CHECK_ATTRIBUTES], {
    env: { EZ_ACL_TARGET: target, EZ_ACL_TREE: recursive ? '1' : '0' },
    timeout,
  });
  remainingStageMs(deadline, stage, timeoutMs);
  signal?.throwIfAborted();
  if (!result.success) {
    // Keep what the native check said: an "Access is denied." here is the
    // difference between a folder whose DACL denies the walk (recoverable by
    // taking ownership) and a real reparse point (never touched).
    const detail = `${result.stdout ?? ''} ${result.stderr ?? ''}`.trim().slice(0, 300);
    throw new Error(`could not verify directory attributes: ${detail || 'found a reparse point or an unreadable folder'}`);
  }
  return target;
}

/**
 * Applies a caller-supplied ACL operation without recursive icacls.
 *
 * The root is preflighted first. The walk then rewrites each directory's ACL
 * before reading its children. Once that operation removes ordinary-user write
 * access, the entries it enumerates cannot be replaced by the account whose
 * race this protects against. Files are checked for hard links immediately
 * after their now-protected parent is locked and before their own ACL changes.
 *
 * @param {string} root
 * @param {(target: string, kind: 'directory'|'file', stat: fs.Stats) => Promise<void>} visit
 * @param {{ runFile?: Function, fsApi?: typeof fs }} [opts]
 */
export async function walkAclTree(root, visit, {
  runFile = shellRunFile,
  fsApi = fs,
  deadline = Infinity,
  stage = 'ACL update',
  timeoutMs = UNINSTALL_STAGE_TIMEOUT_MS,
  signal,
} = {}) {
  const canonical = await checkedAclDirectory(root, runFile, true, {
    deadline, stage, timeoutMs, signal,
  });
  const pending = [canonical];

  while (pending.length > 0) {
    remainingStageMs(deadline, stage, timeoutMs);
    signal?.throwIfAborted();
    const directory = pending.pop();
    // The parent is locked before this check, so it cannot have been swapped
    // for another native reparse tag by the account this operation removes.
    await checkedAclDirectory(directory, runFile, false, {
      deadline, stage, timeoutMs, signal,
    });
    const directoryStat = await fsApi.promises.lstat(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new Error(`refusing a reparse point or non-directory at ${directory}`);
    }
    await visit(directory, 'directory', directoryStat);

    let entries;
    try {
      entries = await fsApi.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw new Error(`could not inspect ${directory}: ${error.message}`);
    }

    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      // Executable subtrees have their own protected root and RX policy.
      if (sameDirectory(directory, programDataDir()) &&
          ['bin', 'runtime', 'runtime.prev'].includes(entry.name.toLowerCase())) continue;
      let stat;
      try {
        stat = await fsApi.promises.lstat(target);
      } catch (error) {
        throw new Error(`could not inspect ${target}: ${error.message}`);
      }
      if (stat.isSymbolicLink()) {
        throw new Error(`refusing a reparse point at ${target}`);
      }
      if (stat.isDirectory()) {
        pending.push(target);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`refusing a non-file entry at ${target}`);
      }
      if (stat.nlink > 1) {
        throw new Error(`refusing a hard-linked file in the approved directory: ${target}`);
      }
      await visit(target, 'file', stat);
    }
  }

  return canonical;
}

/**
 * Validate a complete ACL tree before one recursive revoke.
 *
 * The recursive revoke is one direct icacls process rather than hundreds of
 * processes. `/L` acts on links themselves, and this pass refuses every native
 * reparse point and hard-linked file before icacls runs. The deadline is
 * checked throughout the scan, so a large tree cannot hold uninstall open.
 */
export async function validateAclTreeForBulkRevoke(root, {
  runFile = shellRunFile,
  fsApi = fs,
  deadline = Infinity,
  stage = 'Removing service-account permissions',
  timeoutMs = UNINSTALL_STAGE_TIMEOUT_MS,
  signal,
} = {}) {
  const canonical = await checkedAclDirectory(root, runFile, true, {
    deadline, stage, timeoutMs, signal,
  });
  const pending = [canonical];

  while (pending.length) {
    remainingStageMs(deadline, stage, timeoutMs);
    signal?.throwIfAborted();
    const directory = pending.pop();
    const directoryStat = await fsApi.promises.lstat(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new Error(`refusing a reparse point or non-directory at ${directory}`);
    }

    let entries;
    try {
      entries = await fsApi.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw new Error(`could not inspect ${directory}: ${error.message}`);
    }

    for (const entry of entries) {
      remainingStageMs(deadline, stage, timeoutMs);
      signal?.throwIfAborted();
      const target = path.join(directory, entry.name);
      const stat = await fsApi.promises.lstat(target);
      if (stat.isSymbolicLink()) {
        throw new Error(`refusing a reparse point at ${target}`);
      }
      if (stat.isDirectory()) {
        pending.push(target);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`refusing a non-file entry at ${target}`);
      }
      if (stat.nlink > 1) {
        throw new Error(`refusing a hard-linked file in the approved directory: ${target}`);
      }
    }
  }

  return canonical;
}

/** Read independent approvals from the machine environment (HKLM), never the operator database. */
export async function approvedGrantDirs(runFile) {
  const keys = ['EASY_DEVOPS_APPROVED_NGINX_DIR', 'EASY_DEVOPS_APPROVED_SSL_DIR'];
  const dirs = [programDataDir()];
  for (const [i, key] of keys.entries()) {
    const result = await runFile(WINDOWS_POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command',
      `[Environment]::GetEnvironmentVariable('${key}', 'Machine')`], { timeout: 20_000 });
    if (result.success) dirs.push(result.stdout.trim() || ['C:\\nginx', 'C:\\easy-devops\\ssl'][i]);
  }
  return dirs;
}

async function changeGrants({ grants, approvedDirs, runFile, revoke, log }) {
  const applied = [], failed = [];
  let needsElevation = false;
  const approved = approvedDirs ?? await approvedGrantDirs(runFile);
  for (const grant of grants) {
    try {
      const dir = grant.path;
      if (!approved.some(base => typeof dir === 'string' && path.isAbsolute(dir)
          && path.relative(base, dir) === '')) {
        throw new Error('directory lacks administrator approval; set the matching machine-level '
          + 'EASY_DEVOPS_APPROVED_NGINX_DIR or EASY_DEVOPS_APPROVED_SSL_DIR and run ezz service repair');
      }
      const machine = programDataDir();
      const canonical = await checkedAclDirectory(dir, runFile, false);
      if (['runtime', 'runtime.prev', 'bin'].some(name => inside(canonical, path.join(machine, name)))) {
        throw new Error('Service code directories cannot receive a data grant');
      }
      await walkAclTree(canonical, async (target, kind) => {
        // Inherit Modify into ordinary children. Protected bin/runtime DACLs
        // remain read-only and are rejected before the walk begins.
        const args = revoke
          ? [target, '/remove:g', SERVICE_ACCOUNT]
          : [target, '/grant', `${SERVICE_ACCOUNT}:${kind === 'directory' ? '(OI)(CI)' : ''}M`];
        const result = await runFile(systemTool('icacls.exe'), [...args, '/L', '/Q'], { timeout: 120_000 });
        if (!result.success) {
          const output = `${result.stdout ?? ''} ${result.stderr ?? ''}`.trim();
          if (/access is denied/i.test(output)) needsElevation = true;
          throw new Error(output.slice(0, 300) || 'icacls failed');
        }
      }, { runFile });
      applied.push(grant);
      log(`  ${canonical}: ${revoke ? 'removed service grant' : 'granted Modify'}`);
    } catch (err) {
      failed.push({ ...grant, reason: err.message });
      log(`  ${grant.path}: ${err.message}`);
    }
  }
  return { ok: !failed.length, applied, failed, needsElevation };
}

export function applyGrants({ grants, approvedDirs, runFile = shellRunFile, log = () => {} }) {
  return changeGrants({ grants, approvedDirs, runFile, log, revoke: false });
}

export async function revokeGrants({
  paths,
  approvedDirs,
  runFile = shellRunFile,
  log = () => {},
  deadline = Infinity,
  timeoutMs = UNINSTALL_STAGE_TIMEOUT_MS,
  signal,
  trustee = SERVICE_ACCOUNT,
}) {
  const removed = [];
  const failed = [];
  let needsElevation = false;
  remainingStageMs(deadline, 'Removing service-account permissions', timeoutMs);
  signal?.throwIfAborted();
  if (trustee !== SERVICE_ACCOUNT
      && !/^\*S-1-5-80-\d+-\d+-\d+-\d+-\d+$/.test(trustee)) {
    throw new Error('refusing an unusual service-account trustee');
  }
  const approved = approvedDirs ?? await approvedGrantDirs(runFile);
  remainingStageMs(deadline, 'Removing service-account permissions', timeoutMs);
  signal?.throwIfAborted();

  for (const dir of paths.filter(Boolean)) {
    try {
      signal?.throwIfAborted();
      if (!approved.some(base => typeof dir === 'string' && path.isAbsolute(dir)
          && path.relative(base, dir) === '')) {
        throw new Error('directory lacks administrator approval');
      }
      const machine = programDataDir();
      const canonical = await validateAclTreeForBulkRevoke(dir, {
        runFile, deadline, timeoutMs, signal,
      });
      if (['runtime', 'runtime.prev', 'bin'].some(name => inside(canonical, path.join(machine, name)))) {
        throw new Error('Service code directories cannot receive a data revoke');
      }
      const timeout = Number.isFinite(deadline)
        ? remainingStageMs(deadline, 'Removing service-account permissions', timeoutMs)
        : 120_000;
      signal?.throwIfAborted();
      const result = await runFile(systemTool('icacls.exe'), [
        canonical, '/remove:g', trustee, '/T', '/L', '/Q',
      ], { timeout });
      remainingStageMs(deadline, 'Removing service-account permissions', timeoutMs);
      signal?.throwIfAborted();
      if (!result.success) {
        const output = `${result.stdout ?? ''} ${result.stderr ?? ''}`.trim();
        if (/access is denied/i.test(output)) needsElevation = true;
        throw new Error(output.slice(0, 300) || 'icacls failed');
      }
      removed.push(dir);
      log(`  ${canonical}: removed service grant`);
    } catch (error) {
      if (error?.code === 'EZ_STAGE_TIMEOUT' || signal?.aborted) throw error;
      failed.push({ path: dir, reason: error.message });
      log(`  ${dir}: ${error.message}`);
    }
  }

  return { ok: failed.length === 0, removed, failed, needsElevation };
}

/**
 * Whether the paths granted at install still match the live Settings.
 *
 * This is the check that catches the realistic failure: the user installs the
 * service, then later changes `nginxDir` in Settings, and the service can no
 * longer read the directory it is being asked to manage. Nothing detects that
 * on its own, so it is compared explicitly and surfaced by `status`.
 *
 * @param {Object} opts
 * @param {string[]} opts.granted  Paths recorded at install time
 * @param {Array} opts.required    From requiredGrants() with the current config
 * @returns {{ ok: boolean, missing: string[], stale: string[], reason: string|null }}
 */
export function compareGrants({ granted = [], required = [] } = {}) {
  const norm = (p) => path.resolve(p).toLowerCase();
  const grantedSet = new Set(granted.filter(Boolean).map(norm));
  const requiredSet = new Set(required.map((g) => g.path).filter(Boolean).map(norm));

  const missing = [...requiredSet].filter((p) => !grantedSet.has(p));
  const stale = [...grantedSet].filter((p) => !requiredSet.has(p));

  if (missing.length === 0 && stale.length === 0) {
    return { ok: true, missing: [], stale: [], reason: null };
  }

  const parts = [];
  if (missing.length) {
    parts.push(
      `the service has no access to ${missing.join(', ')} — a path in Settings changed since it was installed`,
    );
  }
  if (stale.length) {
    parts.push(`it still has access to ${stale.join(', ')}, which it no longer needs`);
  }

  return {
    ok: false,
    missing,
    stale,
    reason: `${parts.join('; ')}. Run \`ezz service repair\` in an Administrator PowerShell to fix the permissions.`,
  };
}
