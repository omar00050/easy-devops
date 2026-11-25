// The ESM half of the daemon's confinement. `resolve` sees import specifiers;
// `boundary.check` is what decides, and it is shared with the CommonJS resolver
// and the dlopen guard so all three agree on the package root.
//
// Confinement blocks only what is OUTSIDE the installed package. The package's
// own files and its dependency tree - native addons included, because dlopen is
// guarded separately - load normally.
import { fileURLToPath } from 'node:url';
import boundary from './runtime-boundary.cjs';

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (result.url.startsWith('node:')) return result;
  if (!result.url.startsWith('file:')) {
    throw Object.assign(
      new Error(`Dependency is outside the daemon runtime: ${result.url}`),
      { code: 'MODULE_NOT_FOUND' },
    );
  }
  boundary.check(fileURLToPath(result.url));
  return result;
}
