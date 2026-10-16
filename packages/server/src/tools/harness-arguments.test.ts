import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { harnessArguments } from './harness-arguments.js';
import { findExecutable } from './executables.js';
import { detectTools } from './tool-loader.js';

test('detects executable harnesses only, resolves symlinks and prefers PATH order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-detection-'));
  try {
    const first = join(root, 'first');
    const second = join(root, 'second');
    await mkdir(first); await mkdir(second);
    await writeFile(join(first, 'pi'), '#!/bin/sh\n', { mode: 0o700 });
    await writeFile(join(second, 'pi'), '#!/bin/sh\n', { mode: 0o700 });
    await symlink(join(first, 'pi'), join(first, 'codex'));
    await writeFile(join(first, 'claude'), 'not executable', { mode: 0o600 });
    await mkdir(join(second, 'claude'));
    const tools = detectTools((name) => findExecutable(name, `${first}:${second}`));
    assert.deepEqual(tools.map((tool) => tool.id), ['pi', 'codex']);
    assert.equal(tools[0]?.executablePath, join(first, 'pi'));
    assert.equal(tools[0]?.defaultSelected, true);
    assert.equal(tools[1]?.defaultSelected, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('harness options map to native flags and empty values keep harness defaults', () => {
  assert.deepEqual(harnessArguments('pi'), []);
  assert.deepEqual(harnessArguments('claude', { model: '', thinkingLevel: '' }), []);
  assert.deepEqual(harnessArguments('pi', { model: ' provider/model ', thinkingLevel: 'max' }), ['--model', 'provider/model', '--thinking', 'max']);
  assert.deepEqual(harnessArguments('claude', { model: 'opus', thinkingLevel: 'high' }), ['--model', 'opus', '--effort', 'high']);
  assert.deepEqual(harnessArguments('codex', { model: 'example-model', thinkingLevel: 'xhigh' }), ['--model', 'example-model', '-c', 'model_reasoning_effort="xhigh"']);
});

test('continuation resumes only the exact recorded conversation', () => {
  const nativeId = '0b9f0e9e-1f2a-4d6b-9c3e-5a7d8e9f0a1b';
  assert.deepEqual(harnessArguments('codex', {}, nativeId), ['resume', nativeId]);
  assert.deepEqual(harnessArguments('claude', { thinkingLevel: 'low' }, nativeId), ['--resume', nativeId, '--effort', 'low']);
  assert.deepEqual(harnessArguments('pi', {}, '/fixture/session.jsonl'), ['--session', '/fixture/session.jsonl']);
  for (const resume of ['--last', 'w1:p1', 'latest']) assert.throws(() => harnessArguments('codex', {}, resume), /Invalid codex native session identity/);
  assert.throws(() => harnessArguments('pi', {}, 'relative.jsonl'), /Invalid pi/);
});
