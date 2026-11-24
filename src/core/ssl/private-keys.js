import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isWindows, isServerMode } from '../platform.js';
import { approvedGrantDirs, canonicalAclDirectory } from '../service/acl.js';
import { runFile } from '../shell.js';
import { validateDomainName } from '../validators.js';

const aclScript = fileURLToPath(new URL('./key-permissions.ps1', import.meta.url));

async function assertCanonical(dir) {
  if (!path.isAbsolute(dir) || path.relative(path.resolve(dir), await fs.realpath(dir)) !== '') {
    throw new Error(`Choose an absolute SSL directory without symbolic links or junctions: ${dir}`);
  }
}

async function statIfPresent(file) {
  try { return await fs.lstat(file); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Protect the managed leaf directory only. sslDir may already hold unrelated data.
export async function protectKeyDirectory(sslDir, name, { create = true, server = isServerMode() } = {}) {
  if (name !== '.account' && (validateDomainName(name) || name.startsWith('*.')
      || (isWindows && /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(name)))) {
    throw new Error('Choose a valid domain for the private key directory.');
  }
  if (create) await fs.mkdir(sslDir, { recursive: true, mode: 0o700 });
  await assertCanonical(sslDir);
  const dir = path.join(sslDir, name);
  if (create) {
    try { await fs.mkdir(dir, { mode: 0o700 }); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  await assertCanonical(dir);
  const key = path.join(dir, name === '.account' ? 'account.key' : 'privkey.pem');
  const stat = await statIfPresent(key);
  if (stat && (!stat.isFile() || stat.nlink !== 1)) {
    throw new Error(`Replace the linked or non-regular private key at ${key} before continuing.`);
  }
  if (isWindows) {
    const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', aclScript, dir];
    if (server) args.push('-ServerMode');
    const result = await runFile(powershell, args);
    if (!result.success) throw new Error(`Cannot restrict private key access in ${dir}: ${result.stderr.trim()}`);
  } else {
    const directory = await fs.open(dir, constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.chmod(0o700); } finally { await directory.close(); }
    if (stat) {
      const handle = await fs.open(key, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.nlink !== 1) throw new Error(`Unsafe key file at ${key}`);
        await handle.chmod(0o600);
      } finally { await handle.close(); }
    }
  }
  return key;
}

// Only remove a temporary file that this invocation successfully created.
async function publishFile(file, data, replace) {
  const tmp = path.join(path.dirname(file), `.ez-${randomUUID()}.tmp`);
  const handle = await fs.open(tmp, 'wx', 0o600);
  try {
    try { await handle.writeFile(data); } finally { await handle.close(); }
    if (replace) await fs.rename(tmp, file);
    else await fs.link(tmp, file); // Publish the complete account key once, even across processes.
  } finally { await fs.rm(tmp, { force: true }); }
}

export function replaceCertificateFile(file, data) {
  return publishFile(file, data, true);
}

export async function loadAccountKey(sslDir, generate) {
  const file = await protectKeyDirectory(sslDir, '.account');
  const read = async () => {
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const data = await handle.readFile();
      if (!data.length) throw new Error(`Restore the empty ACME account key at ${file} from a backup.`);
      return data;
    } finally { await handle.close(); }
  };
  try { return await read(); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const key = await generate();
  try { await publishFile(file, key, false); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return read();
  }
  return key;
}

export async function repairPrivateKeys(sslDir, options = {}) {
  if (isWindows && options.server) {
    const approved = await approvedGrantDirs(runFile);
    if (!approved.some(dir => path.relative(dir, sslDir) === '')) throw new Error('SSL directory lacks administrator approval');
  }
  if (!await statIfPresent(sslDir)) return;
  if (isWindows && options.server) canonicalAclDirectory(sslDir);
  await assertCanonical(sslDir);
  for (const entry of await fs.readdir(sslDir, { withFileTypes: true })) {
    if (entry.name !== '.account' && validateDomainName(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error(`Remove the link at ${path.join(sslDir, entry.name)} before repair.`);
    if (!entry.isDirectory()) continue;
    const key = entry.name === '.account' ? 'account.key' : 'privkey.pem';
    if (await statIfPresent(path.join(sslDir, entry.name, key))) {
      await protectKeyDirectory(sslDir, entry.name, { ...options, create: false });
    }
  }
}
