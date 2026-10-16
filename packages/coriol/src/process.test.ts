import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { run, withCommandRunner } from './process.js';

test('runs toolchain commands through direnv when available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coriol-process-'));
  const bin = join(root, 'bin');
  const direnv = join(bin, 'direnv');

  try {
    await mkdir(bin);
    await writeFile(direnv, '#!/bin/sh\ntest "$1" = exec || exit 2\nshift\nexport CORIOL_DIRENV_CWD="$1"\nshift\nexport CORIOL_DIRENV_LOADED=yes\nexec "$@"\n');
    await chmod(direnv, 0o700);

    const output = await run(
      process.execPath,
      ['-e', 'process.stdout.write(`${process.env.CORIOL_DIRENV_LOADED}:${process.env.CORIOL_DIRENV_CWD}`)'],
      root,
      { PATH: bin },
    );

    assert.equal(output, `yes:${root}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runs toolchain commands directly when direnv is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'coriol-process-'));

  try {
    const output = await run(
      process.execPath,
      ['-e', 'process.stdout.write(process.env.CORIOL_DIRENV_LOADED ?? "direct")'],
      root,
      { PATH: [root, '/usr/bin', '/bin'].join(delimiter) },
    );

    assert.equal(output, 'direct');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('command policies remain scoped across concurrent operations and nested calls', async () => {
  const runner = (value: string) => async () => value;
  const results = await Promise.all([
    withCommandRunner(runner('first'), async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(await withCommandRunner(runner('nested'), () => run('unused', [], '.')), 'nested');
      return run('unused', [], '.');
    }),
    withCommandRunner(runner('second'), () => run('unused', [], '.')),
  ]);
  assert.deepEqual(results, ['first', 'second']);
  const outside = await run(process.execPath, ['-e', "process.stdout.write('outside')"], process.cwd(), process.env, false);
  assert.equal(outside, 'outside');
});
