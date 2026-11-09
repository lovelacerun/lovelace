import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { npmToolchain } from './npm-toolchain.js';
import { withEnvironmentPolicy, type CommandEnvironmentPolicy } from './process.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'coriol-npm-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config: Record<string, unknown> = { 'npm-version': '11.0.0', 'ignore-scripts': true, omit: [], include: [] };
  let runtime = 'node-24-abi-137';
  const policy: CommandEnvironmentPolicy = request => ({
    ...request, command: process.execPath,
    args: ['-e', `process.stdout.write(${JSON.stringify(request.command === 'node' ? runtime : request.args[0] === '--versions' ? JSON.stringify({ node: runtime, npm: config['npm-version'], modules: '137' }) : JSON.stringify(config))})`],
  });
  const json = async (file: string, data: unknown) => {
    await mkdir(join(root, file, '..'), { recursive: true });
    await writeFile(join(root, file), JSON.stringify(data));
  };
  await json('package.json', { name: 'fixture', version: '1.0.0' });
  await json('package-lock.json', { lockfileVersion: 3, packages: { '': { name: 'fixture', version: '1.0.0' }, 'node_modules/dep': { version: '1.0.0' } } });
  await json('node_modules/dep/package.json', { name: 'dep', version: '1.0.0' });
  const toolchain = npmToolchain();
  return { root, config, json, toolchain, setRuntime: (value: string) => { runtime = value; }, scoped: <T>(fn: () => Promise<T>) => withEnvironmentPolicy(policy, fn) };
}

test('fingerprints the effective runtime, npm version, install settings and user configuration', async t => {
  const f = await fixture(t);
  const fingerprint = () => f.scoped(() => f.toolchain.fingerprint(f.root));
  const original = await fingerprint();
  assert.equal(await fingerprint(), original);
  f.setRuntime('node-22-abi-127');
  assert.notEqual(await fingerprint(), original);
  f.setRuntime('node-24-abi-137');
  f.config['npm-version'] = '11.1.0';
  assert.notEqual(await fingerprint(), original);
  f.config['npm-version'] = '11.0.0';
  f.config.omit = ['dev'];
  assert.notEqual(await fingerprint(), original);
  f.config.omit = [];
  f.config.userconfig = join(f.root, 'user-npmrc');
  await writeFile(f.config.userconfig as string, 'ignore-scripts=true\n');
  const before = await fingerprint();
  await writeFile(f.config.userconfig as string, 'ignore-scripts=false\n');
  assert.notEqual(await fingerprint(), before);
});

test('finds every workspace module tree and validates non-hoisted packages', async t => {
  const f = await fixture(t);
  await f.json('package-lock.json', { packages: {
    '': {}, 'packages/app': {}, 'node_modules/dep': { version: '1.0.0' },
    'packages/app/node_modules/dep': { version: '2.0.0' },
  } });
  assert.equal(await f.scoped(() => f.toolchain.validate(f.root)), false);
  await f.json('packages/app/node_modules/dep/package.json', { version: '2.0.0' });
  assert.deepEqual(await f.toolchain.artifacts(f.root), ['node_modules', 'packages/app/node_modules']);
  assert.equal(await f.scoped(() => f.toolchain.validate(f.root)), true);
  await f.json('packages/app/node_modules/dep/package.json', { version: '1.0.0' });
  assert.equal(await f.scoped(() => f.toolchain.validate(f.root)), false);
});

test('validates required versions while respecting omitted and optional dependencies', async t => {
  const f = await fixture(t);
  await f.json('package-lock.json', { packages: {
    '': {}, 'node_modules/dep': { version: '1.0.0' },
    'node_modules/dev': { version: '2.0.0', dev: true },
    'node_modules/platform': { version: '3.0.0', optional: true },
  } });
  const validate = () => f.scoped(() => f.toolchain.validate(f.root));
  assert.equal(await validate(), false);
  f.config.omit = ['dev'];
  assert.equal(await validate(), true);
  f.config.include = ['dev'];
  assert.equal(await validate(), false);
  await f.json('node_modules/dev/package.json', { version: 'v2.0.0' });
  assert.equal(await validate(), true);
  await f.json('node_modules/dep/package.json', { version: '0.9.0' });
  assert.equal(await validate(), false);
});

test('rejects workspace links pointing into a seed or another checkout', async t => {
  const f = await fixture(t);
  await f.json('packages/app/package.json', { name: 'app', version: '1.0.0' });
  await f.json('package-lock.json', { packages: { '': {}, 'packages/app': { version: '1.0.0' }, 'node_modules/app': { link: true, resolved: 'packages/app' } } });
  await symlink('../packages/app', join(f.root, 'node_modules/app'));
  assert.equal(await f.scoped(() => f.toolchain.validate(f.root)), true);
  await rm(join(f.root, 'node_modules/app'));
  await symlink('dep', join(f.root, 'node_modules/app'));
  assert.equal(await f.scoped(() => f.toolchain.validate(f.root)), false);
});

test('does not cache lifecycle outputs outside node_modules when scripts are enabled', async t => {
  const f = await fixture(t);
  await f.json('package.json', { name: 'fixture', scripts: { prepare: 'generate-lib' } });
  assert.ok(await f.scoped(() => f.toolchain.fingerprint(f.root)));
  f.config['ignore-scripts'] = false;
  assert.equal(await f.scoped(() => f.toolchain.fingerprint(f.root)), null);
});
