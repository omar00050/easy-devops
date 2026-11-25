/**
 * Deployment log redaction.
 *
 * A deployed application can print its environment or authentication material
 * into build output. Persisted logs outlive the app setting that supplied those
 * values, so redacting only when a log is read with the CURRENT app record is
 * not enough: removing a token from Settings does not invalidate the copy in an
 * older log.
 *
 * This module therefore redacts at the writer. The caller snapshots the values
 * before a deployment begins and passes that immutable set through the stream.
 *
 * Two kinds of input need state across chunks:
 *
 *   1. an exact secret can be split anywhere, including inside a UTF-8
 *      character that Node has already decoded for us;
 *   2. a PEM private-key block can cross lines and chunks. Dropping only the
 *      BEGIN/END lines would still persist its body.
 *
 * Writes are delayed only while a suffix might be the beginning of a secret or
 * marker. Everything else is released immediately.
 */

export const LOG_SECURITY_REDACTED_V1 = 'redacted-v1';

const REPLACEMENT = '***';
const BEGIN_MARKER = '-----BEGIN ';
const END_MARKER = '-----END ';
const PRIVATE_MARKER_SUFFIX = 'PRIVATE KEY-----';
const MAX_PEM_LABEL_CHARS = 256;

const PRIVATE_BLOCK_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const PRIVATE_BLOCK_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

/**
 * Every value that must never be written to a deployment run.
 *
 * The Git token is stored outside `env`. Its HTTP Basic representation is
 * included because a failed Git command can echo the header while containing
 * neither the original token nor a value the app itself receives.
 *
 * @param {{env?: Object<string, *>, auth?: {token?: string|null}}} app
 * @returns {string[]}
 */
export function snapshotDeploySecrets(app) {
  const values = Object.values(app?.env ?? {})
    .filter((value) => typeof value === 'string' && value.length > 0);

  const token = typeof app?.auth?.token === 'string' ? app.auth.token : '';
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    values.push(
      token,
      basic,
      `Authorization: Basic ${basic}`,
      `x-access-token:${token}`,
    );
  }

  return [...new Set(values)].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/**
 * A streaming exact-value redactor.
 *
 * It keeps only the longest suffix that is still a prefix of a configured
 * secret. A match split over two writes is therefore completed before the
 * matched bytes are released. `flush()` releases a harmless unmatched prefix
 * when the stream ends.
 *
 * @param {string[]} secrets
 * @returns {{write(chunk: unknown): string, flush(): string}}
 */
export function createExactSecretRedactor(secrets) {
  const values = [...new Set(
    (Array.isArray(secrets) ? secrets : [])
      .filter((value) => typeof value === 'string' && value.length > 0),
  )].sort((a, b) => b.length - a.length || a.localeCompare(b));

  let pending = '';

  function render(final = false) {
    let out = '';

    while (pending.length > 0) {
      let firstIndex = -1;
      let firstValue = null;
      for (const value of values) {
        const index = pending.indexOf(value);
        if (index !== -1 && (firstIndex === -1 || index < firstIndex)) {
          firstIndex = index;
          firstValue = value;
        }
      }

      if (firstValue !== null) {
        out += pending.slice(0, firstIndex) + REPLACEMENT;
        pending = pending.slice(firstIndex + firstValue.length);
        continue;
      }

      if (final) {
        out += pending;
        pending = '';
        break;
      }

      let suffixLength = 0;
      for (const value of values) {
        const max = Math.min(pending.length, value.length - 1);
        for (let length = max; length > suffixLength; length--) {
          if (value.startsWith(pending.slice(-length))) {
            suffixLength = length;
            break;
          }
        }
      }

      const release = pending.length - suffixLength;
      out += pending.slice(0, release);
      pending = pending.slice(release);
      break;
    }

    return out;
  }

  return {
    write(chunk) {
      pending += String(chunk ?? '');
      return render(false);
    },
    flush() {
      return render(true);
    },
  };
}

/**
 * Removes complete PEM private-key blocks from a text stream.
 *
 * Only a possible marker prefix is retained. While inside a key block the
 * body is discarded immediately, so a malformed or never-ending key cannot
 * turn into an unbounded buffer.
 *
 * @returns {{write(chunk: unknown): string, flush(): string}}
 */
export function createPemRedactor() {
  let pending = '';
  let inPrivateKey = false;

  /** Longest suffix of `text` that can begin one of the two markers. */
  function markerSuffix(text, marker) {
    const max = Math.min(text.length, marker.length - 1);
    for (let length = max; length > 0; length--) {
      if (marker.startsWith(text.slice(-length))) return length;
    }
    return 0;
  }

  function appendPending(result, text, final) {
    if (!text) return result;

    if (!final && text.length > MAX_PEM_LABEL_CHARS * 2) {
      const beginAt = text.indexOf(BEGIN_MARKER);
      if (beginAt !== -1 && !PRIVATE_BLOCK_BEGIN.test(text.slice(beginAt))) {
        /*
         * A standard PEM label is short. A much longer apparent header is
         * ordinary log output, but we still avoid retaining it indefinitely.
         * Keep a bounded suffix that could become a new marker.
         */
        const keep = Math.max(markerSuffix(text, BEGIN_MARKER), markerSuffix(text, END_MARKER));
        return result + text.slice(0, text.length - keep) + (keep ? '' : '') + text.slice(text.length - keep);
      }
    }

    return result + text;
  }

  function process(final = false) {
    let out = '';
    let buffer = pending;
    pending = '';

    while (buffer.length > 0) {
      if (inPrivateKey) {
        const complete = buffer.match(PRIVATE_BLOCK_END);
        if (complete) {
          buffer = buffer.slice(complete.index + complete[0].length);
          inPrivateKey = false;
          continue;
        }

        const endAt = buffer.lastIndexOf(END_MARKER);
        if (endAt !== -1) {
          if (buffer.length - endAt <= MAX_PEM_LABEL_CHARS) {
            pending = buffer.slice(endAt);
            return out;
          }
          // Too long to be a standard END marker: keep discarding the body.
          return out;
        }

        const keep = markerSuffix(buffer, END_MARKER);
        if (keep > 0) pending = buffer.slice(-keep);
        return out;
      }

      const complete = buffer.match(PRIVATE_BLOCK_BEGIN);
      if (complete) {
        out += buffer.slice(0, complete.index);
        buffer = buffer.slice(complete.index + complete[0].length);
        inPrivateKey = true;
        continue;
      }

      const beginAt = buffer.lastIndexOf(BEGIN_MARKER);
      if (beginAt !== -1) {
        const candidate = buffer.slice(beginAt);
        const looksLikePrivate = candidate.includes('PRIVATE KEY');
        if (looksLikePrivate || (final && buffer.length - beginAt >= MAX_PEM_LABEL_CHARS)) {
          /*
           * Once the text contains "PRIVATE KEY", a malformed header that
           * never closes is treated as a key block to fail safe. Text after a
           * short generic "BEGIN" is not dropped.
           */
          out += buffer.slice(0, beginAt);
          inPrivateKey = looksLikePrivate;
          pending = inPrivateKey ? '' : candidate;
          return out;
        }
        if (buffer.length - beginAt <= MAX_PEM_LABEL_CHARS) {
          out += buffer.slice(0, beginAt);
          pending = candidate;
          return out;
        }
      }

      if (final) {
        out += buffer;
        buffer = '';
        break;
      }

      const keep = Math.max(markerSuffix(buffer, BEGIN_MARKER), markerSuffix(buffer, END_MARKER));
      out += buffer.slice(0, buffer.length - keep);
      pending = keep > 0 ? buffer.slice(-keep) : '';
      break;
    }

    return out;
  }

  return {
    write(chunk) {
      pending = appendPending(pending, String(chunk ?? ''), false);
      return process(false);
    },
    flush() {
      const tail = process(true);
      const result = inPrivateKey ? tail : tail + pending;
      pending = '';
      inPrivateKey = false;
      return result;
    },
  };
}

/**
 * A redacting stream that applies exact values and PEM removal in the order a
 * log is written.
 *
 * @param {string[]} secrets
 */
export function createDeployLogRedactor(secrets = []) {
  const exact = createExactSecretRedactor(secrets);
  const pem = createPemRedactor();

  return {
    write(chunk) {
      return pem.write(exact.write(chunk));
    },
    flush() {
      return pem.write(exact.flush()) + pem.flush();
    },
  };
}

/**
 * Convenience wrapper for a value that is complete before it is sanitized.
 *
 * @param {unknown} text
 * @param {string[]} secrets
 * @returns {string}
 */
export function sanitizeDeployText(text, secrets = []) {
  const redactor = createDeployLogRedactor(secrets);
  return redactor.write(text) + redactor.flush();
}

/** Whether a run's stored log is safe to return to a reader. */
export function isRedactedDeployRun(run) {
  return run?.logSecurity === LOG_SECURITY_REDACTED_V1;
}

export const DEPLOY_LOG_MARKERS = Object.freeze({
  privateMarkerSuffix: PRIVATE_MARKER_SUFFIX,
  begin: BEGIN_MARKER,
  end: END_MARKER,
});
