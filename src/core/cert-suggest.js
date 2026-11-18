/**
 * core/cert-suggest.js
 *
 * Finds an existing certificate that can serve a domain, so a domain added
 * without SSL can be pointed at it in one click instead of having the operator
 * retype a path that is almost always `<sslDir>/<name>/fullchain.pem`.
 *
 * Matching is deliberately conservative — a wrong suggestion writes the wrong
 * certificate onto a live site:
 *
 *  1. exact      the certificate directory is named after the domain, which is
 *                how every certificate issued here is stored;
 *  2. san        one of the certificate's names is the domain itself (a cert
 *                issued for `example.com` that lists `api.example.com`);
 *  3. wildcard   a name like `*.example.com` covers `api.example.com` — but
 *                only one label, because `*.example.com` does not cover
 *                `a.b.example.com` (RFC 6125), and offering it would produce a
 *                site that fails certificate validation.
 *
 * Exact beats SAN beats wildcard; among wildcards the most specific suffix
 * wins. Nothing is suggested from a certificate that could not be read.
 */

import { loadConfig } from './config.js';
import { listAllCerts } from './cert-reader.js';
import { describeCertificate } from './cert-renewal.js';
import { getDefaultCertPaths } from './nginx-conf-generator.js';

const MATCH_RANK = { exact: 0, san: 1, wildcard: 2 };

/** Lowercase, trim, drop trailing dots. `*.` is meaningful and kept. */
export function normalizeForMatch(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\.+$/, '');
}

/** True when a certificate name like `*.example.com` covers `api.example.com`. */
export function wildcardCovers(pattern, domain) {
  const p = normalizeForMatch(pattern);
  const d = normalizeForMatch(domain);
  if (!p.startsWith('*.') || !d) return false;

  const suffix = p.slice(2);
  if (!suffix || !d.endsWith(`.${suffix}`)) return false;

  const label = d.slice(0, -(suffix.length + 1));
  return label.length > 0 && !label.includes('.');
}

/**
 * @param {string} domainName The bare domain (a leading `*.` is ignored)
 * @param {Object} [opts]
 * @param {string} [opts.sslDir] Certificates directory (defaults to the setting)
 * @returns {Promise<{ found: false } | {
 *   found: true,
 *   match: 'exact'|'san'|'wildcard',
 *   certificate: {
 *     domain: string, names: string[], certPath: string, keyPath: string,
 *     expiry: string|null, daysLeft: number|null, status: string
 *   }
 * }>}
 */
export async function findCertificateForDomain(domainName, { sslDir } = {}) {
  const dir = sslDir ?? loadConfig().sslDir;
  const domain = normalizeForMatch(String(domainName ?? '').replace(/^\*\./, ''));
  if (!domain) return { found: false };

  // A folder whose certificate cannot be read has no usable paths to offer.
  const certs = (await listAllCerts({ sslDir: dir })).filter((c) => c.status !== 'error');
  if (certs.length === 0) return { found: false };

  const candidates = [];
  for (const cert of certs) {
    if (normalizeForMatch(cert.domain) === domain) {
      candidates.push({ match: 'exact', cert, specificity: 0 });
    }
  }

  if (candidates.length === 0) {
    for (const cert of certs) {
      const info = await describeCertificate(cert.domain, { sslDir: dir });
      const names = (info.names ?? []).map(normalizeForMatch);

      if (names.includes(domain)) {
        candidates.push({ match: 'san', cert, specificity: 0 });
        continue;
      }
      const wildcard = names.find((n) => wildcardCovers(n, domain));
      if (wildcard) {
        candidates.push({ match: 'wildcard', cert, specificity: wildcard.length });
      }
    }
  }

  if (candidates.length === 0) return { found: false };

  candidates.sort(
    (a, b) =>
      MATCH_RANK[a.match] - MATCH_RANK[b.match] ||
      b.specificity - a.specificity ||
      a.cert.domain.localeCompare(b.cert.domain)
  );

  const best = candidates[0];
  const paths = getDefaultCertPaths(best.cert.domain, process.platform, dir);
  const info = await describeCertificate(best.cert.domain, { sslDir: dir });

  return {
    found: true,
    match: best.match,
    certificate: {
      domain: best.cert.domain,
      names: info.names ?? [best.cert.domain],
      certPath: paths.certPath,
      keyPath: paths.keyPath,
      expiry: best.cert.expiry ?? null,
      daysLeft: best.cert.daysLeft ?? null,
      status: best.cert.status,
    },
  };
}
