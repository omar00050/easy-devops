/**
 * Bounded synchronous log reads shared by the Windows service modes.
 *
 * Service status and `ezz service logs` must remain useful when WinSW or the
 * Personal-mode supervisor has produced a large or newline-free log. Reading
 * the file first and slicing it afterwards defeats that guarantee because the
 * whole file is already resident. This reader seeks to a fixed byte tail and
 * always uses small fixed-size reads.
 */

import fs from 'node:fs';

export const SERVICE_LOG_TAIL_MAX_BYTES = 1024 * 1024;
export const SERVICE_LOG_TAIL_CHUNK_BYTES = 64 * 1024;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function trimLeadingUtf8Continuation(buffer) {
  let offset = 0;
  while (offset < buffer.length
    && offset < 3
    && (buffer[offset] & 0xc0) === 0x80) {
    offset += 1;
  }
  return offset === 0 ? buffer : buffer.subarray(offset);
}

/**
 * Read at most a fixed number of bytes from the end of one regular file.
 *
 * The caller drops the first line when `startsMidFile` is true. That line may
 * have begun before the bounded window and must not be presented as complete.
 */
export function readBoundedTailSync(file, {
  maxBytes = SERVICE_LOG_TAIL_MAX_BYTES,
  chunkBytes = SERVICE_LOG_TAIL_CHUNK_BYTES,
  fsApi = fs,
} = {}) {
  const budget = positiveInteger(maxBytes, SERVICE_LOG_TAIL_MAX_BYTES);
  const chunk = Math.min(
    positiveInteger(chunkBytes, SERVICE_LOG_TAIL_CHUNK_BYTES),
    budget,
  );

  let handle;
  try {
    handle = fsApi.openSync(
      file,
      fsApi.constants.O_RDONLY | (fsApi.constants.O_NOFOLLOW || 0),
    );
    const stat = fsApi.fstatSync(handle);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(`Refusing a linked or non-regular log at ${file}`);
    }

    const start = Math.max(0, stat.size - budget);
    const chunks = [];
    let bytesRead = 0;
    let maxReadRequest = 0;

    while (start + bytesRead < stat.size) {
      const length = Math.min(chunk, stat.size - (start + bytesRead));
      const buffer = Buffer.allocUnsafe(length);
      maxReadRequest = Math.max(maxReadRequest, length);
      const got = fsApi.readSync(handle, buffer, 0, length, start + bytesRead);
      if (got <= 0) break;
      chunks.push(buffer.subarray(0, got));
      bytesRead += got;
    }

    let content = Buffer.concat(chunks, bytesRead);
    const startsMidFile = start > 0;
    if (startsMidFile) content = trimLeadingUtf8Continuation(content);

    return {
      text: content.toString('utf8'),
      bytesRead,
      maxReadRequest,
      startsMidFile,
      size: stat.size,
    };
  } finally {
    if (handle !== undefined) {
      try { fsApi.closeSync(handle); } catch { /* already closed */ }
    }
  }
}

/** Split a bounded tail into complete-looking lines, newest last. */
export function completeLogLines(tail, limit = 5000) {
  const lines = tail.text.split(/\r?\n/);
  if (tail.startsMidFile && lines.length > 0) lines.shift();
  return lines.filter(Boolean).slice(-Math.max(1, Math.min(5000, Number(limit) || 50)));
}
