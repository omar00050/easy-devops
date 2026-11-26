#!/usr/bin/env node
/**
 * e2e/lib/fake-icacls.mjs
 *
 * A stand-in for `icacls.exe` that behaves like the real one, driven as a REAL
 * child process:
 *
 *   node e2e/lib/fake-icacls.mjs <icacls args...>
 *
 * Environment:
 *   EZ_FAKE_ICACLS_STATE   path to the JSON state file (required)
 *
 * Why a separate executable rather than a `runFile` stub
 * ------------------------------------------------------
 * 1.4.7 failed on a real Windows Server because the ACL read-back ran
 * `icacls <root>\* /T /C` over an 11,000-file runtime (4-7 MB of output) and
 * parsed it from `core/shell.js`'s 64 KiB captured tail, which holds the NEWEST
 * bytes. `icacls` lists a folder's own matches before descending, so
 * `runtime\node.exe` (entry ~2) was already gone by the time the code looked.
 * The old e2e fake (e2e/service-upgrade-matrix.test.mjs) returned everything
 * from an in-process stub and sorted paths globally, so neither the truncation
 * nor the ordering could ever show.
 *
 * This fake therefore runs as its own process, over a REAL tree on disk, and
 * prints output in the real order and the real size, so a suite can drive it
 * through the real `core/shell.js` `runFile` and the capture tail applies
 * exactly as it does on a server.
 *
 * Real output it reproduces
 * -------------------------
 *   - one entry per object: `<path> <first ACE>`, further ACEs indented to the
 *     path width, then a blank line (`icacls` aligns every ACE under the path);
 *   - inherited ACEs marked `(I)` FIRST, then the inheritance flags, then the
 *     access level: `NT AUTHORITY\SYSTEM:(I)(OI)(CI)(F)`;
 *   - a file entry carries no `(OI)(CI)` (icacls does not print inheritance
 *     flags on files);
 *   - an object with an empty DACL is the bare path with no ACE line at all;
 *   - enumeration order for `<dir>\* /T`: the folder's own matches first
 *     (alphabetical, files and folders mixed), THEN each subfolder's contents
 *     recursively in the same way. This is the order that pushed node.exe out
 *     of the captured tail; a global sort (the old fake) hides the bug;
 *   - the summary line: `Successfully processed N files; Failed processing M files`.
 *
 * ACL model
 * ---------
 * Inheritance is COMPUTED, not stored: a child whose record says `inherit:
 * true` (the default for any path with no record) shows the ACEs of its nearest
 * protected ancestor as `(I)` entries. That is how `/reset /T` restores a
 * child's access after `/inheritance:r` on its folder, and why a file whose DACL
 * is empty and which no longer inherits cannot be reset until its owner is
 * Administrators (a DACL with no ACEs grants nobody WRITE_DAC).
 *
 * Verbs implemented: listing with and without /T, /save, /restore, /setowner,
 * /grant, /grant:r, /deny, /remove, /remove:g, /remove:d, /inheritance:r|e|d,
 * /reset, /verify. Flags /T, /C, /L, /Q, /M, /F, /B are accepted. Anything else
 * is recorded in `unknownVerbs` so a suite can report it instead of the fake
 * quietly accepting a verb it does not model.
 *
 * The state file holds only what DIFFERS from the default (no explicit ACEs,
 * inheriting), so a healthy 11,000-file tree costs five records, not 11,000.
 * Per-invocation bookkeeping (`calls`, watched-path snapshots, output size) is
 * what the suite asserts on.
 */

import fs from 'node:fs';
import path from 'node:path';

const STATE_ENV = 'EZ_FAKE_ICACLS_STATE';
const IS_WINDOWS = process.platform === 'win32';

/** Tokens after the target that are flags, never values. */
const FLAG_TOKENS = new Set(['/T', '/C', '/L', '/Q', '/M', '/F', '/B', '/D']);

/** The verbs this fake models. Matched exactly, so a grant spec's colons are safe. */
const VERB_TOKENS = new Set([
  '/save', '/restore', '/setowner', '/grant', '/grant:r', '/deny',
  '/remove', '/remove:g', '/remove:d',
  '/inheritance:r', '/inheritance:e', '/inheritance:d',
  '/reset', '/verify', '/setintegritylevel', '/substitute',
]);

const SID_NAMES = new Map([
  ['S-1-5-18', 'NT AUTHORITY\\SYSTEM'],
  ['S-1-5-19', 'NT AUTHORITY\\LOCAL SERVICE'],
  ['S-1-5-20', 'NT AUTHORITY\\NETWORK SERVICE'],
  ['S-1-5-32-544', 'BUILTIN\\Administrators'],
  ['S-1-5-32-545', 'BUILTIN\\Users'],
  ['S-1-5-11', 'NT AUTHORITY\\Authenticated Users'],
  ['S-1-1-0', 'Everyone'],
  ['S-1-3-0', 'CREATOR OWNER'],
]);

// ─── paths ───────────────────────────────────────────────────────────────────

/**
 * The code under test composes paths with `path.win32.join` even when it runs
 * off Windows (its ACL code is Windows-only), so a POSIX run hands us
 * `/tmp/x/runtime\app\node.exe`. Interpret backslashes as separators there: the
 * names this fake sees are suite-controlled and never contain one.
 */
function nativePath(value) {
  const text = String(value ?? '');
  return IS_WINDOWS ? text : text.replace(/\\/g, '/');
}

/** The key a path is stored under: absolute, and case-folded on Windows. */
function keyOf(value) {
  const resolved = path.resolve(nativePath(value));
  return IS_WINDOWS ? resolved.toLowerCase() : resolved;
}

function byName(left, right) {
  const a = path.basename(left).toLowerCase();
  const b = path.basename(right).toLowerCase();
  if (a !== b) return a < b ? -1 : 1;
  return left < right ? -1 : (left > right ? 1 : 0);
}

// ─── state ───────────────────────────────────────────────────────────────────

function loadState(file) {
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state.paths ??= {};
  state.calls ??= [];
  state.rules ??= {};
  state.stats ??= {};
  state.unknownVerbs ??= [];
  return state;
}

function saveState(file, state) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state));
  fs.renameSync(temp, file);
}

// ─── the DACL model ──────────────────────────────────────────────────────────

function recordOf(state, target) {
  return state.paths[keyOf(target)] ?? null;
}

function trusteeName(state, value) {
  const raw = String(value ?? '').trim().replace(/^\*/, '');
  const operatorSid = String(state.operator?.sid ?? '').toUpperCase();
  if (operatorSid && raw.toUpperCase() === operatorSid) {
    return state.operator?.name ?? raw;
  }
  return SID_NAMES.get(raw.toUpperCase()) ?? raw;
}

const trusteeKey = (state, value) => trusteeName(state, value).toUpperCase();

/** Whether an ACE written on a folder reaches an object of this type. */
function appliesTo(ace, isDirectory) {
  const flags = ace.flags ?? [];
  return isDirectory
    ? (flags.includes('CI') || flags.includes('OI'))
    : flags.includes('OI');
}

/**
 * Every ACE that applies to one object: its own explicit ones, then the ones it
 * inherits from the nearest ancestor that still inherits.
 *
 * @returns {Array<{ trustee: string, level: string, flags: string[], inherited: boolean }>}
 */
function effectiveAces(state, target, isDirectory) {
  const key = keyOf(target);
  const entry = state.paths[key] ?? null;
  const aces = (entry?.explicit ?? []).map((ace) => ({ ...ace, flags: [...(ace.flags ?? [])], inherited: false }));

  if (!entry || entry.inherit !== false) {
    let directory = path.dirname(path.resolve(nativePath(target)));
    const visited = new Set();
    while (directory && !visited.has(directory)) {
      visited.add(directory);
      const ancestor = state.paths[keyOf(directory)] ?? null;
      if (ancestor) {
        for (const ace of ancestor.explicit ?? []) {
          if (appliesTo(ace, isDirectory)) {
            aces.push({ ...ace, flags: [...(ace.flags ?? [])], inherited: true });
          }
        }
        if (ancestor.inherit === false) break;
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }

  // Group (f): the read-back loses one ACE, which is exactly what a broken
  // verification must notice. The state itself is untouched.
  const hidden = state.rules.hideAces ?? [];
  if (hidden.length === 0) return aces;
  return aces.filter((ace) => !hidden.some((rule) => keyOf(rule.path) === key
    && trusteeKey(state, rule.trustee) === trusteeKey(state, ace.trustee)));
}

/** One ACE as icacls prints it. */
function renderAce(state, ace, isDirectory) {
  const flags = (ace.flags ?? [])
    .filter((flag) => isDirectory || !['OI', 'CI', 'IO'].includes(flag))
    .map((flag) => `(${flag})`)
    .join('');
  return `${trusteeName(state, ace.trustee)}:${ace.inherited ? '(I)' : ''}${flags}(${ace.level})`;
}

// ─── tree walking ────────────────────────────────────────────────────────────

/** Real icacls order: a folder's own matches first, then each subfolder. */
function childrenOf(directory) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .map((entry) => ({ path: path.join(directory, entry.name), isDir: entry.isDirectory() }))
    .sort((left, right) => byName(left.path, right.path));
}

function descendantsOf(directory) {
  const found = [];
  const visit = (current) => {
    const children = childrenOf(current);
    for (const child of children) found.push(child);
    for (const child of children) {
      if (child.isDir) visit(child.path);
    }
  };
  visit(path.resolve(directory));
  return found;
}

/**
 * What a target denotes: `<dir>\*` means its children, a bare path means itself
 * (plus everything below it with /T, which is what real icacls does).
 */
function targetsOf(target, recursive) {
  const text = nativePath(target);
  const wildcard = /[\\/]\*$/.test(text);
  const base = path.resolve(wildcard ? text.replace(/[\\/]\*$/, '') : text);

  if (wildcard) return recursive ? descendantsOf(base) : childrenOf(base);

  let isDir = false;
  try {
    isDir = fs.statSync(base).isDirectory();
  } catch {
    return [];
  }
  if (!recursive || !isDir) return [{ path: base, isDir }];
  return [{ path: base, isDir: true }, ...descendantsOf(base)];
}

// ─── output ──────────────────────────────────────────────────────────────────

const SUMMARY = (processed, failed) =>
  `Successfully processed ${processed} files; Failed processing ${failed} files`;

/**
 * The listing for one set of targets, in real icacls format.
 *
 * The path is printed once, with the first ACE on the same line; every further
 * ACE is indented to the path width so it lines up under the first one; a blank
 * line separates entries. An empty DACL prints the bare path.
 */
function renderListing(state, targets) {
  const chunks = [];
  let processed = 0;
  let failed = 0;

  for (const target of targets) {
    let exists = true;
    try {
      fs.lstatSync(target.path);
    } catch {
      exists = false;
    }
    if (!exists) {
      failed += 1;
      chunks.push(`${target.path}\r\nThe system cannot find the file specified.\r\n\r\n`);
      continue;
    }

    const aces = effectiveAces(state, target.path, target.isDir);
    if (aces.length === 0) {
      // The broken state from the evidence: the path, and nothing else.
      chunks.push(`${target.path}\r\n\r\n`);
      processed += 1;
      continue;
    }

    const indent = ' '.repeat(target.path.length + 1);
    const rendered = aces.map((ace) => renderAce(state, ace, target.isDir));
    chunks.push(`${target.path} ${rendered[0]}\r\n`);
    for (let i = 1; i < rendered.length; i += 1) {
      chunks.push(`${indent}${rendered[i]}\r\n`);
    }
    chunks.push('\r\n');
    processed += 1;
  }

  chunks.push(`${SUMMARY(processed, failed)}\r\n`);
  return { stdout: chunks.join(''), processed, failed };
}

// ─── argument parsing ────────────────────────────────────────────────────────

function parseSpec(token) {
  const groups = [...String(token).matchAll(/\(([^()]*)\)/g)].map((match) => match[1].trim().toUpperCase());
  const flags = [];
  let level = null;
  for (const group of groups) {
    if (['OI', 'CI', 'IO', 'NP', 'I'].includes(group)) flags.push(group);
    else level = group;
  }
  if (!level) {
    const bare = String(token).replace(/\([^()]*\)/g, '').trim().toUpperCase();
    if (/^[A-Z]{1,3}$/.test(bare)) level = bare;
  }
  return level ? { level, flags } : null;
}

/** `*S-1-5-18:(OI)(CI)F` or `NT SERVICE\EasyDevOps:(OI)(CI)RX`. */
function parseGrantArg(state, argument) {
  const text = String(argument);
  const colon = text.lastIndexOf(':');
  if (colon <= 0) return null;
  const spec = parseSpec(text.slice(colon + 1));
  if (!spec) return null;
  return { trustee: trusteeName(state, text.slice(0, colon)), ...spec };
}

/** The first value token after `verb` that is not a flag. */
function valueAfter(args, verb) {
  const index = args.findIndex((argument) => String(argument).toLowerCase() === verb);
  for (let i = index + 1; i < args.length; i += 1) {
    if (!FLAG_TOKENS.has(String(args[i]).toUpperCase())) return args[i];
  }
  return null;
}

// ─── mutations ───────────────────────────────────────────────────────────────

function entryFor(state, target) {
  const key = keyOf(target);
  let entry = state.paths[key];
  if (!entry) {
    entry = { inherit: true, explicit: [] };
    state.paths[key] = entry;
  }
  return entry;
}

function defaultOwner(state, target) {
  try {
    if (fs.statSync(target).isDirectory()) return state.defaults?.folderOwner ?? 'BUILTIN\\Administrators';
  } catch { /* reported by the caller */ }
  return state.defaults?.fileOwner ?? state.operator?.sid ?? 'BUILTIN\\Administrators';
}

function ownerOf(state, target) {
  return state.paths[keyOf(target)]?.owner ?? defaultOwner(state, target);
}

function sameAce(left, right) {
  return left.level === right.level
    && [...(left.flags ?? [])].sort().join(',') === [...(right.flags ?? [])].sort().join(',');
}

function applyGrant(state, targets, specs, { replace = false } = {}) {
  const named = new Set(specs.map((spec) => spec.trustee.toUpperCase()));
  for (const target of targets) {
    const entry = entryFor(state, target.path);
    if (replace) entry.explicit = entry.explicit.filter((ace) => !named.has(String(ace.trustee).toUpperCase()));
    for (const spec of specs) {
      const already = entry.explicit.some((ace) => String(ace.trustee).toUpperCase() === spec.trustee.toUpperCase()
        && sameAce(ace, spec));
      if (!already) entry.explicit.push({ trustee: spec.trustee, level: spec.level, flags: [...spec.flags] });
    }
  }
}

function removeAce(state, targets, trustee) {
  const wanted = String(trustee).toUpperCase();
  for (const target of targets) {
    const entry = state.paths[keyOf(target.path)];
    if (!entry) continue;
    entry.explicit = entry.explicit.filter((ace) => String(ace.trustee).toUpperCase() !== wanted);
  }
}

// ─── the command ─────────────────────────────────────────────────────────────

function run(state, args) {
  const target = args[0];
  const recursive = args.some((argument) => String(argument).toUpperCase() === '/T');
  const verbToken = args.find((argument) => VERB_TOKENS.has(String(argument).toLowerCase()));
  const verb = verbToken ? String(verbToken).toLowerCase() : null;

  if (!verb) {
    const listing = renderListing(state, targetsOf(target, recursive));
    return {
      success: listing.failed === 0,
      stdout: listing.stdout,
      stderr: '',
      processed: listing.processed,
      failed: listing.failed,
      bytes: Buffer.byteLength(listing.stdout, 'utf8'),
    };
  }

  const targets = targetsOf(target, recursive);

  if (verb === '/save') {
    const file = valueAfter(args, '/save');
    if (!file) return { success: false, stdout: '', stderr: 'Invalid parameter\r\n', processed: 0, failed: 0, bytes: 0 };
    const entries = targets.map((entry) => {
      const record = state.paths[keyOf(entry.path)];
      return {
        path: entry.path,
        isDir: entry.isDir,
        owner: ownerOf(state, entry.path),
        inherit: record ? record.inherit !== false : true,
        explicit: (record?.explicit ?? []).map((ace) => ({ ...ace, flags: [...(ace.flags ?? [])] })),
      };
    });
    fs.writeFileSync(file, JSON.stringify({ target: path.resolve(nativePath(target)), entries }));
    // The saved copy of every watched path that this save actually covered,
    // carried in the call record: the code deletes its temp file before the
    // suite could read it, and a restore assertion needs the exact bytes the
    // code could have restored from.
    const savedWatch = (state.watch ?? [])
      .filter((watched) => entries.some((entry) => keyOf(entry.path) === keyOf(watched)))
      .map((watched) => {
        const record = state.paths[keyOf(watched)];
        return {
          path: watched,
          owner: ownerOf(state, watched),
          inherit: record ? record.inherit !== false : true,
          explicit: (record?.explicit ?? []).map((ace) => ({ ...ace, flags: [...(ace.flags ?? [])] })),
        };
      });
    return {
      success: true,
      stdout: `${SUMMARY(entries.length, 0)}\r\n`,
      stderr: '',
      processed: entries.length,
      failed: 0,
      bytes: 0,
      saved: entries.length,
      savedWatch,
    };
  }

  if (verb === '/restore') {
    const file = valueAfter(args, '/restore');
    if (!file) return { success: false, stdout: '', stderr: 'Invalid parameter\r\n', processed: 0, failed: 0, bytes: 0 };
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    const parent = path.resolve(nativePath(target));
    let restored = 0;
    for (const record of payload.entries ?? []) {
      const inside = record.path === parent
        || record.path.toLowerCase().startsWith(`${parent.toLowerCase()}${path.sep}`);
      if (!inside) continue;
      state.paths[keyOf(record.path)] = {
        owner: record.owner,
        inherit: record.inherit !== false,
        explicit: (record.explicit ?? []).map((ace) => ({ ...ace, flags: [...(ace.flags ?? [])] })),
      };
      restored += 1;
    }
    return { success: true, stdout: `${SUMMARY(restored, 0)}\r\n`, stderr: '', processed: restored, failed: 0, bytes: 0, restored };
  }

  if (verb === '/setowner') {
    const owner = trusteeName(state, valueAfter(args, '/setowner'));
    let changed = 0;
    for (const entry of targets) {
      entryFor(state, entry.path).owner = owner;
      changed += 1;
    }
    return { success: true, stdout: `${SUMMARY(changed, 0)}\r\n`, stderr: '', processed: changed, failed: 0, bytes: 0 };
  }

  if (verb === '/grant' || verb === '/grant:r' || verb === '/deny') {
    const specs = args
      .filter((argument) => !FLAG_TOKENS.has(String(argument).toUpperCase()) && String(argument) !== verbToken)
      .map((argument) => parseGrantArg(state, argument))
      .filter(Boolean);
    if (specs.length === 0) {
      return { success: false, stdout: '', stderr: 'Invalid parameter\r\n', processed: 0, failed: 0, bytes: 0 };
    }
    if (verb === '/deny') {
      // A deny ACE is not rendered: the verified policy in this repository
      // never writes one (see core/service/operator.js's header).
      state.stats.denyAces = (state.stats.denyAces ?? 0) + specs.length;
      return { success: true, stdout: `${SUMMARY(targets.length, 0)}\r\n`, stderr: '', processed: targets.length, failed: 0, bytes: 0 };
    }
    applyGrant(state, targets, specs, { replace: verb === '/grant:r' });
    return { success: true, stdout: `${SUMMARY(targets.length, 0)}\r\n`, stderr: '', processed: targets.length, failed: 0, bytes: 0 };
  }

  if (verb === '/remove' || verb === '/remove:g' || verb === '/remove:d') {
    removeAce(state, targets, valueAfter(args, verb));
    return { success: true, stdout: `${SUMMARY(targets.length, 0)}\r\n`, stderr: '', processed: targets.length, failed: 0, bytes: 0 };
  }

  if (verb === '/inheritance:r' || verb === '/inheritance:e') {
    const inherit = verb === '/inheritance:e';
    for (const entry of targets) entryFor(state, entry.path).inherit = inherit;
    return { success: true, stdout: `${SUMMARY(targets.length, 0)}\r\n`, stderr: '', processed: targets.length, failed: 0, bytes: 0 };
  }

  if (verb === '/inheritance:d') {
    // "Remove inherited ACEs but keep copies": what the flag leaves behind is
    // an explicit copy of the effective list. Not written by this repository.
    for (const entry of targets) {
      const entryRecord = entryFor(state, entry.path);
      entryRecord.explicit = effectiveAces(state, entry.path, entry.isDir)
        .map((ace) => ({ trustee: ace.trustee, level: ace.level, flags: [...(ace.flags ?? [])] }));
      entryRecord.inherit = false;
    }
    state.unknownVerbs.push('/inheritance:d');
    return { success: true, stdout: `${SUMMARY(targets.length, 0)}\r\n`, stderr: '', processed: targets.length, failed: 0, bytes: 0 };
  }

  if (verb === '/reset') {
    const denied = new Set((state.rules.denyReset ?? []).map((value) => keyOf(value)));
    const admins = trusteeKey(state, 'BUILTIN\\Administrators');
    if (state.rules.denyResetAll) {
      for (const entry of targets) denied.add(keyOf(entry.path));
    }

    let changed = 0;
    const refused = [];
    for (const entry of targets) {
      const key = keyOf(entry.path);
      // `/reset` needs WRITE_DAC. A DACL with no ACEs grants nobody that, and
      // only the owner may rewrite it - so a file owned by the installing user
      // cannot be reset until Administrators own it. That is the evidence's A1.
      const cannotWrite = denied.has(key)
        || (trusteeKey(state, ownerOf(state, entry.path)) !== admins
          && effectiveAces(state, entry.path, entry.isDir).length === 0);
      if (cannotWrite) {
        refused.push(entry.path);
        continue;
      }
      state.paths[key] = { inherit: true, explicit: [] };
      changed += 1;
    }

    if (refused.length > 0) {
      const output = `${refused.slice(0, 3).map((value) => `${value}\r\nAccess is denied.\r\n`).join('')}`
        + `${SUMMARY(changed, refused.length)}\r\n`;
      return { success: false, stdout: output, stderr: '', processed: changed, failed: refused.length, bytes: 0, refused };
    }
    return { success: true, stdout: `${SUMMARY(changed, 0)}\r\n`, stderr: '', processed: changed, failed: 0, bytes: 0 };
  }

  if (verb === '/verify') {
    return { success: true, stdout: `${SUMMARY(targets.length, 0)}\r\n`, stderr: '', processed: targets.length, failed: 0, bytes: 0 };
  }

  // /setintegritylevel, /substitute: not modelled, recorded for the suite.
  state.unknownVerbs.push(verb);
  return { success: true, stdout: `${SUMMARY(targets.length, 0)}\r\n`, stderr: '', processed: targets.length, failed: 0, bytes: 0 };
}

// ─── entry point ─────────────────────────────────────────────────────────────

function main() {
  const statePath = process.env[STATE_ENV];
  if (!statePath) {
    process.stderr.write(`fake-icacls: ${STATE_ENV} is not set; refusing to guess at an ACL state\n`);
    process.exitCode = 2;
    return;
  }

  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write('fake-icacls: no arguments\n');
    process.exitCode = 2;
    return;
  }

  const state = loadState(statePath);
  const result = run(state, args);

  const recursive = args.some((argument) => String(argument).toUpperCase() === '/T');
  const verbToken = args.find((argument) => VERB_TOKENS.has(String(argument).toLowerCase()));
  const verb = verbToken ? String(verbToken).toLowerCase() : null;

  state.stats.invocations = (state.stats.invocations ?? 0) + 1;
  if (verb === null) {
    state.stats.listings = (state.stats.listings ?? 0) + 1;
    state.stats.lastListingBytes = result.bytes ?? 0;
    state.stats.lastListingEntries = result.processed ?? 0;
    if (recursive) state.stats.lastRecursiveBytes = result.bytes ?? 0;
  }

  // A snapshot of the watched paths AFTER this invocation: group (g) asserts
  // SYSTEM and Administrators never lose full control at any intermediate step.
  const watch = state.watch ?? [];
  const snapshot = watch.map((target) => {
    let isDir = false;
    try { isDir = fs.statSync(target).isDirectory(); } catch { /* recorded as absent */ }
    return {
      path: target,
      aces: effectiveAces(state, target, isDir).map((ace) => renderAce(state, ace, isDir)),
    };
  });

  const call = {
    seq: state.calls.length + 1,
    args: [...args],
    verb,
    hasT: recursive,
    exitCode: result.success ? 0 : 1,
    bytes: result.bytes ?? 0,
    snapshot,
  };
  if (result.saved !== undefined) call.saved = result.saved;
  if (result.savedWatch) call.savedWatch = result.savedWatch;
  if (result.restored !== undefined) call.restored = result.restored;
  if (result.refused) call.refused = result.refused;
  state.calls.push(call);

  saveState(statePath, state);

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.success ? 0 : 1;
}

main();
