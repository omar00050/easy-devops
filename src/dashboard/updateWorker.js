/**
 * dashboard/updateWorker.js
 *
 * The detached half of "Update" in Settings.
 *
 * The dashboard cannot update itself inside a request: npm replaces the very
 * files the process is running, and the process is stopped mid-way, so the
 * HTTP response could never report what actually happened. The route writes
 * the run's first status record and spawns this worker detached. The worker
 * outlives the dashboard (which it stops), runs the SAME core/updater.js flow
 * as `ezz update`, starts the dashboard again, and leaves the outcome in the
 * status file the new dashboard reads.
 *
 * Started only by the update controller — it is not a user-facing command and
 * the CLI has no reason to use it, having its own terminal to report into.
 */

import fs from 'fs';
import path from 'path';
import { getDataDir } from '../core/platform.js';
import { loadConfig } from '../core/config.js';
import { readStatus, writeStatus } from '../core/updateStatus.js';
import { startDashboard, stopDashboard, isPidAlive } from '../core/dashboardProcess.js';

const runId = parseRunId(process.argv.slice(2));
const dataDir = getDataDir();
const LOG_PATH = path.join(dataDir, 'logs', 'update.log');

/** Last lines, echoed into the status file for the result card. */
const logTail = [];

function log(line) {
  const text = String(line ?? '');
  try {
    fs.appendFileSync(LOG_PATH, `${text}\n`);
  } catch { /* the status file still carries the tail */ }
  logTail.push(text);
  if (logTail.length > 40) logTail.shift();
  try {
    writeStatus({ logTail: [...logTail] }, { dataDir });
  } catch { /* a lost intermediate write is not fatal */ }
}

function parseRunId(argv) {
  const index = argv.indexOf('--run-id');
  return index >= 0 ? argv[index + 1] ?? null : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const run = readStatus(dataDir);
  if (!run) {
    process.stderr.write('update worker: no status record to run\n');
    return 1;
  }
  if (runId && run.id !== runId) {
    process.stderr.write('update worker: this run has been superseded\n');
    return 1;
  }
  if (run.phase !== 'starting') {
    // A second worker for the same record would run npm a second time.
    process.stderr.write(`update worker: run is already ${run.phase}\n`);
    return 1;
  }

  // Claim the record with this pid before touching anything: from here on the
  // route's double-start guard sees a live worker.
  writeStatus({ phase: 'stopping', workerPid: process.pid, step: 'dashboard' }, { dataDir });
  log(`Updating Easy DevOps v${run.from} -> v${run.to}`);

  const heartbeat = setInterval(() => {
    try {
      writeStatus({}, { dataDir });
    } catch { /* transient */ }
  }, 5_000);
  heartbeat.unref?.();

  // The HTTP response that said "started" has to reach the browser before the
  // server dies; stopping immediately would cut it off.
  await sleep(1_500);

  const dash = run.dashboard ?? {};
  if (dash.pid) {
    await stopDashboard(dash.pid);
    log('Dashboard stopped');
    // On POSIX the stop signal is asynchronous: the old process must be gone
    // (and its port released) before the new one binds, or it fails to start.
    const deadline = Date.now() + 5_000;
    while (isPidAlive(dash.pid) && Date.now() < deadline) await sleep(200);
  }

  let result;
  try {
    writeStatus({ phase: 'updating', step: 'install' }, { dataDir });
    const updater = await import('../core/updater.js');
    result = await updater.performUpdate({ version: run.to, dataDir, log });
  } catch (error) {
    result = { ok: false, step: 'exception', reason: error?.message ?? String(error) };
  } finally {
    clearInterval(heartbeat);
  }

  writeStatus(
    {
      phase: 'restarting',
      step: 'dashboard',
      from: result.from ?? run.from,
      to: result.to ?? run.to,
      reason: result.reason ?? null,
      rolledBack: Boolean(result.rolledBack),
      restored: result.restored ?? null,
      runningVersion: result.runningVersion ?? null,
      versionConfirmed: Boolean(result.versionConfirmed),
      serviceInstalled: Boolean(result.serviceInstalled),
      refreshedCopy: Boolean(result.refreshedCopy),
    },
    { dataDir }
  );

  // Back on the same port, on whatever code is on disk now — which is the new
  // version when the update worked and the old one when it rolled back.
  const port = dash.port || loadConfig().dashboardPort;
  const back = await startDashboard(port, { env: { EASY_DEVOPS_DATA_DIR: dataDir } });
  log(back.success
    ? `Dashboard restarted on port ${port}`
    : `The dashboard did not come back on port ${port} - start it again from the Dashboard menu`);

  writeStatus(
    {
      phase: result.ok ? 'done' : 'failed',
      step: result.ok ? null : result.step ?? null,
      dashboardRestarted: back.success,
      dashboardPort: port,
      finishedAt: Date.now(),
      logTail: [...logTail],
    },
    { dataDir }
  );

  return result.ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    try {
      writeStatus(
        {
          phase: 'failed',
          step: 'worker',
          reason: error?.message ?? String(error),
          finishedAt: Date.now(),
          logTail: [...logTail],
        },
        { dataDir }
      );
    } catch { /* the file may be unwritable; nothing else to do */ }
    process.stderr.write(`update worker failed: ${error?.stack ?? error}\n`);
    process.exit(1);
  });
