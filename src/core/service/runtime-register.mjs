/**
 * core/service/runtime-register.mjs
 *
 * The daemon's confinement, installed before the entry script's first import.
 *
 * This module is what `--import` runs:
 *
 *   node --import <file URL of this module> <entry> daemon
 *
 * Two halves, because the daemon loads both kinds of module:
 *
 *  - the CommonJS half (`runtime-boundary.cjs`) patches the CommonJS resolver
 *    and `process.dlopen` in THIS thread;
 *  - the ESM half (`runtime-loader.mjs`) is handed to `module.register()`, which
 *    is what lets `--import` replace `--experimental-loader`. The hook thread is
 *    where Node runs an ESM loader, and it is the documented successor to the
 *    flag that printed "ExperimentalWarning: --experimental-loader may be
 *    removed in the future" on every daemon start.
 *
 * `module.register()` arrived in Node 18.19.0 and 20.6.0, so it is not on every
 * version this package supports (engines: >=18.0.0). Core decides per version
 * which command line to write - see `daemonNodeArgs()` in runtime.js - and an
 * older Node keeps the loader flag. Nothing here downgrades the confinement:
 * the same `runtime-boundary.cjs` check, against the same real path, decides
 * for both halves.
 *
 * `install()` is idempotent. The module runs it on load (that is the whole
 * point of `--import`), and `src/cli/index.js` calls it again for a daemon that
 * was started without the flag, so a second call must be a no-op rather than a
 * second loader in the chain.
 */

import * as nodeModule from 'node:module';

const require = nodeModule.createRequire(import.meta.url);

let installed = false;

/**
 * Whether this Node can confine the daemon through `--import` + register().
 *
 * `src/cli/index.js` asks before deciding to fail, so the explanation is given
 * once and in words a person can act on.
 *
 * @returns {boolean}
 */
export function supportsRegisterLoader() {
  return typeof nodeModule.register === 'function';
}

/**
 * Installs both halves of the confinement.
 *
 * @returns {boolean} true when this call installed it, false when it was
 *   already installed (or already running, from the `--import` module itself)
 */
export function install() {
  if (installed) return false;

  if (typeof nodeModule.register !== 'function') {
    throw new Error(
      'Run service repair to enable the daemon module loader, or use Node 18.19 or later. '
      + `This Node is ${process.version}, and its module.register() is what confines the daemon `
      + 'without the ExperimentalWarning; `ezz service repair` writes a command line '
      + 'that this version understands.',
    );
  }

  // The CommonJS guard is patched in this thread, before any of the daemon's
  // own code runs. It is a no-op when the boundary was already installed.
  require('./runtime-boundary.cjs').install();

  // The ESM guard. A relative specifier resolved against this module's URL, so
  // the loader is the one beside it - in the runtime copy that is the copy's
  // own loader, which confines to the copy.
  nodeModule.register('./runtime-loader.mjs', import.meta.url);

  installed = true;
  return true;
}

// Loaded with `--import`, so this is the earliest code the process runs: the
// daemon is confined before its entry script resolves its first import.
install();

export default install;
