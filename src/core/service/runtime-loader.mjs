import { fileURLToPath } from 'node:url';
import boundary from './runtime-boundary.cjs';

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (result.url.startsWith('node:')) return result;
  if (!result.url.startsWith('file:')) {
    throw Object.assign(new Error('Dependency is outside the daemon runtime'), { code: 'MODULE_NOT_FOUND' });
  }
  boundary.check(fileURLToPath(result.url));
  return result;
}
