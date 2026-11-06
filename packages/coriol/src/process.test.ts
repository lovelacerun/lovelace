import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { run, withEnvironmentPolicy, type CommandEnvironmentPolicy } from './process.js';

test('executes directly with the inherited environment by default', async () => {
  const output = await run(process.execPath, ['-e', 'process.stdout.write(process.env.PATH ?? "")'], process.cwd());
  assert.equal(output, process.env.PATH ?? '');
});

test('uses exactly the injected environment without discovering direnv or Volta', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coriol-process-'));
  try {
    await writeFile(join(root, 'direnv'), '#!/bin/sh\nexit 42\n');
    await chmod(join(root, 'direnv'), 0o700);
    const output = await withEnvironmentPolicy(
      (request) => ({ ...request, env: { PATH: root, POLICY: 'injected' } }),
      () => run(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({ path: process.env.PATH, home: process.env.HOME, policy: process.env.POLICY }))'], root),
    );
    assert.deepEqual(JSON.parse(output), { path: root, policy: 'injected' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('environment policies remain scoped across concurrent operations and nested calls', async () => {
  const policy = (value: string): CommandEnvironmentPolicy => (request) => ({
    ...request,
    command: process.execPath,
    args: ['-e', `process.stdout.write(${JSON.stringify(value)})`],
  });
  const results = await Promise.all([
    withEnvironmentPolicy(policy('first'), async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(await withEnvironmentPolicy(policy('nested'), () => run('unused', [], '.')), 'nested');
      return run('unused', [], '.');
    }),
    withEnvironmentPolicy(policy('second'), () => run('unused', [], '.')),
  ]);
  assert.deepEqual(results, ['first', 'second']);
  const outside = await run(process.execPath, ['-e', "process.stdout.write('outside')"], process.cwd());
  assert.equal(outside, 'outside');
});

test('reports stderr and non-zero exits', async () => {
  await assert.rejects(run(process.execPath, ['-e', 'process.stderr.write("broken"); process.exit(1)'], process.cwd()), /broken/);
  await assert.rejects(run(process.execPath, ['-e', 'process.exit(1)'], process.cwd()), /failed/);
});
