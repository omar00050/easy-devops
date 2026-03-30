/**
 * dashboard/lib/nginx-conf-generator.js
 *
 * Re-exports from core/nginx-conf-generator.js for backward compatibility.
 * Dashboard routes should import from either location:
 *   - import { generateConf } from '../lib/nginx-conf-generator.js' (existing imports)
 *   - import { generateConf } from '../../core/nginx-conf-generator.js' (CLI pattern)
 */

export {
  generateConf,
  buildConf,
  migrateDomain,
  DOMAIN_DEFAULTS,
  getDefaultCertPaths,
} from '../../core/nginx-conf-generator.js';
