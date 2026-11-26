/**
 * e2e/lib/report.mjs — one definition of what a skip looks like.
 *
 * Why this module exists
 * ----------------------
 * A suite answers "is this check skipped?" itself, in whatever way was
 * convenient when it was written, and `e2e/run.mjs` — the only sanctioned way
 * to run suites — then has to count those answers. That is only honest if the
 * runner and the suites agree on the shape of the answer, so the shape is
 * defined here once:
 *
 *   1. a suite that skips a group calls `skip(name, reason)`, which prints
 *        `   SKIP  <name>  (<reason>)`
 *      and nothing else. Suites written before this helper print the same line
 *      by hand, so both are counted the same way;
 *   2. a suite that skips one check inside a group prints it through its own
 *      `check()` as a pass whose detail starts with `skipped`
 *        `   PASS  <label>  (skipped: Windows only)`
 *      or says the tool is absent
 *        `   PASS  <label>  (no PowerShell on this machine; ...)`
 *      Both are a skip, not a pass, and are counted as skips;
 *   3. a suite that reports one verdict for the whole file (node:assert style)
 *      prints a column-0 line instead, which is described at length below.
 *
 * Why not only the suite's own TOTAL line: most suites count their skipped
 * checks as passes, so `TOTAL 40 PASS 40 FAIL 0` on Linux hides ten Windows
 * groups. Counting the skip lines and subtracting them is what makes the
 * Windows-only groups visible — which is the point of the reporting.
 *
 * Nothing here may guess. A skipped group reported as a failure would be
 * noise; a failure reported as a skip would be worse, so a FAIL line is a
 * failure whatever its detail says.
 *
 * The same line reader also keeps the last group/step header a suite printed
 * (`-- 1. …` / `── 2. …`), which is what makes a timeout actionable: the
 * runner names the step the suite had reached when it had to be killed.
 *
 * Suites load this before reaching src/ (it imports node builtins only), so it
 * is safe as a static import.
 */

import os from 'node:os';

// ─── The line a suite prints for a skipped group ─────────────────────────────

/** The exact prefix `skip()` writes. Anything matching this is one skip. */
export const SKIP_PREFIX = '   SKIP  ';

/**
 * The line for a skipped group, as a string.
 *
 * @param {string} name   What was skipped, e.g. 'the ACL transaction'
 * @param {string} reason Why, e.g. 'Windows only' — say why, not just that it was
 * @returns {string} Without a trailing newline
 */
export function skipLine(name, reason) {
  return `${SKIP_PREFIX}${name}  (${reason})`;
}

/**
 * Prints the canonical skip line for a group this suite did not run.
 *
 * Use it when the work is impossible here but is still required before a
 * release — the runner counts it and names it in the summary, so a Windows
 * group skipped on Linux cannot fall out of sight.
 *
 * @param {string} name
 * @param {string} reason
 */
export function skip(name, reason) {
  process.stdout.write(`${skipLine(name, reason)}\n`);
}

// ─── Reading a line back ─────────────────────────────────────────────────────

/**
 * A per-check line, as every `check()` helper in e2e/ prints it: three spaces,
 * PASS/FAIL/SKIP, two spaces, text.
 *
 * The leading whitespace is required on purpose. A suite that reports a single
 * verdict prints `PASS  <sentence>` at column 0, and counting that as a check
 * would invent a check count the suite never gave.
 */
const MARKER_LINE = /^\s+(PASS|FAIL|SKIP)[ \t]{2,}(.*)$/;

/** The detail a `check()` helper appends in parentheses. */
const TRAILING_DETAIL = /\(([^()]*)\)[ \t]*$/;

/**
 * Details that mean "this did not run here". Deliberately narrow:
 *   - `skipped…` — the convention every suite already uses;
 *   - `no <tool> on this machine…` — the same thing in words.
 * A detail that merely CONTAINS the word skipped (a JSON dump of stage names
 * such as `https:skipped`) is not a skip.
 */
const SKIP_DETAIL = /^(?:skipped\b|no [^()]*\bon this machine\b)/i;

/**
 * Splits the text of a SKIP line into its name and its reason.
 *
 * Three shapes are in use, all produced by a hand-written `skip()`:
 *   `the ACL transaction  (Windows only)`  — name and reason
 *   `systemd-analyze verify  — not on PATH` — name and reason, em dash
 *   `this filesystem has no POSIX permission bits` — a reason only
 *
 * @param {string} text
 * @returns {{ name: string, reason: string }}
 */
function splitSkipText(text) {
  const trailing = text.match(/^(.*?)[ \t]{2,}\((.*)\)[ \t]*$/);
  if (trailing) return { name: trailing[1].trim(), reason: trailing[2].trim() };

  const dashed = text.match(/^(.*?)\s+—\s+(.*)$/);
  if (dashed) return { name: dashed[1].trim(), reason: dashed[2].trim() };

  const bare = text.trim();
  return { name: bare, reason: bare };
}

/**
 * The reason as it should read in a summary.
 *
 * `skipped: Windows only` becomes `Windows only`; `skipped on Linux` becomes
 * `on Linux`. The word "skipped" is already in the label the runner prints.
 *
 * @param {string} text
 * @returns {string}
 */
export function cleanReason(text) {
  return String(text ?? '')
    .replace(/^skipped\b[: ]*\s*/i, '')
    .replace(/^—\s*/, '')
    .trim();
}

/**
 * Classifies one line of suite output.
 *
 * @param {string} line
 * @returns {{ kind: 'pass'|'fail'|'skip', name: string, reason: string }|null}
 *   null when the line says nothing about a check.
 */
export function classifyLine(line) {
  const marker = String(line ?? '').match(MARKER_LINE);
  if (!marker) return null;

  const [, kind, rest] = marker;

  if (kind === 'SKIP') {
    const { name, reason } = splitSkipText(rest);
    return { kind: 'skip', name, reason };
  }

  if (kind === 'PASS') {
    const detail = String(line).match(TRAILING_DETAIL)?.[1]?.trim();
    if (detail && SKIP_DETAIL.test(detail)) {
      return { kind: 'skip', name: rest.replace(TRAILING_DETAIL, '').trim(), reason: detail };
    }
    return { kind: 'pass', name: rest, reason: '' };
  }

  return { kind: 'fail', name: rest, reason: '' };
}

// ─── Counting one suite ──────────────────────────────────────────────────────

/**
 * A group/step header, as the suites print it: `-- 1. the ACL transaction`,
 * `── 2. the unit`, and so on. The run reports the last one before a timeout,
 * because "native-service timed out" says nothing an operator can act on —
 * "at step 10. the Personal-mode launcher" does.
 *
 * A line of only dashes or box-drawing characters (a separator) is not a step,
 * and neither is an option such as `--help` printed inside captured output:
 * both need whitespace after the run of characters.
 */
const STEP_LINE = /^\s*[-─—–═]{2,}\s+(\S.*?)\s*$/;

/**
 * Collects the counts for one suite from its output, line by line.
 *
 * `add()` takes lines in any order; `summary()` decides once the suite has
 * exited. Duplicate reasons are collapsed, so thirty Windows-only checks read
 * as one reason with a count.
 *
 * @param {{ maxReasons?: number }} [options]
 */
export function createSuiteCounter({ maxReasons = 20 } = {}) {
  const reasons = new Map();
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  /** The last group/step header seen, for a timeout report. */
  let step = null;

  /** The suite's own TOTAL line, when it prints one. */
  let total = null;
  /** A single-verdict suite's line (see the header). */
  let sentence = null;

  const note = (reason) => {
    const key = cleanReason(reason);
    if (!key) return;
    if (reasons.has(key)) reasons.set(key, reasons.get(key) + 1);
    else if (reasons.size < maxReasons) reasons.set(key, 1);
  };

  function add(rawLine) {
    const line = String(rawLine ?? '');

    const stepLine = line.match(STEP_LINE);
    if (stepLine) step = stepLine[1];

    // The suites' own summaries, in every shape they actually print:
    //
    //   TOTAL 42   PASS 42   FAIL 0                      (most suites)
    //   TOTAL 200  PASS 190  SKIP 10  FAIL 0             (service-upgrade-matrix,
    //                                                     systemd-unit, acl-large-tree,
    //                                                     acl-stream)
    //   TOTAL 67   PASS 67   FAIL 0   SKIP 0             (leftover-data)
    //
    // Any order, any spacing — a suite that happens to print SKIP after FAIL is
    // still a finished suite, and saying it "printed no summary" was wrong.
    // The last TOTAL line of a child wins; a later one replaces this.
    const suiteTotal = line.match(/^\s*TOTAL\s+(\d+)\b(.*)$/);
    if (suiteTotal) {
      const fields = {};
      for (const field of suiteTotal[2].matchAll(/\b(PASS|SKIP|FAIL)\s+(\d+)\b/g)) {
        fields[field[1]] = Number(field[2]);
      }
      if (fields.PASS !== undefined && fields.FAIL !== undefined) {
        total = {
          checks: Number(suiteTotal[1]),
          passed: fields.PASS,
          failed: fields.FAIL,
          skipped: fields.SKIP ?? null,
        };
        return;
      }
    }

    // deploy-keys prints `<n> PASS <failed> FAIL` — the second number is the
    // failure count, not the pass count.
    const looseTotal = line.match(/^\s*(\d+)\s+PASS\s+(\d+)\s+FAIL\s*$/);
    if (looseTotal) {
      const checks = Number(looseTotal[1]);
      const failures = Number(looseTotal[2]);
      total = { checks, passed: checks - failures, skipped: null, failed: failures };
      return;
    }

    const counted = classifyLine(line);
    if (counted) {
      if (counted.kind === 'pass') passed += 1;
      else if (counted.kind === 'fail') failed += 1;
      else {
        skipped += 1;
        note(counted.reason || counted.name);
      }
      return;
    }

    // ── Single-verdict suites (node:assert, or a `check()` that only counts) ──
    // They print at column 0, one sentence for the whole file:
    //   `PASS  daemon database opens ... (40 checks)`
    //   `PASS typed domain fields, pre-write rejection, ...`      — ONE space
    //   `FAIL  2 passed, 3 failed`
    // The column-0 anchor is what keeps a per-check line (`   PASS  ...`, which
    // starts with whitespace) out of this branch. The line is looked for
    // anywhere in the output, in any order, so interleaved `[hubAgent] ...` log
    // lines and the position of the verdict do not matter.
    const withCount = line.match(/^\s*(PASS|FAIL)[ \t]+.*\((\d+) checks?\)\s*$/);
    if (withCount) {
      const checks = Number(withCount[2]);
      sentence = withCount[1] === 'PASS'
        ? { checks, passed: checks, failed: 0 }
        : { checks, passed: 0, failed: checks };
      return;
    }

    const failCount = line.match(/^\s*FAIL[ \t]+(\d+) passed,\s*(\d+) failed\s*$/);
    if (failCount) {
      const p = Number(failCount[1]);
      const f = Number(failCount[2]);
      sentence = { checks: p + f, passed: p, failed: f };
      return;
    }

    if (/^\s*(PASS|FAIL)[ \t]+\S/.test(line)) {
      // A verdict, but how many checks it stands for is not stated. Count it
      // as the one verdict it is and say so in the summary.
      sentence = sentence ?? {
        coarse: true,
        passed: /^\s*PASS/.test(line) ? 1 : 0,
        failed: /^\s*FAIL/.test(line) ? 1 : 0,
      };
    }
  }

  /**
   * @returns {{
   *   passed: number, failed: number, skipped: number, checks: number,
   *   coarse: boolean, complete: boolean, verdictOnly: boolean,
   *   unknown: boolean, step: string|null,
   *   reasons: Array<{ reason: string, count: number }>,
   * }}
   *   `checks` always equals passed + failed + skipped, so a summary adds up.
   *   `complete` means the suite printed a TOTAL line — its own last word, and
   *   the proof that its output arrived whole. `verdictOnly` means it prints one
   *   verdict for the file instead (the node:assert style suites); the two are
   *   what stops a truncated suite from looking like a pass.
   *   `unknown` means the suite printed nothing this module can count.
   *   `step` is the last group/step header printed, for a timeout report.
   */
  function summary() {
    let p = passed;
    let f = failed;
    let s = skipped;
    let coarse = false;

    if (total && total.skipped !== null) {
      // The suite counted its own skips, so its numbers are the whole answer —
      // including the order it chose to print them in (`SKIP` before or after
      // `FAIL`).
      p = total.passed;
      f = total.failed;
      s = total.skipped;
    } else if (p + f + s === 0) {
      if (total) {
        // No per-check lines: the TOTAL is all there is, and it is authoritative.
        p = total.passed;
        f = total.failed;
        s = total.skipped ?? skipped;
      } else if (sentence) {
        p = sentence.passed ?? 0;
        f = sentence.failed ?? 0;
        coarse = sentence.coarse === true;
      }
    }

    return {
      passed: p,
      failed: f,
      skipped: s,
      checks: p + f + s,
      coarse,
      complete: total !== null,
      verdictOnly: total === null && sentence !== null,
      unknown: p + f + s === 0,
      step,
      reasons: [...reasons].map(([reason, count]) => ({ reason, count })),
    };
  }

  return { add, summary };
}

/**
 * The deduplicated skip reasons, most frequent first, at most `max` of them.
 *
 * @param {Array<{ reason: string, count: number }>} reasons
 * @param {number} [max]
 * @returns {string} e.g. `Windows only ×25; on Linux ×2 (+3 more)`
 */
export function describeReasons(reasons, max = 3) {
  const ordered = [...reasons].sort((a, b) => b.count - a.count);
  const shown = ordered.slice(0, max).map(({ reason, count }) => (
    count > 1 ? `${reason} ×${count}` : reason
  ));
  const rest = ordered.length - shown.length;
  if (rest > 0) shown.push(`(+${rest} more)`);
  return shown.join('; ');
}

/** The step a suite had reached, or a phrase for a suite that never printed one. */
export function stepLabel(step) {
  return step || 'before its first step';
}

/**
 * Why a suite was killed, without the verdict.
 *
 * @param {'wall'|'idle'} kind `wall`: it ran too long. `idle`: it printed
 *   nothing for too long.
 * @param {number} afterMs The limit that was crossed
 * @param {string|null} step The last step header the suite printed
 * @returns {string} e.g. `timed out after 600 s at step: 10. the launcher`
 */
export function timeoutReason(kind, afterMs, step) {
  const seconds = Math.round(afterMs / 1000);
  return kind === 'idle'
    ? `no output for ${seconds} s after step: ${stepLabel(step)}`
    : `timed out after ${seconds} s at step: ${stepLabel(step)}`;
}

/**
 * The line for a suite the runner had to kill. One shape, used by the summary
 * and asserted by `--self-test-timeout`.
 *
 * @param {string} name
 * @param {'wall'|'idle'} kind
 * @param {number} afterMs
 * @param {string|null} step
 * @returns {string} e.g. `native-service: FAIL (timed out after 600 s at step: 10. …)`
 */
export function timeoutLine(name, kind, afterMs, step) {
  return `${name}: FAIL (${timeoutReason(kind, afterMs, step)})`;
}

/**
 * The line for a suite that exited 0 without printing its summary.
 *
 * A suite's TOTAL line is the proof that its whole output arrived: every suite
 * writes it last. Its absence with exit 0 means the output was cut off —
 * ssl-preflight lost its last five groups and its TOTAL to a Windows pipe and
 * was reported as a pass — and a pass is exactly the wrong answer.
 *
 * @param {string} name
 * @returns {string} e.g. `ssl-preflight: FAIL (exited 0 but printed no summary line; …)`
 */
export function truncatedLine(name) {
  return `${name}: FAIL (exited 0 but printed no summary line; output may have been cut off)`;
}

// ─── Windows-only groups ─────────────────────────────────────────────────────

/**
 * Suites that hold groups which only run on Windows.
 *
 * Two sources, because neither is complete on its own:
 *
 *   - `WINDOWS_ONLY_SUITES` is written out by hand. A suite is here because
 *     running it on a real Windows machine is required before a release, and
 *     because its own skip wording ("no PowerShell on this machine") would not
 *     name Windows;
 *   - `WINDOWS_ONLY_SOURCE` catches a new suite that skips with the wording
 *     already in use, so a group cannot appear and stay invisible.
 *
 * `node e2e/run.mjs --windows-only` runs exactly this set.
 */
export const WINDOWS_ONLY_SUITES = Object.freeze([
  'daemon',
  'installer',
  'installer-standalone',
  'native-service',
  'runtime-update',
  'service-operator',
  'service-upgrade-matrix',
  'updater',
]);

/**
 * Source wording that marks a Windows-only group. Kept beside the list above
 * so both stay readable, and loose enough to match the phrases the suites
 * already use: `skipped on Linux`, `the Server-mode copy is Windows-only`,
 * `the runtime app copy is Windows-Server-only`, `not Windows`.
 */
export const WINDOWS_ONLY_SOURCE = /skipped on linux|windows[- ]server[- ]only|windows[- ]only|'not windows'/i;

/**
 * @param {string} name Suite name, without `.test.mjs`
 * @param {string} source The suite's text
 * @returns {boolean} Whether this suite holds Windows-only groups
 */
export function isWindowsOnlySuite(name, source) {
  return WINDOWS_ONLY_SUITES.includes(name) || WINDOWS_ONLY_SOURCE.test(String(source ?? ''));
}

/**
 * Names the machine a run happened on, for the line that says whether the
 * Windows-only groups actually ran.
 *
 * @returns {string} e.g. `win32 10.0.20348` or `linux 6.8.0-45-generic`
 */
export function hostLabel() {
  return `${os.platform()} ${os.release()}`;
}

/** True on the only kind of machine where a Windows-only group can run. */
export const ON_WINDOWS = os.platform() === 'win32';
