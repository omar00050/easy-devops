import { dbGet, dbSet } from '../../core/db.js';
import { DOMAIN_DEFAULTS, migrateDomain } from '../../core/nginx-conf-generator.js';

// Re-export DOMAIN_DEFAULTS for consumers
export { DOMAIN_DEFAULTS, migrateDomain };

/**
 * Get all domains, applying v2 migration to each record.
 * @returns {Array} Array of domain objects (v2 schema)
 */
export function getDomains() {
  const raw = dbGet('domains') ?? [];
  return raw.map(migrateDomain);
}

/**
 * Save domains array to storage.
 * @param {Array} arr - Array of domain objects
 */
export function saveDomains(arr) {
  dbSet('domains', arr);
}

/**
 * Find a domain by name.
 * @param {string} name - Domain name to find
 * @returns {Object|undefined} Domain object or undefined
 */
export function findDomain(name) {
  return getDomains().find((d) => d.name === name);
}

/**
 * Create a new domain object with defaults merged.
 * @param {Object} partial - Partial domain data
 * @returns {Object} Complete domain object with defaults
 */
export function createDomain(partial) {
  const now = new Date().toISOString();
  return {
    ...DOMAIN_DEFAULTS,
    ...partial,
    ssl: { ...DOMAIN_DEFAULTS.ssl, ...partial.ssl },
    performance: { ...DOMAIN_DEFAULTS.performance, ...partial.performance },
    security: { ...DOMAIN_DEFAULTS.security, ...partial.security },
    advanced: { ...DOMAIN_DEFAULTS.advanced, ...partial.advanced },
    configFile: null,
    createdAt: now,
    updatedAt: now,
  };
}
