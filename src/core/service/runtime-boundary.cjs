// Shared by the CommonJS resolver and the ESM loader. Only builtins and files
// whose final filesystem location is in this application belong to the daemon.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = fs.realpathSync.native(path.resolve(__dirname, '../../..'));
const originalDlopen = process.dlopen;
let installed = false;
let resolveGuardInstalled = false;
let dlopenGuardInstalled = false;

function check(filename) {
  if (filename.startsWith('node:') || Module.builtinModules.includes(filename)) return filename;
  const relative = path.relative(root, fs.realpathSync.native(filename));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw Object.assign(new Error('Dependency is outside the daemon runtime'), { code: 'MODULE_NOT_FOUND' });
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
    process.dlopen = function guardedDlopen(module, filename, flags) {
      check(filename);
      return originalDlopen.call(this, module, filename, flags);
    };
    dlopenGuardInstalled = true;
  }
  installed = true;
}

function isInstalled() {
  return installed;
}

module.exports = { check, install, isInstalled };
