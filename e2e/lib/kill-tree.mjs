/**
 * e2e/lib/kill-tree.mjs — ending a suite's whole process tree.
 *
 * Why a tree, not a process
 * -------------------------
 * A suite that hangs is usually not the process that hates you: native-service
 * once left a Personal-mode supervisor that restarted forever, and killing only
 * the direct child would have left that supervisor alive, writing to the
 * suite's pipe and holding its temporary directory open. The runner therefore
 * kills the tree and then WAITS until the pid is gone before it moves on, so
 * the next suite starts in a clean process table.
 *
 * Subprocesses here
 * -----------------
 * `taskkill`, `ps` and `pkill` are spawned (never interpolated into a shell)
 * and only ever receive pids belonging to a suite this runner started. The
 * project rule that subprocesses go through core/shell.js is about `src/`; the
 * test runner must not import src/, because that would open core/db.js in the
 * runner's own process with no test guard around it.
 *
 * On Windows `taskkill /T` walks the parent-child relation the system keeps.
 * On POSIX there is no such flag, so the descendants are read from `ps` and
 * killed deepest-first; if `ps` is unavailable the direct child is all that can
 * be reached, and the caller is told.
 */

import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Whether a pid exists right now.
 *
 * `process.kill(pid, 0)` performs the existence check without sending a signal.
 * EPERM means "alive, but owned by someone else", which still counts.
 *
 * @param {number|null|undefined} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Waits for a pid to disappear.
 *
 * @param {number|null|undefined} pid
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>} True when it is gone
 */
export async function waitProcessGone(pid, timeoutMs = 10_000) {
  if (!pid) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(100);
  }
  return !isProcessAlive(pid);
}

/**
 * Runs a helper and reports whether it exited 0. A missing tool is a false,
 * never a throw: the caller has a fallback.
 *
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<boolean>}
 */
function runHelper(command, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      resolve(false);
      return;
    }

    let output = '';
    child.stdout?.on('data', (chunk) => { output += chunk; });
    child.stderr?.on('data', (chunk) => { output += chunk; });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

/**
 * The pid of every descendant of `pid`, deepest first.
 *
 * @param {number} pid
 * @returns {Promise<number[]>} Empty when `ps` is unavailable
 */
async function descendants(pid) {
  const child = spawn('ps', ['-e', '-o', 'pid=,ppid='], { stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  child.stdout?.on('data', (chunk) => { output += chunk; });

  const exitCode = await new Promise((resolve) => {
    child.on('error', () => resolve(-1));
    child.on('exit', (code) => resolve(code ?? -1));
  });
  if (exitCode !== 0) return [];

  const children = new Map();
  for (const line of output.split('\n')) {
    const [childPid, parentPid] = line.trim().split(/\s+/).map(Number);
    if (!childPid || !Number.isFinite(parentPid)) continue;
    if (!children.has(parentPid)) children.set(parentPid, []);
    children.get(parentPid).push(childPid);
  }

  // Depth-first, so a parent is killed only after the children that would be
  // reparented (and therefore lost) if it went first.
  const ordered = [];
  const walk = (parent) => {
    for (const child of children.get(parent) ?? []) {
      walk(child);
      ordered.push(child);
    }
  };
  walk(pid);
  return ordered;
}

/**
 * Kills a suite's whole process tree and waits for the root pid to be gone.
 *
 * @param {number|null|undefined} pid The suite's own pid
 * @param {{ waitMs?: number, log?: (line: string) => void }} [options]
 * @returns {Promise<{ killed: boolean, survivors: number[] }>}
 *   `killed` is true when the root pid is gone afterwards.
 */
export async function killProcessTree(pid, { waitMs = 10_000 } = {}) {
  if (!pid) return { killed: true, survivors: [] };

  const survivors = [];
  /** The descendants seen before the kill, so a reparented grandchild is still
   *  identified afterwards. */
  let tree = [];

  if (process.platform === 'win32') {
    // /T: the tree, /F: no graceful phase. Direct argv, never a shell string.
    await runHelper('taskkill', ['/PID', String(pid), '/T', '/F']);
  } else {
    tree = await descendants(pid);
    if (tree.length === 0) {
      // Not necessarily childless: `ps` may be unavailable, in which case the
      // direct-children kill is the only other lever there is.
      await runHelper('pkill', ['-KILL', '-P', String(pid)]);
    }
    for (const childPid of tree) {
      try { process.kill(childPid, 'SIGKILL'); } catch { /* already gone */ }
    }
    // The group kill only works when the suite leads its own group; it costs
    // nothing when it does not.
    try { process.kill(-pid, 'SIGKILL'); } catch { /* not a group leader */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }

  const killed = await waitProcessGone(pid, waitMs);

  if (!killed) survivors.push(pid);

  // A killed root can leave a grandchild behind for a moment (or, with no
  // `taskkill`/`ps`, forever). Say what is still visible instead of claiming a
  // clean kill.
  for (const childPid of tree) {
    if (isProcessAlive(childPid)) survivors.push(childPid);
  }

  return { killed, survivors };
}
