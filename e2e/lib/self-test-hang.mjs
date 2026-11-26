/**
 * e2e/lib/self-test-hang.mjs — the fixture behind `node e2e/run.mjs --self-test-timeout`.
 *
 * It is deliberately NOT a suite and deliberately not named `*.test.mjs`: it
 * lives in e2e/lib, so `listSuites()` never discovers it and a normal run can
 * never hang on it.
 *
 * What it does:
 *   1. spawns a long-lived child — so the runner has a real process tree to
 *      kill, not just one process — and writes that child's pid to
 *      EZ_SELF_TEST_PID_FILE;
 *   2. prints one group/step header, which the runner must quote back in the
 *      failure line;
 *   3. waits forever, which is what the runner's timeout is there for.
 *
 * The self-test asserts the FAIL line names this suite and this step, and that
 * both processes are gone afterwards.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';

const pidFile = process.env.EZ_SELF_TEST_PID_FILE;

const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
  windowsHide: true,
});

if (pidFile) fs.writeFileSync(pidFile, String(child.pid));

process.stdout.write('   self-test fixture: one step line, then it waits forever\n');
process.stdout.write('\n-- 1. self-test step\n');

setInterval(() => {}, 1000);
