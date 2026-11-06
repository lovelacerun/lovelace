import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createCoriolEnvironmentPolicy } from './coriol-environment.js';

const npm = { command: 'npm', args: ['ci'], cwd: '/workspace', kind: 'toolchain' } as const;

test('wraps toolchains in direnv but runs Git directly with the same environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-coriol-env-'));
  try {
    await writeExecutable(join(root, 'direnv'), '#!/bin/sh\ntest "$1" = exec || exit 2\nshift\nexport POLICY_CWD="$1"\nshift\nexec "$@"\n');
    const inherited = { PATH: root, TOKEN: 'test-token' };
    const policy = createCoriolEnvironmentPolicy(inherited, root);
    const toolchain = await policy({ command: process.execPath, args: ['-e', 'process.stdout.write(`${process.env.TOKEN}:${process.env.POLICY_CWD}`)'], cwd: root, kind: 'toolchain' });
    const result = await promisify(execFile)(toolchain.command, toolchain.args, { cwd: toolchain.cwd, env: toolchain.env });
    assert.equal(result.stdout, `test-token:${root}`);
    assert.equal(toolchain.command, join(root, 'direnv'));

    const git = await policy({ command: 'git', args: ['status'], cwd: root, kind: 'git' });
    assert.equal(git.command, 'git');
    assert.deepEqual(git.args, ['status']);
    assert.deepEqual(git.env, toolchain.env);
    assert.equal(git.env?.PATH?.split(delimiter)[0], root);
    assert.ok(git.env?.PATH?.includes('/opt/homebrew/bin'));
    assert.deepEqual(inherited, { PATH: root, TOKEN: 'test-token' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prefers Volta shims over inherited image paths without mutating the caller', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-coriol-volta-'));
  try {
    const voltaHome = join(root, 'custom-volta');
    const bin = join(voltaHome, 'bin');
    await mkdir(bin, { recursive: true });
    const inherited = { VOLTA_HOME: voltaHome, PATH: [join(voltaHome, 'tools/image/node/24/bin'), '/bin', bin].join(delimiter) };
    const before = { ...inherited };
    const policy = createCoriolEnvironmentPolicy(inherited, root);
    const result = await policy({ ...npm, args: [...npm.args] });
    const paths = result.env!.PATH!.split(delimiter);
    assert.equal(paths[0], bin);
    assert.equal(paths.filter((path) => path === bin).length, 1);
    assert.ok(!paths.some((path) => path.startsWith(join(voltaHome, 'tools', 'image'))));
    assert.equal(result.env?.VOLTA_HOME, voltaHome);
    assert.deepEqual(inherited, before);
    result.env!.PATH = 'changed';
    assert.notEqual((await policy({ ...npm, args: [...npm.args] })).env?.PATH, 'changed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('uses the home Volta installation when VOLTA_HOME is unset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-coriol-home-'));
  try {
    const bin = join(root, '.volta', 'bin');
    await mkdir(bin, { recursive: true });
    const result = await createCoriolEnvironmentPolicy({ PATH: '/bin' }, root)({ ...npm, args: [...npm.args] });
    assert.equal(result.env?.VOLTA_HOME, join(root, '.volta'));
    assert.equal(result.env?.PATH?.split(delimiter)[0], bin);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeExecutable(path: string, content: string) {
  await writeFile(path, content);
  await chmod(path, 0o700);
}
