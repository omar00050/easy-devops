/**
 * dashboard/controllers/updateController.js
 *
 * "Update" in Settings, for the dashboard.
 *
 * ── Why the request does not do the work ──────────────────────────────────
 *
 * npm replaces the files this server is running from, and the service it
 * shares a lock with has to be stopped so those files can be replaced. A
 * request cannot survive the server it arrived on, so it could report neither
 * success nor failure. The route therefore only RECORDS the run and spawns a
 * detached worker (dashboard/updateWorker.js) that outlives this process,
 * performs the same core/updater.js flow as `ezz update`, and brings the
 * dashboard back. The outcome lives in core/updateStatus.js, which the new
 * dashboard reads on its first poll — the client discovers "I was restarted"
 * from the status file, not from a response that never came.
 *
 * ── Why the install source gates everything ───────────────────────────────
 *
 * On a git clone `npm install -g` installs a second copy from the registry and
 * leaves the service running the clone, so an update would report success and
 * change nothing. The check endpoint reports the source so the UI can explain
 * it, and start refuses with the commands to run instead.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

import { getDataDir } from '../../core/platform.js';
import { loadConfig } from '../../core/config.js';
import { checkForUpdate, currentVersion } from '../../core/updater.js';
import { detectInstallSource } from '../../core/installSource.js';
import {
	readStatus, writeStatus, describeRun, runIsActive,
} from '../../core/updateStatus.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.resolve(__dirname, '..', 'updateWorker.js');

/** A release triple, the only shape `npm install -g easy-devops@…` gets. */
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * Starts the detached worker.
 *
 * Detached and unref'd so it survives this process being killed at the stop
 * step; its output goes to a log file because a detached Windows process has
 * no console to inherit.
 *
 * @returns {{ pid: number|undefined }}
 */
function spawnWorker({ args, logPath, dataDir }) {
	fs.mkdirSync(path.dirname(logPath), { recursive: true });
	const out = fs.openSync(logPath, 'a');
	try {
		const child = spawn(process.execPath, [WORKER_PATH, ...args], {
			detached: true,
			stdio: ['ignore', out, out],
			env: { ...process.env, EASY_DEVOPS_DATA_DIR: dataDir },
			windowsHide: true,
		});
		child.unref();
		return child;
	} finally {
		fs.closeSync(out);
	}
}

function describeSource(source) {
	return {
		kind: source.kind,
		reason: source.reason,
		npmUpdatable: source.npmUpdatable,
		howToUpdate: source.howToUpdate,
	};
}

class UpdateController {
	constructor(deps = {}) {
		this.getDataDir = deps.getDataDir ?? (() => getDataDir());
		this.checkForUpdate = deps.checkForUpdate ?? checkForUpdate;
		this.currentVersion = deps.currentVersion ?? currentVersion;
		this.detectInstallSource = deps.detectInstallSource ?? detectInstallSource;
		this.readStatus = deps.readStatus ?? ((dataDir) => readStatus(dataDir));
		this.writeStatus = deps.writeStatus ?? ((patch, opts) => writeStatus(patch, opts));
		this.spawnWorker = deps.spawnWorker ?? spawnWorker;
		this.runId = deps.runId ?? (() => `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`);
		this.now = deps.now ?? (() => Date.now());
	}

	/**
	 * GET /api/update — what the registry has, how this copy is managed, and
	 * the last run (if any) so a page that loads after a restart can report it.
	 */
	async check(req, res) {
		try {
			const dataDir = this.getDataDir();
			const check = await this.checkForUpdate();
			res.json({
				current: check.current,
				latest: check.latest,
				reachable: check.reachable,
				updateAvailable: check.updateAvailable,
				source: describeSource(this.detectInstallSource()),
				run: describeRun(this.readStatus(dataDir)),
			});
		} catch {
			res.status(500).json({ error: 'Internal server error' });
		}
	}

	/**
	 * GET /api/update/status — the run record alone, with this process's
	 * version. Polled while an update is in flight: it must not touch the
	 * registry, so it stays up while the network does not.
	 */
	async getStatus(req, res) {
		try {
			res.json({
				current: this.currentVersion(),
				run: describeRun(this.readStatus(this.getDataDir())),
			});
		} catch {
			res.status(500).json({ error: 'Internal server error' });
		}
	}

	/**
	 * POST /api/update — accepts the run and answers before it begins.
	 *
	 * Body: { version } (a release triple; a fresh registry check fills it in
	 * when omitted). 202 means "the worker was started", never "the update
	 * succeeded" — that is only ever known from the status record.
	 */
	async start(req, res) {
		try {
			const dataDir = this.getDataDir();
			const source = this.detectInstallSource();

			if (!source.npmUpdatable) {
				res.status(409).json({
					error: `This copy is ${source.reason}, so npm cannot update it in place.`,
					source: describeSource(source),
				});
				return;
			}

			const existing = describeRun(this.readStatus(dataDir));
			if (runIsActive(existing)) {
				res.status(409).json({
					error: 'An update is already running.',
					run: existing,
				});
				return;
			}

			let target = String(req.body?.version ?? '').trim();
			if (!VERSION_PATTERN.test(target)) {
				const check = await this.checkForUpdate();
				if (!check.reachable) {
					res.status(502).json({
						error: 'Could not reach the npm registry to find the latest version.',
					});
					return;
				}
				if (!check.updateAvailable) {
					res.status(409).json({
						error: `Easy DevOps is already up to date (v${check.current}).`,
						current: check.current,
						latest: check.latest,
					});
					return;
				}
				target = check.latest;
			}

			const run = {
				id: this.runId(),
				phase: 'starting',
				from: this.currentVersion(),
				to: target,
				step: null,
				reason: null,
				logTail: [],
				startedAt: this.now(),
				dashboard: {
					pid: process.pid,
					// The port the request actually arrived on: a dashboard moved
					// with --port comes back where the user left it, not where the
					// config says.
					port: req.socket?.localPort ?? loadConfig().dashboardPort,
				},
			};
			this.writeStatus(run, { dataDir, replace: true });

			const child = this.spawnWorker({
				args: ['--run-id', run.id],
				logPath: path.join(dataDir, 'logs', 'update.log'),
				dataDir,
			});

			const written = this.writeStatus({ workerPid: child?.pid ?? null }, { dataDir });
			res.status(202).json({ started: true, run: written });
		} catch {
			res.status(500).json({ error: 'Internal server error' });
		}
	}
}

export default UpdateController;
