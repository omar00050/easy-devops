/**
 * Structured Event Type Factory
 *
 * This module provides factory functions for creating notification event objects
 * with guaranteed field shapes. Used by socketManager.js for browser notifications
 * and by notifier.js for external channel dispatch (Discord, Telegram, etc.).
 *
 * HARD CONSTRAINT: Zero imports — pure data construction, no side effects.
 * This ensures the module is safe to import anywhere without pulling in
 * platform-specific or heavyweight dependencies.
 *
 * FIELD CONTRACT (verified against notifier.js:sendNotification):
 * - type: string (e.g., 'nginx_down', 'cert_expiry', 'domain_health')
 * - subtype: string (optional, e.g., 'down', 'recovery')
 * - message: string (human-readable description)
 * - severity: 'danger' | 'warning' | 'success' | undefined
 * - domain: string (optional, for domain-specific events)
 * - timestamp: number (epoch ms)
 * - id: string (unique event identifier)
 */

/**
 * Create an nginx-down notification event.
 * Emitted when nginx service status shows running: false.
 *
 * @returns {Object} Event object with nginx-down notification data
 */
export function createNginxDownEvent() {
  return {
    id: `nginx-down-${Date.now()}`,
    type: 'nginx_down',
    subtype: 'down',
    severity: 'danger',
    message: '🔴 Nginx is not running',
    timestamp: Date.now(),
  };
}

/**
 * Create an nginx-recovered notification event.
 * Emitted when nginx transitions from down → up.
 *
 * @returns {Object} Event object with nginx-recovered notification data
 */
export function createNginxRecoveredEvent() {
  return {
    id: `nginx-recovered-${Date.now()}`,
    type: 'nginx_down',
    subtype: 'recovery',
    severity: 'success',
    message: '✅ Nginx is running again',
    timestamp: Date.now(),
  };
}

/**
 * Create a certificate expiry notification event.
 * Emitted when an SSL certificate is approaching expiration (< 30 days).
 *
 * @param {string} domain - The domain name for the certificate
 * @param {number} daysLeft - Number of days until expiration
 * @returns {Object} Event object with cert-expiry notification data
 */
export function createCertExpiryEvent(domain, daysLeft, options = {}) {
  const severity = daysLeft < 10 ? 'danger' : 'warning';
  // A DNS-01 certificate (every wildcard is one) needs a TXT record added by
  // hand, so it is never renewed automatically. Saying so in the warning is
  // what stops the operator from assuming auto-renewal has it covered.
  const manual = options.manualRenewal
    ? ' — DNS-validated, so it must be renewed manually'
    : '';
  return {
    id: `cert-expiry-${domain}-${Date.now()}`,
    type: 'cert_expiry',
    severity,
    message: `🔒 SSL cert for ${domain} expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}${manual}`,
    domain,
    timestamp: Date.now(),
  };
}

/**
 * Create a certificate-renewed notification event.
 * Emitted when the background job renews a certificate on its own.
 *
 * Shares the `cert_expiry` type so it follows the same per-domain channel
 * routing as the expiry warning it resolves; `subtype` tells them apart.
 *
 * @param {string} domain - The domain name for the certificate
 * @param {string} [summary] - One-line description of how the renewal ran
 * @returns {Object} Event object with cert-renewed notification data
 */
export function createCertRenewedEvent(domain, summary = '') {
  return {
    id: `cert-renewed-${domain}-${Date.now()}`,
    type: 'cert_expiry',
    subtype: 'renewed',
    severity: 'success',
    message: `✅ SSL cert for ${domain} was renewed automatically${summary ? ` (${summary})` : ''}`,
    domain,
    timestamp: Date.now(),
  };
}

/**
 * Create a certificate-renewal-failed notification event.
 * Emitted when an automatic renewal attempt did not produce a certificate.
 *
 * @param {string} domain - The domain name for the certificate
 * @param {number|null} daysLeft - Days until the current certificate expires
 * @param {string} reason - Why the attempt failed
 * @returns {Object} Event object with cert-renew-failed notification data
 */
export function createCertRenewFailedEvent(domain, daysLeft, reason) {
  const left = typeof daysLeft === 'number'
    ? ` (${daysLeft} day${daysLeft === 1 ? '' : 's'} left)`
    : '';
  return {
    id: `cert-renew-failed-${domain}-${Date.now()}`,
    type: 'cert_expiry',
    subtype: 'renew_failed',
    severity: 'danger',
    message: `🔴 Automatic SSL renewal failed for ${domain}${left}: ${reason}`,
    domain,
    timestamp: Date.now(),
  };
}

/**
 * Create a deployment notification event.
 * Emitted by core/deploy/engine.js when a deployment or a rollback finishes.
 *
 * @param {string} app - The app id
 * @param {'success'|'failed'|'rolled_back'} outcome
 * @param {Object} [detail]
 * @param {string} [detail.sha] - Commit that was deployed (shortened in the message)
 * @param {string} [detail.reason] - Why it failed, when it did
 * @param {boolean} [detail.rollback] - True when the run itself was a manual rollback
 * @returns {Object} Event object with deployment notification data
 */
export function createDeployEvent(app, outcome, detail = {}) {
  const short = detail.sha ? ` (${String(detail.sha).slice(0, 7)})` : '';
  const what = detail.rollback ? 'Rollback of' : 'Deployment of';

  let severity = 'success';
  let message = `🚀 ${what} ${app}${short} succeeded`;

  if (outcome === 'rolled_back') {
    severity = 'warning';
    message = `↩️ Deployment of ${app}${short} failed and the previous release was restored`;
  } else if (outcome === 'failed') {
    severity = 'danger';
    message = `🔴 ${what} ${app}${short} failed`;
  }
  if (outcome !== 'success' && detail.reason) message += `: ${detail.reason}`;

  return {
    id: `deploy-${app}-${Date.now()}`,
    type: 'deploy',
    subtype: outcome,
    severity,
    message,
    app,
    timestamp: Date.now(),
  };
}

/**
 * Create a domain health DOWN notification event.
 * Emitted when a domain backend health check fails.
 *
 * @param {string} domain - The domain name
 * @param {number} port - The backend port
 * @returns {Object} Event object with domain health notification data
 */
export function createDomainDownEvent(domain, port) {
  return {
    id: `domain-down-${domain}-${Date.now()}`,
    type: 'domain_health',
    subtype: 'down',
    severity: 'danger',
    message: `🔴 ${domain} (port ${port}) is not responding`,
    domain,
    timestamp: Date.now(),
  };
}

/**
 * Create a domain health RECOVERY notification event.
 * Emitted when a domain backend transitions from down → up.
 *
 * @param {string} domain - The domain name
 * @param {number} port - The backend port
 * @returns {Object} Event object with domain recovery notification data
 */
export function createDomainRecoveredEvent(domain, port) {
  return {
    id: `domain-recovered-${domain}-${Date.now()}`,
    type: 'domain_health',
    subtype: 'recovery',
    severity: 'success',
    message: `✅ ${domain} (port ${port}) is back online`,
    domain,
    timestamp: Date.now(),
  };
}

/**
 * Create a domain health notification event (legacy wrapper).
 * Emitted when a domain backend health check passes or fails.
 * DEPRECATED: Use createDomainDownEvent or createDomainRecoveredEvent instead.
 *
 * @param {string} domain - The domain name
 * @param {boolean} up - Whether the domain backend is responding
 * @returns {Object} Event object with domain health notification data
 */
export function createDomainHealthEvent(domain, up) {
  if (up) {
    return createDomainRecoveredEvent(domain, '?');
  }
  return createDomainDownEvent(domain, '?');
}
