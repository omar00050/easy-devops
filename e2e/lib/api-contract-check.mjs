/**
 * e2e/lib/api-contract-check.mjs
 *
 * Holds API-CONTRACT.md to the routes the code actually registers.
 *
 * Both halves are read from the real artifacts rather than a hand-kept list:
 *
 *   - the mount prefixes come from `app.use('<prefix>', <router>)` in
 *     src/dashboard/server.js
 *   - the paths and methods come from each router's own Express stack, by
 *     importing the module and reading `router.stack`
 *
 * Importing the routers is safe and deliberate: a route module registers
 * handlers and nothing else — no listener, no side effects. It does pull in
 * controllers and therefore core/db.js, which is why this runs under the
 * runner's EZ_TEST data directory like everything else.
 *
 * Why not a regex over the route files: a regex cannot see a route added
 * through a helper, a loop, or a nested router, and would quietly pass. The
 * Express stack is what the server will actually serve.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SERVER_FILE = path.join(ROOT, 'src', 'dashboard', 'server.js');
const ROUTES_DIR = path.join(ROOT, 'src', 'dashboard', 'routes');
const CONTRACT_FILE = path.join(ROOT, 'API-CONTRACT.md');

/** Methods worth contracting. HEAD and OPTIONS are derived, not declared. */
const METHODS = Object.freeze(['get', 'post', 'put', 'patch', 'delete']);

/**
 * Reads the router mounts out of server.js.
 *
 * Matches `app.use('/api/x', somethingRouter)` and maps the identifier back to
 * its import specifier, so the prefix and the file stay tied together.
 *
 * @returns {Array<{ prefix: string, file: string }>}
 */
function readMounts() {
  const source = fs.readFileSync(SERVER_FILE, 'utf8');

  // identifier -> routes file
  const imports = new Map();
  for (const m of source.matchAll(/^import\s+(\w+)\s+from\s+'\.\/routes\/([\w-]+)\.js';/gm)) {
    imports.set(m[1], `${m[2]}.js`);
  }

  const mounts = [];
  for (const m of source.matchAll(/app\.use\(\s*'([^']+)'\s*,\s*(\w+)\s*\)/g)) {
    const [, prefix, identifier] = m;
    const file = imports.get(identifier);
    // Skips middleware mounts such as requireLocalRequest(...), which are not
    // routers and register no paths.
    if (file) mounts.push({ prefix, file });
  }

  return mounts;
}

/**
 * Joins a mount prefix and a router-relative path into the served path.
 * @param {string} prefix
 * @param {string} routePath
 */
function joinPath(prefix, routePath) {
  if (routePath === '/') return prefix;
  return `${prefix.replace(/\/$/, '')}${routePath}`;
}

/**
 * Every route the dashboard registers, as `METHOD /path` strings.
 * @returns {Promise<string[]>}
 */
export async function readRegisteredRoutes() {
  const routes = new Set();

  for (const { prefix, file } of readMounts()) {
    const mod = await import(pathToFileURL(path.join(ROUTES_DIR, file)).href);
    const router = mod.default;

    if (!router || !Array.isArray(router.stack)) {
      throw new Error(`routes/${file} does not export an Express router`);
    }

    for (const layer of router.stack) {
      // A layer without `.route` is middleware (requireAuth, for instance).
      if (!layer.route) continue;

      for (const method of METHODS) {
        if (layer.route.methods?.[method]) {
          routes.add(`${method.toUpperCase()} ${joinPath(prefix, layer.route.path)}`);
        }
      }
    }
  }

  return [...routes].sort();
}

/**
 * Every endpoint the contract documents.
 *
 * Endpoints appear in the contract's tables as a method cell and a path cell
 * holding a backticked path, and inline as bold or backticked
 * `METHOD /api/...`. Both forms are accepted so the document can read
 * naturally; the table rows are what matter.
 *
 * @returns {string[]}
 */
export function readContractEndpoints() {
  const source = fs.readFileSync(CONTRACT_FILE, 'utf8');
  const endpoints = new Set();

  // Table rows: | GET | `/api/thing` | … |
  const rowPattern = new RegExp(
    `^\\|\\s*(${METHODS.join('|').toUpperCase()})\\s*\\|\\s*\`([^\`]+)\`\\s*\\|`,
    'gim'
  );
  for (const m of source.matchAll(rowPattern)) {
    endpoints.add(`${m[1].toUpperCase()} ${m[2].trim()}`);
  }

  // Prose headings: **`POST /api/login`** or `GET /api/auth`
  const prosePattern = new RegExp(
    `\`(${METHODS.join('|').toUpperCase()})\\s+(/api[^\`]*)\``,
    'gi'
  );
  for (const m of source.matchAll(prosePattern)) {
    endpoints.add(`${m[1].toUpperCase()} ${m[2].trim()}`);
  }

  return [...endpoints].sort();
}

/** The contract version declared at the top of the document. */
export function readContractVersion() {
  const source = fs.readFileSync(CONTRACT_FILE, 'utf8');
  const m = source.match(/\*\*Contract version:\s*([0-9]+\.[0-9]+\.[0-9]+)\*\*/);
  return m ? m[1] : null;
}

/**
 * Compares the two sides.
 *
 * @returns {Promise<{ ok: boolean, problems: string[], counts: { code: number, doc: number } }>}
 */
export async function checkApiContract() {
  const problems = [];

  if (!fs.existsSync(CONTRACT_FILE)) {
    return {
      ok: false,
      counts: { code: 0, doc: 0 },
      problems: ['API-CONTRACT.md is missing — it is the authoritative API contract'],
    };
  }

  if (!readContractVersion()) {
    problems.push(
      'API-CONTRACT.md has no "**Contract version: X.Y.Z**" line at the top'
    );
  }

  let registered;
  try {
    registered = await readRegisteredRoutes();
  } catch (err) {
    return {
      ok: false,
      counts: { code: 0, doc: 0 },
      problems: [`could not read the registered routes: ${err.message}`],
    };
  }

  const documented = readContractEndpoints();

  const undocumented = registered.filter((r) => !documented.includes(r));
  const stale = documented.filter((d) => !registered.includes(d));

  for (const route of undocumented) {
    problems.push(`registered but NOT in API-CONTRACT.md:  ${route}`);
  }
  for (const route of stale) {
    problems.push(`in API-CONTRACT.md but NOT registered:  ${route}`);
  }

  return {
    ok: problems.length === 0,
    problems,
    counts: { code: registered.length, doc: documented.length },
  };
}
