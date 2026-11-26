/**
 * e2e/lib/self-test-report.mjs — fixture for `node e2e/run.mjs --self-test-report`.
 *
 * NOT a suite: it lives in e2e/lib, so `listSuites()` never discovers it.
 *
 * It prints whichever of the four shapes `EZ_SELF_TEST_CASE` selects, so the
 * reporting rules can be exercised without running (or editing) a real suite:
 *
 *   a          five checks and `TOTAL 5   PASS 5   FAIL 0`
 *   b          three checks and `TOTAL 3   PASS 3   FAIL 0`
 *   twototals  two TOTAL lines; the LAST one must win
 *   nosummary  three checks, exit 0, and no TOTAL line at all
 *   skipafter  `TOTAL n   PASS n   FAIL 0   SKIP 0` — SKIP printed AFTER FAIL
 *   verdict    one verdict at column 0 with a single space after PASS, printed
 *              between other log lines
 *
 * Every write goes out exactly the way a suite writes, and the last line is
 * followed by `process.exit()`, because that is the pattern that lost data on a
 * Windows pipe.
 */

const which = process.env.EZ_SELF_TEST_CASE ?? 'a';

function check(label) {
  process.stdout.write(`   PASS  ${label}\n`);
}

function total(checks, failed = 0) {
  process.stdout.write(`\nTOTAL ${checks}   PASS ${checks - failed}   FAIL ${failed}\n`);
}

process.stdout.write('\n-- 1. self-test report fixture\n');

if (which === 'a') {
  for (let i = 1; i <= 5; i++) check(`fixture a check ${i}`);
  total(5);
} else if (which === 'b') {
  for (let i = 1; i <= 3; i++) check(`fixture b check ${i}`);
  total(3);
} else if (which === 'twototals') {
  check('before the first total');
  total(4);
  check('between the totals');
  total(2);
} else if (which === 'nosummary') {
  for (let i = 1; i <= 3; i++) check(`fixture nosummary check ${i}`);
} else if (which === 'skipafter') {
  check('a plain check');
  process.stdout.write('   SKIP  a skipped group  (Windows only)\n');
  check('another plain check');
  process.stdout.write('\nTOTAL 4   PASS 3   FAIL 0   SKIP 1\n');
} else if (which === 'verdict') {
  process.stdout.write('[hubAgent] connecting to the test hub\n');
  check('a per-check line, which is not a verdict');
  process.stdout.write('[hubAgent] disconnected\n');
  // One space after PASS, at column 0 — nginx-domain-security prints this way.
  process.stdout.write('PASS typed domain fields, pre-write rejection, dashboard and Hub permissions\n');
} else {
  process.stderr.write(`unknown EZ_SELF_TEST_CASE '${which}'\n`);
  process.exit(2);
}

process.exit(0);
