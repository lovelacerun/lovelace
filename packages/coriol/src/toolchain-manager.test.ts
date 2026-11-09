import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ToolchainManager } from './toolchain-manager.js';
import type { WorkspaceToolchain } from './types.js';

test('a failed seed install cannot leave the previous warm marker valid', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coriol-warm-failure-'));
  const seed = join(root, 'seed');
  let input = 'a';
  let fail = false;
  let installs = 0;
  const toolchain: WorkspaceToolchain = {
    id: 'fixture', command: 'install', detect: async () => true,
    fingerprint: async () => input,
    artifacts: async () => ['node_modules'],
    validate: async () => existsSync(join(seed, 'node_modules/version')) && await readFile(join(seed, 'node_modules/version'), 'utf8') === input,
    async prepare() {
      installs++;
      await mkdir(join(seed, 'node_modules'), { recursive: true });
      await writeFile(join(seed, 'node_modules/version'), input);
      if (fail) throw new Error('interrupted install');
    },
  };
  const repository = { id: 'fixture', cloneUrl: '', path: seed };
  const manager = new ToolchainManager(join(root, 'state'), [toolchain], {});
  try {
    assert.equal((await manager.prepareSeed(repository, 'workspace')).size, 1);
    input = 'b'; fail = true;
    assert.equal((await manager.prepareSeed(repository, 'workspace')).size, 0);
    input = 'a'; fail = false;
    // Even a partial install that superficially looks like a is not a successful preparation.
    await writeFile(join(seed, 'node_modules/version'), 'a');
    assert.equal((await manager.prepareSeed(repository, 'workspace')).size, 1);
    assert.equal(installs, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed validation never publishes a successful workspace marker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coriol-invalid-install-'));
  let valid = false;
  let installs = 0;
  const toolchain: WorkspaceToolchain = {
    id: 'fixture', command: 'install', detect: async () => true,
    fingerprint: async () => 'stable', artifacts: async () => [], validate: async () => valid,
    prepare: async () => { installs++; },
  };
  const manager = new ToolchainManager(root, [toolchain], {});
  const repository = { id: 'fixture', cloneUrl: '', path: root };
  try {
    await assert.rejects(manager.prepareWorkspace(repository, 'workspace', root, new Map()), /does not match/);
    valid = true;
    assert.equal((await manager.prepareWorkspace(repository, 'workspace', root, new Map()))[0]!.strategy, 'install');
    assert.equal((await manager.prepareWorkspace(repository, 'workspace', root, new Map()))[0]!.strategy, 'reuse');
    assert.equal(installs, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
