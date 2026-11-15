/**
 * core/installSource.js
 *
 * How this copy of Easy DevOps got onto the machine, and therefore how it is
 * updated.
 *
 * ── Why this has to be detected rather than assumed ───────────────────────
 *
 * `ezz update` ran `npm install -g easy-devops`. For a globally installed
 * package that is right. For a git clone it is actively wrong in two ways: it
 * installs a SECOND copy from the registry, and the service keeps pointing at
 * the clone — so the update reports success and changes nothing the service
 * runs. Worse, the two copies then disagree about which is "the" version, and
 * the clone, which is the one actually running, is the one that looks stale.
 *
 * A clone is updated with `git pull`. That is not something this tool should do
 * on the user's behalf: a pull can conflict, can fast-forward past local
 * commits, and the working tree may be dirty with work in progress. So the
 * honest answer is to say what to run.
 *
 * ── How it is decided ─────────────────────────────────────────────────────
 *
 * By the package root on disk, not by anything recorded in the database:
 *
 *   - a `.git` entry in the package root           -> clone
 *   - the root sits inside a `node_modules` tree    -> npm install
 *   - neither                                       -> unknown
 *
 * `.git` can be a FILE rather than a directory (a worktree or a submodule
 * records a gitdir pointer there), so both count.
 *
 * `npm link` makes a global symlink INTO a clone. That is still a clone — the
 * files the service runs are the clone's, and `npm install -g` would replace
 * the link rather than update them — so the `.git` test is deliberately first.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { isWindows } from './platform.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * @typedef {Object} InstallSource
 * @property {'clone'|'npm'|'unknown'} kind
 * @property {string} root            The package root on disk
 * @property {boolean} npmUpdatable   Whether `npm install -g` updates THIS copy
 * @property {string} reason          One line, for a status display
 * @property {string[]} howToUpdate   The commands to run instead, if any
 */

/**
 * Where this copy lives and how it is updated.
 *
 * @param {Object} [opts]
 * @param {string} [opts.root] Package root; defaults to this file's package
 * @returns {InstallSource}
 */
export function detectInstallSource({ root = packageRoot() } = {}) {
  const resolved = path.resolve(root);

  if (hasGitDir(resolved)) {
    return {
      kind: 'clone',
      root: resolved,
      npmUpdatable: false,
      reason: `a git clone at ${resolved}`,
      howToUpdate: [
        `cd ${resolved}`,
        'git pull',
        'npm install',
        'ezz service restart',
      ],
    };
  }

  if (insideNodeModules(resolved)) {
    return {
      kind: 'npm',
      root: resolved,
      npmUpdatable: true,
      reason: `an npm-installed package at ${resolved}`,
      howToUpdate: [],
    };
  }

  // An extracted tarball, or a copy someone placed by hand. `npm install -g`
  // would install a separate copy from the registry and leave this one in
  // place, so it is not treated as updatable.
  return {
    kind: 'unknown',
    root: resolved,
    npmUpdatable: false,
    reason: `an unpackaged copy at ${resolved} (no .git, not under node_modules)`,
    howToUpdate: [
      'Reinstall it the way you want it managed:',
      '  npm install -g easy-devops        (then remove this copy)',
      '  git clone https://github.com/omar00050/Easy-DevOps.git',
    ],
  };
}

/** This package's root directory. */
export function packageRoot() {
  // core/ -> src/ -> the package root.
  return path.resolve(__dirname, '..', '..');
}

/** `.git` as either a directory or a pointer file. */
function hasGitDir(root) {
  try {
    fs.statSync(path.join(root, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a path sits inside a node_modules tree.
 *
 * Compared segment by segment rather than with a substring test, so a project
 * directory that merely contains the text "node_modules" in its name is not
 * mistaken for an installed package. Case-insensitive on Windows, where paths
 * are.
 */
function insideNodeModules(root) {
  const segments = root.split(/[\\/]+/).map((s) => (isWindows ? s.toLowerCase() : s));
  return segments.includes('node_modules');
}

/**
 * The lines to print when an operation cannot proceed because this copy is not
 * npm-managed.
 *
 * @param {InstallSource} source
 * @param {string} what What the caller was asked to do, e.g. 'update'
 * @returns {string[]}
 */
export function describeUnmanaged(source, what = 'update') {
  const lines = [];

  if (source.kind === 'clone') {
    lines.push(`This is ${source.reason}, not an npm install.`);
    lines.push('');
    lines.push(`Running npm would install a second copy from the registry and`);
    lines.push(`leave the service running this one, so the ${what} would report`);
    lines.push('success and change nothing. Update the clone instead:');
  } else {
    lines.push(`This is ${source.reason}.`);
    lines.push('');
    lines.push(`npm cannot ${what} it in place.`);
  }

  lines.push('');
  for (const line of source.howToUpdate) lines.push(`  ${line}`);
  lines.push('');

  return lines;
}
