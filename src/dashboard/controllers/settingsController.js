import fs from 'fs/promises';
import path from 'path';
import os from 'os';
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
import { run, runWithStdin } from '../../core/shell.js';
import { checkPermissionsConfigured } from '../../core/permissions.js';
import { dbGet, dbSet } from '../../core/db.js';
import { deployRoot, defaultDeployRoot, validateDeployDir } from '../../core/deploy/store.js';
import { saveDomains } from '../../core/domains-db.js';
import { loadChannels, saveChannels, sendNotification } from '../../core/notifier.js';

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
				dashboardUi: config.dashboardUi === UI_MODES.NEW ? UI_MODES.NEW : UI_MODES.CLASSIC,
				// Whether the UI may offer 'none' at all: the bind must be loopback
				// and the person asking must be on this machine.
				canUseNoPassword: isLoopbackBind(dashboardBindAddress) &&
					isLoopbackAddress(req.ip ?? req.socket?.remoteAddress),
				hasPassword,
				platform: process.platform === 'win32' ? 'win32' : 'linux',
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
				dashboardUi: updates.dashboardUi ?? currentConfig.dashboardUi,
			});
		} catch (err) {
			res.status(500).json({ error: 'Internal server error' });
		}
	}

	async getPermissions(req, res) {
		if (process.platform === 'win32') return res.json({ configured: true });
		try {
			const configured = await checkPermissionsConfigured();
			res.json({ configured });
		} catch {
			res.json({ configured: false });
		}
	}

	async setupPermissions(req, res) {
		if (process.platform === 'win32') {
			return res.status(400).json({ error: 'Not applicable on Windows' });
		}

		const { password } = req.body ?? {};
		if (!password || typeof password !== 'string') {
			return res.status(400).json({ error: 'Password is required' });
		}

		const whichResult = await run('which nginx');
		if (!whichResult.success || !whichResult.stdout.trim()) {
			return res.status(500).json({ error: 'nginx not found. Is nginx installed?' });
		}
		const nginxPath = whichResult.stdout.trim().split('\n')[0].trim();
		const user = os.userInfo().username;

		const sudoRules = [
			'/usr/bin/systemctl start nginx',
			'/usr/bin/systemctl stop nginx',
			'/usr/bin/systemctl reload nginx',
			'/usr/bin/systemctl restart nginx',
			'/usr/bin/systemctl',
			nginxPath,
			`${nginxPath} -t`,
			`${nginxPath} -s reload`,
			`${nginxPath} -s stop`,
			`${nginxPath} -s quit`,
			'/usr/bin/certbot',
			'/usr/bin/mkdir',
			'/usr/bin/cp',
			'/usr/bin/chmod',
			'/usr/bin/chown',
			'/usr/bin/tee',
		].join(', ');

		const sudoersContent = `${user} ALL=(ALL) NOPASSWD: ${sudoRules}\n`;

		const tmpFile = path.join('/tmp', `easy-devops-sudoers-${Date.now()}`);
		try {
			await fs.writeFile(tmpFile, sudoersContent, { mode: 0o600 });
		} catch (err) {
			return res.status(500).json({ error: 'Failed to write temp file', output: err.message });
		}

		const setupCmd = [
			`mkdir -p /etc/easy-devops /var/log/easy-devops`,
			`chown ${user}:${user} /etc/easy-devops /var/log/easy-devops`,
			`chown -R ${user}:${user} /etc/nginx/conf.d 2>/dev/null || true`,
			`cp '${tmpFile}' /etc/sudoers.d/easy-devops`,
			`chmod 440 /etc/sudoers.d/easy-devops`,
		].join(' && ');

		const result = await runWithStdin('sudo', ['-S', 'bash', '-c', setupCmd], password + '\n');
		await fs.unlink(tmpFile).catch(() => {});

		if (!result.success) {
			const output = result.stderr || result.stdout;
			const wrongPassword = output.includes('incorrect password') || output.includes('Sorry, try again') || output.includes('3 incorrect');
			return res.status(wrongPassword ? 401 : 500).json({
				error: wrongPassword ? 'Incorrect password' : 'Setup failed',
				output,
			});
		}

		res.json({ success: true });
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
