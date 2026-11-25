// Shared by the CommonJS resolver and the ESM loader. Only builtins and files
// whose final filesystem location is in this application belong to the daemon.
//
// The confinement is about the *package*, not about a list of allowed names:
// everything the installed copy ships is allowed, including its native addons
// (better-sqlite3 is loaded from `node_modules/better-sqlite3/build/Release`,
// which is inside the package), and everything outside it is refused. Resolving
// the real path first is what makes that a boundary rather than a string check:
// a symlink inside the package that points at `/tmp/payload.node` resolves
// outside and is refused.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = fs.realpathSync.native(path.resolve(__dirname, '../../..'));
const originalDlopen = process.dlopen;
let installed = false;
let resolveGuardInstalled = false;
let dlopenGuardInstalled = false;

/**
 * The file's location on disk, or its absolute path when it does not exist.
 *
 * A file that is not there yet (a broken install, a package asking for an
 * optional addon) is not a confinement question: let the real loader report
 * its own "cannot find" error instead of pretending the path escaped.
 *
 * @param {string} filename
 * @returns {string}
 */
function locate(filename) {
  try {
    return fs.realpathSync.native(filename);
  } catch {
    return path.resolve(filename);
  }
}

function check(filename) {
  if (filename.startsWith('node:') || Module.builtinModules.includes(filename)) return filename;
  const relative = path.relative(root, locate(filename));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw Object.assign(
      new Error(`Dependency is outside the daemon runtime: ${filename}`),
      { code: 'MODULE_NOT_FOUND' },
    );
  }
  return filename;
}

function install() {
  if (!resolveGuardInstalled) {
    const resolve = Module._resolveFilename;
    Module._resolveFilename = function (...args) { return check(resolve.apply(this, args)); };
    resolveGuardInstalled = true;
  }
  if (!dlopenGuardInstalled) {
    // Forward the caller's own argument list rather than re-packing it.
    //
    // Node's native dlopen takes (module, filename[, flags]); the CommonJS
    // loader omits the optional flags, and a wrapper that always passed a third
    // argument would change what Node receives for every native addon in the
    // process. `arguments` keeps the call exactly as the caller wrote it, while
    // the filename is still checked first.
    process.dlopen = function guardedDlopen(module, filename) {
      check(filename);
      return Reflect.apply(originalDlopen, this, arguments);
    };
    dlopenGuardInstalled = true;
  }
  installed = true;
}

function isInstalled() {
  return installed;
}

module.exports = { check, install, isInstalled };
