import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import {
	loadConfig, saveConfig, BIND_ALL, BIND_LOOPBACK, BIND_LOOPBACK_V6,
	AUTH_MODES, UI_MODES, isLoopbackBind, effectiveAuthMode,
} from '../../core/config.js';
import { isLoopbackAddress } from '../lib/localRequest.js';
import { hashPassword, validateNewPassword } from '../../core/passwords.js';
import { validatePort, validateEmail } from '../../core/validators.js';
import {
	getAutoRenewSettings, normalizeAutoRenewDays, MIN_AUTO_RENEW_DAYS, MAX_AUTO_RENEW_DAYS,
} from '../../core/cert-renewal.js';
import { isWindows } from '../../core/platform.js';
import {
	checkPermissionsConfigured, buildSetupScript, deriveOwnDirs,
} from '../../core/permissions.js';
import { dbGet } from '../../core/db.js';
import { deployRoot, defaultDeployRoot, validateDeployDir } from '../../core/deploy/store.js';
import { saveDomains } from '../../core/domains-db.js';
import { loadChannels, saveChannels, sendNotification } from '../../core/notifier.js';

/**
 * The UI a configuration selects, resolved identically on read and write.
 *
 * Anything but an explicit `new` reads as `classic`, which is also the value a
 * client must assume when the field is absent. GET and POST both go through
 * here so they can never disagree about the same config.
 *
 * @param {Object} config
 * @returns {string} One of UI_MODES
 */
function resolveDashboardUi(config) {
	return config?.dashboardUi === UI_MODES.NEW ? UI_MODES.NEW : UI_MODES.CLASSIC;
}

class SettingsController {
	get(req, res) {
		try {
			const config = loadConfig();
			const { dashboardPort, nginxDir, sslDir, acmeEmail, dashboardBindAddress } = config;
			const hasPassword = Boolean(config.dashboardPasswordHash || config.dashboardPassword);
			const autoRenew = getAutoRenewSettings(config);
			// Neither the password nor its hash is ever returned.
			res.json({
				dashboardPort,
				nginxDir,
				sslDir,
				acmeEmail,
				// Background renewal of HTTP-01 certificates (core/cert-renewal.js).
				// The limits are published so no client hard-codes them.
				sslAutoRenew: autoRenew.enabled,
				sslAutoRenewDays: autoRenew.days,
				sslAutoRenewDaysMin: MIN_AUTO_RENEW_DAYS,
				sslAutoRenewDaysMax: MAX_AUTO_RENEW_DAYS,
				// Where NEW deployed apps are created. Existing apps stay where they
				// were created; moving one is an action on the Deployments page.
				deployDir: deployRoot(),
				deployDirDefault: defaultDeployRoot(),
				deployDirIsDefault: !config.deployDir,
				dashboardBindAddress,
				bindsToLoopbackOnly: isLoopbackBind(dashboardBindAddress),
				dashboardAuth: effectiveAuthMode(config),
				// Anything unrecognised reads as classic, which is also the
				// default. The value only takes effect on restart.
				dashboardUi: resolveDashboardUi(config),
				// Whether the UI may offer 'none' at all: the bind must be loopback
				// and the person asking must be on this machine.
				canUseNoPassword: isLoopbackBind(dashboardBindAddress) &&
					isLoopbackAddress(req.ip ?? req.socket?.remoteAddress),
				hasPassword,
				platform: isWindows ? 'win32' : 'linux',
			});
		} catch (err) {
			res.status(500).json({ error: 'Internal server error' });
		}
	}

	async update(req, res) {
		try {
			const {
				dashboardPort, dashboardPassword, nginxDir, sslDir, acmeEmail, dashboardBindAddress,
				dashboardAuth, dashboardUi, sslAutoRenew, sslAutoRenewDays, deployDir,
			} = req.body;

			const current = loadConfig();

			if (dashboardPort !== undefined) {
				const portError = validatePort(parseInt(dashboardPort, 10));
				if (portError) return res.status(400).json({ error: portError });
			}

			// A password set from here is held to the same minimum as the
			// first-run one, and is never stored in clear.
			if (dashboardPassword !== undefined) {
				const problem = validateNewPassword(dashboardPassword);
				if (problem) return res.status(400).json({ error: problem });
			}

			if (dashboardBindAddress !== undefined &&
					![BIND_ALL, BIND_LOOPBACK, BIND_LOOPBACK_V6].includes(dashboardBindAddress)) {
				return res.status(400).json({
					error: `Bind address must be ${BIND_LOOPBACK} (this machine only) or ${BIND_ALL} (all interfaces)`,
				});
			}

			if (dashboardAuth !== undefined &&
					![AUTH_MODES.PASSWORD, AUTH_MODES.NONE].includes(dashboardAuth)) {
				return res.status(400).json({
					error: `Authentication must be '${AUTH_MODES.PASSWORD}' or '${AUTH_MODES.NONE}'`,
				});
			}

			if (dashboardUi !== undefined &&
					![UI_MODES.CLASSIC, UI_MODES.NEW].includes(dashboardUi)) {
				return res.status(400).json({
					error: `Dashboard UI must be '${UI_MODES.CLASSIC}' or '${UI_MODES.NEW}'`,
				});
			}

			// ── The auth/bind interlock ──────────────────────────────────────
			//
			// 'none' is only safe while nothing but this machine can reach the
			// listener, so the two settings are validated TOGETHER against the
			// state this request would produce — not against the current state.
			// Otherwise a single request could set both and slip through by
			// checking each against the old value.
			const nextAuth = dashboardAuth ?? current.dashboardAuth;
			const nextBind = dashboardBindAddress ?? current.dashboardBindAddress;

			if (nextAuth === AUTH_MODES.NONE && !isLoopbackBind(nextBind)) {
				// Which half the user is changing decides which message helps.
				const changingBind = dashboardBindAddress !== undefined &&
					dashboardBindAddress !== current.dashboardBindAddress;

				return res.status(400).json({
					error: changingBind
						? 'This dashboard has no password, so it can only listen on this machine. Set a password first, then change where it listens.'
						: `Running without a password requires the dashboard to listen on this machine only (currently ${nextBind}).`,
					reason: changingBind ? 'bind_requires_password' : 'no_auth_requires_loopback',
				});
			}

			// Turning auth OFF is only ever done from the machine itself.
			if (dashboardAuth === AUTH_MODES.NONE &&
					current.dashboardAuth !== AUTH_MODES.NONE &&
					!isLoopbackAddress(req.ip ?? req.socket?.remoteAddress)) {
				return res.status(403).json({
					error: 'Removing the password can only be done from this machine.',
					reason: 'no_auth_requires_local_request',
				});
			}

			if (nginxDir !== undefined && (typeof nginxDir !== 'string' || nginxDir.trim() === '')) {
				return res.status(400).json({ error: 'Nginx directory must be a non-empty string' });
			}
			if (sslDir !== undefined && (typeof sslDir !== 'string' || sslDir.trim() === '')) {
				return res.status(400).json({ error: 'SSL directory must be a non-empty string' });
			}

			if (acmeEmail !== undefined) {
				const emailError = validateEmail(acmeEmail);
				if (emailError) return res.status(400).json({ error: emailError });
			}

			if (sslAutoRenew !== undefined && typeof sslAutoRenew !== 'boolean') {
				return res.status(400).json({ error: 'sslAutoRenew must be true or false' });
			}
			if (sslAutoRenewDays !== undefined && normalizeAutoRenewDays(sslAutoRenewDays) === null) {
				return res.status(400).json({
					error: `Auto-renew days must be a whole number from ${MIN_AUTO_RENEW_DAYS} to ${MAX_AUTO_RENEW_DAYS}`,
				});
			}

			// An empty value means "back to the default".
			const resetDeployDir = deployDir === null || (typeof deployDir === 'string' && deployDir.trim() === '');
			if (deployDir !== undefined && !resetDeployDir) {
				const dirError = validateDeployDir(deployDir);
				if (dirError) return res.status(400).json({ error: dirError });
				try {
					await fs.mkdir(path.resolve(deployDir.trim()), { recursive: true });
				} catch (err) {
					return res.status(400).json({ error: `That folder cannot be created or written to: ${err.message}` });
				}
			}

			const currentConfig = current;
			const updates = {};

			if (dashboardPort !== undefined) updates.dashboardPort = parseInt(dashboardPort, 10);
			if (dashboardPassword !== undefined) {
				updates.dashboardPasswordHash = await hashPassword(dashboardPassword);
				// Drop any legacy plain-text copy at the same time.
				updates.dashboardPassword = '';
			}
			if (dashboardBindAddress !== undefined) updates.dashboardBindAddress = dashboardBindAddress;
			if (dashboardAuth !== undefined) updates.dashboardAuth = dashboardAuth;
			if (dashboardUi !== undefined) updates.dashboardUi = dashboardUi;

			// Setting a password implies wanting one; switching to 'password'
			// without one leaves the first-run screen as the way back in, which
			// is recoverable but not what anyone means by saving a password.
			if (dashboardPassword !== undefined && dashboardAuth === undefined) {
				updates.dashboardAuth = AUTH_MODES.PASSWORD;
			}
			if (nginxDir !== undefined) updates.nginxDir = nginxDir.trim();
			if (sslDir !== undefined) updates.sslDir = sslDir.trim();
			if (acmeEmail !== undefined) updates.acmeEmail = acmeEmail.trim();
			if (deployDir !== undefined) updates.deployDir = resetDeployDir ? null : path.resolve(deployDir.trim());
			if (sslAutoRenew !== undefined) updates.sslAutoRenew = sslAutoRenew;
			if (sslAutoRenewDays !== undefined) updates.sslAutoRenewDays = normalizeAutoRenewDays(sslAutoRenewDays);

			saveConfig({ ...currentConfig, ...updates });

			// The port, the bind address and the UI choice only take effect on
			// restart, so say so rather than letting the user think the change is
			// already live.
			const needsRestart = updates.dashboardPort !== undefined ||
				updates.dashboardBindAddress !== undefined ||
				updates.dashboardUi !== undefined;

			res.json({
				success: true,
				needsRestart,
				dashboardAuth: effectiveAuthMode({ ...currentConfig, ...updates }),
				// Resolved by the same helper GET uses, so a stored value GET
				// would read as classic cannot be echoed back as something else.
				dashboardUi: resolveDashboardUi({ ...currentConfig, ...updates }),
			});
		} catch (err) {
			res.status(500).json({ error: 'Internal server error' });
		}
	}

	async getPermissions(req, res) {
		if (isWindows) return res.json({ configured: true });
		try {
			const configured = await checkPermissionsConfigured();
			res.json({ configured });
		} catch {
			res.json({ configured: false });
		}
	}

	/**
	 * POST /api/settings/permissions/setup
	 *
	 * Reports the sudoers state and the exact terminal commands that install
	 * the rules. It INSTALLS NOTHING and never accepts a password:
	 *
	 *   - the request body is deliberately not read at all. An older client
	 *     that still sends `password` has it ignored, never stored, never
	 *     forwarded;
	 *   - no privileged command runs here. `checkPermissionsConfigured()` only
	 *     asks sudo whether it would prompt (`sudo -n`);
	 *   - the operator pastes the commands into their own terminal, where sudo
	 *     asks THEM for their password. That is the only place it is typed.
	 *
	 * `deps` exists so a test can drive both outcomes without a real dashboard
	 * and without ever running sudo.
	 *
	 * @param {Object} req
	 * @param {Object} res
	 * @param {Object} [deps]
	 * @param {boolean} [deps.isWindows]
	 * @param {() => Promise<boolean>} [deps.checkConfigured]
	 * @param {string} [deps.user] Account the rules are written for; defaults
	 *        to the one this process runs as (injectable for tests)
	 */
	async setupPermissions(req, res, deps = {}) {
		if (deps.isWindows ?? isWindows) {
			return res.status(400).json({ error: 'Not applicable on Windows' });
		}

		try {
			const checkConfigured = deps.checkConfigured ?? checkPermissionsConfigured;

			const { ownDirs, refused } = deriveOwnDirs(loadConfig());
			const script = buildSetupScript({ user: deps.user, ownDirs });

			let configured = false;
			try {
				configured = await checkConfigured();
			} catch { /* reported as not configured, which is actionable */ }

			if (!script.ok) {
				return res.status(400).json({
					configured,
					error: script.reason,
					commands: [],
					refusedDirs: refused,
				});
			}

			res.json({ configured, commands: script.lines, refusedDirs: refused });
		} catch (err) {
			res.status(500).json({ error: 'Internal server error' });
		}
	}

	backup(req, res) {
		try {
			const config = loadConfig();
			const domains = dbGet('domains') || [];
			// Strip BOTH the legacy plain-text password and the hash: a backup is
			// a file the user downloads and may share, and a scrypt hash is still
			// a credential worth cracking offline.
			const {
				dashboardPassword: _pw,
				dashboardPasswordHash: _pwHash,
				...safeConfig
			} = config;
			const backup = {
				version: 1,
				exportedAt: new Date().toISOString(),
				config: safeConfig,
				domains,
			};
			res.setHeader('Content-Disposition', `attachment; filename="easy-devops-backup-${Date.now()}.json"`);
			res.setHeader('Content-Type', 'application/json');
			res.json(backup);
		} catch (err) {
			res.status(500).json({ error: 'Export failed' });
		}
	}

	restore(req, res) {
		try {
			const { config, domains } = req.body ?? {};
			if (!config || typeof config !== 'object') {
				return res.status(400).json({ error: 'Invalid backup: missing config' });
			}
			const current = loadConfig();
			// A backup may predate hashed passwords and the bind setting. Never let
			// one restore a plain-text password or silently re-open the listener.
			const merged = {
				...current,
				...config,
				dashboardPassword: current.dashboardPassword,
				dashboardPasswordHash: current.dashboardPasswordHash,
				dashboardBindAddress: current.dashboardBindAddress,
				dashboardAuth: current.dashboardAuth,
			};
			saveConfig(merged);
			// Through saveDomains(), not dbSet: restoring a backup replaces the
			// whole domain set, which the Hub must learn about like any other
			// domain write. A bare dbSet skipped the revision bump and left the
			// Hub showing the pre-restore list until the next restart.
			if (Array.isArray(domains)) {
				saveDomains(domains);
			}
			res.json({ success: true });
		} catch (err) {
			res.status(500).json({ error: 'Restore failed' });
		}
	}

	// ── Notification Channel CRUD ─────────────────────────────────────────────

	/**
	 * GET /api/settings/channels
	 * Returns the full channel list.
	 */
	getChannels(req, res) {
		try {
			res.json(loadChannels());
		} catch (err) {
			res.status(500).json({ error: 'Internal server error' });
		}
	}

	/**
	 * POST /api/settings/channels
	 * Creates a new named channel.
	 */
	createChannel(req, res) {
		try {
			const { name, type, webhookUrl, botToken, chatId, message } = req.body ?? {};

			if (!name || typeof name !== 'string' || !name.trim()) {
				return res.status(400).json({ error: 'Channel name is required' });
			}
			if (!['discord', 'telegram'].includes(type)) {
				return res.status(400).json({ error: 'Channel type must be discord or telegram' });
			}
			if (type === 'discord' && (!webhookUrl || !webhookUrl.trim())) {
				return res.status(400).json({ error: 'Discord channels require a webhookUrl' });
			}
			if (type === 'telegram') {
				if (!botToken || !botToken.trim()) {
					return res.status(400).json({ error: 'Telegram channels require a botToken' });
				}
				if (!chatId || !chatId.trim()) {
					return res.status(400).json({ error: 'Telegram channels require a chatId' });
				}
			}

			const channel = {
				id: crypto.randomUUID(),
				name: name.trim(),
				type,
				...(type === 'discord' ? { webhookUrl: webhookUrl.trim() } : {}),
				...(type === 'telegram' ? { botToken: botToken.trim(), chatId: chatId.trim() } : {}),
				...(message && message.trim() ? { message: message.trim() } : {}),
			};

			const channels = loadChannels();
			channels.push(channel);
			saveChannels(channels);

			res.status(201).json(channel);
		} catch (err) {
			res.status(500).json({ error: 'Internal server error' });
		}
	}

	/**
	 * PUT /api/settings/channels/:id
	 * Updates name and/or credentials for an existing channel.
	 * Type is immutable after creation.
	 */
	updateChannel(req, res) {
		try {
			const { id } = req.params;
			const channels = loadChannels();
			const idx = channels.findIndex((ch) => ch.id === id);
			if (idx === -1) return res.status(404).json({ error: 'Channel not found' });

			const existing = channels[idx];
			const { name, webhookUrl, botToken, chatId, message } = req.body ?? {};

			const updated = { ...existing };
			if (name !== undefined) {
				if (!name.trim()) return res.status(400).json({ error: 'Channel name cannot be empty' });
				updated.name = name.trim();
			}
			if (existing.type === 'discord' && webhookUrl !== undefined) {
				updated.webhookUrl = webhookUrl.trim();
			}
			if (existing.type === 'telegram') {
				if (botToken !== undefined) updated.botToken = botToken.trim();
				if (chatId !== undefined) updated.chatId = chatId.trim();
			}

			// Handle message field - allow clearing by setting to empty string
			if (message !== undefined) {
				if (message && message.trim()) {
					updated.message = message.trim();
				} else {
					delete updated.message;
				}
			}

			channels[idx] = updated;
			saveChannels(channels);
			res.json(updated);
		} catch (err) {
			res.status(500).json({ error: 'Internal server error' });
		}
	}

	/**
	 * DELETE /api/settings/channels/:id
	 */
	deleteChannel(req, res) {
		try {
			const { id } = req.params;
			const channels = loadChannels();
			const idx = channels.findIndex((ch) => ch.id === id);
			if (idx === -1) return res.status(404).json({ error: 'Channel not found' });

			channels.splice(idx, 1);
			saveChannels(channels);
			res.json({ deleted: id });
		} catch (err) {
			res.status(500).json({ error: 'Internal server error' });
		}
	}

	/**
	 * POST /api/settings/channels/:id/test
	 * Sends a test notification to a single channel.
	 */
	async testChannel(req, res) {
		try {
			const { id } = req.params;
			const channels = loadChannels();
			if (!channels.find((ch) => ch.id === id)) {
				return res.status(404).json({ error: 'Channel not found' });
			}

			await sendNotification(
				{
					type: 'test',
					message: 'Test notification from Easy DevOps. This channel is working correctly.',
					timestamp: new Date().toISOString(),
				},
				[id]
			);

			res.json({ success: true });
		} catch (err) {
			res.status(500).json({ error: err.message || 'Failed to send test notification' });
		}
	}
}

export default SettingsController;
