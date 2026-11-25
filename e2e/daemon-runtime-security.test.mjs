import './lib/guard.mjs';
import { TEST_DATA_DIR } from './lib/guard.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const { installRuntimeStubs, OPTIONAL_DAEMON_PACKAGES } = await import('../src/core/service/runtime.js');
const root = path.join(TEST_DATA_DIR, 'runtime', 'app');
for (const file of ['package.json', 'src/cli/index.js', 'src/core/service/runtime-boundary.cjs', 'src/core/service/runtime-loader.mjs']) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(new URL(`../${file}`, import.meta.url), target);
}
installRuntimeStubs(root);
installRuntimeStubs(root);
const genuinePackage = path.join(root, 'node_modules', 'snappy');
fs.rmSync(genuinePackage, { recursive: true, force: true });
fs.mkdirSync(genuinePackage, { recursive: true });
fs.writeFileSync(path.join(genuinePackage, 'package.json'), JSON.stringify({ name: 'snappy', main: 'index.js' }));
fs.writeFileSync(path.join(genuinePackage, 'index.js'), 'module.exports = "genuine";\n');
installRuntimeStubs(root);
assert.match(
  fs.readFileSync(path.join(genuinePackage, 'easy-devops-optional.cjs'), 'utf8'),
  /Optional module snappy unavailable/,
);
assert.equal(fs.existsSync(path.join(genuinePackage, 'index.js')), false);
fs.rmSync(genuinePackage, { recursive: true, force: true });
installRuntimeStubs(root);
const external = path.join(TEST_DATA_DIR, 'node_modules', 'outside-fixture');
fs.mkdirSync(external, { recursive: true });
fs.writeFileSync(path.join(external, 'index.js'), 'module.exports = 1');
const externalNative = path.join(TEST_DATA_DIR, 'node_modules', 'outside-native.node');
fs.writeFileSync(externalNative, 'not a native addon');
fs.mkdirSync(path.join(root, 'src/core/daemon'));
fs.writeFileSync(path.join(root, 'src/core/daemon/run.js'), `
  import assert from 'node:assert/strict';
  import { createRequire } from 'node:module';
  const require = createRequire(import.meta.url);
  export async function runDaemon() {
    assert.equal(process.env.WS_NO_BUFFER_UTIL, '1');
    assert.equal(process.env.WS_NO_UTF_8_VALIDATE, '1');
    for (const name of ${JSON.stringify(OPTIONAL_DAEMON_PACKAGES)}) {
      assert.ok(require.resolve(name).startsWith(${JSON.stringify(root + path.sep)}));
      assert.throws(() => require(name), /Optional module/);
    }
    assert.throws(() => require.resolve('outside-fixture'), /outside the daemon runtime/);
    await assert.rejects(import('outside-fixture'), /outside the daemon runtime/);
    assert.throws(() => process.dlopen({ exports: {} }, ${JSON.stringify(externalNative)}), /outside the daemon runtime/);
    return 0;
  }
`);
const loader = pathToFileURL(path.join(root, 'src/core/service/runtime-loader.mjs')).href;
for (const options of [[`--experimental-loader=${loader}`], ...(typeof (await import('node:module')).register === 'function' ? [[]] : [])]) {
  const child = spawnSync(process.execPath, [...options, path.join(root, 'src/cli/index.js'), 'daemon'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(child.status, 0, child.stderr);
}
// Exercise the installed transitive dependencies without starting any jobs.
const boundary = new URL('../src/core/service/runtime-boundary.cjs', import.meta.url);
const realLoader = new URL('../src/core/service/runtime-loader.mjs', import.meta.url);
const daemon = new URL('../src/core/daemon/run.js', import.meta.url);
const probe = `const { createRequire } = await import('node:module');
  const baseline = new Set(Object.keys(createRequire(${JSON.stringify(boundary.href)}).cache));
  const mod = await import(${JSON.stringify(daemon.href)});
  if (typeof mod.runDaemon !== 'function') throw new Error('Daemon entry missing');
  const require = createRequire(${JSON.stringify(boundary.href)});
  for (const file of Object.keys(require.cache)) if (!baseline.has(file)) require('./runtime-boundary.cjs').check(file);`;
const real = spawnSync(process.execPath, [`--experimental-loader=${realLoader.href}`, '--require',
  fileURLToPath(boundary), '--input-type=module', '-e', `const boundary = await import(${JSON.stringify(boundary.href)}); boundary.default.install(); ${probe}`],
{ encoding: 'utf8', timeout: 30000 });
assert.equal(real.status, 0, real.stderr);
console.log('PASS  daemon rejects external CommonJS, ESM and native dependencies, replaces pre-seeded optionals and uses local fallbacks');
