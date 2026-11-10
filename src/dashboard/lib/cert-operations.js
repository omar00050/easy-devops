import { loadConfig } from '../../core/config.js';
import { listAllCerts } from './cert-reader.js';

let renewCertFn = null;

async function getRenewCert() {
  if (!renewCertFn) {
    const mod = await import('../../cli/managers/ssl-manager.js');
    renewCertFn = mod.renewCert;
  }
  return renewCertFn;
}

export async function handleHubSslCommand(payload) {
  const { action, domain } = payload ?? {};

  switch (action) {
    case 'renew': {
      if (!domain) { console.warn('[hubAgent] ssl renew: missing domain'); return; }
      const config = loadConfig();
      if (!config.acmeEmail) { console.warn('[hubAgent] ssl renew: no acmeEmail configured'); return; }
      try {
        const renewCert = await getRenewCert();
        const result = await renewCert(domain, { validationMethod: 'http', email: config.acmeEmail });
        console.log('[hubAgent] ssl renew:', domain, result.success ? 'OK' : 'FAILED');
      } catch (err) {
        console.error('[hubAgent] ssl renew error:', err.message);
      }
      break;
    }

    case 'renewAll': {
      const config = loadConfig();
      if (!config.acmeEmail) { console.warn('[hubAgent] ssl renewAll: no acmeEmail configured'); return; }
      try {
        const certs = await listAllCerts();
        const expiring = certs.filter(c => c.daysLeft !== null && c.daysLeft < 30);
        const renewCert = await getRenewCert();
        for (const cert of expiring) {
          try {
            await renewCert(cert.domain, { validationMethod: 'http', email: config.acmeEmail });
            console.log('[hubAgent] ssl renewed:', cert.domain);
          } catch (err) {
            console.error('[hubAgent] ssl renew failed:', cert.domain, err.message);
          }
        }
      } catch (err) {
        console.error('[hubAgent] ssl renewAll error:', err.message);
      }
      break;
    }

    default:
      console.warn('[hubAgent] handleHubSslCommand: unknown action:', action);
  }
}
