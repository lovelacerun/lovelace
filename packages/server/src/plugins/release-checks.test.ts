import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { changeRequest } from '../test-support/providers.js';
import { createReleaseCheckPlugin } from './release-checks.js';

const merged = changeRequest({ repository: 'example/service', number: 7, status: 'merged' });

/** A plugin executable whose body reads the request from `input`. */
async function plugin(t: TestContext, body: string, timeoutMs = 5_000) {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-release-plugin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'plugin.mjs');
  await writeFile(file, `#!/usr/bin/env node
let raw = ''; for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
${body}`);
  await chmod(file, 0o755);
  return createReleaseCheckPlugin({ command: [file], timeoutMs }, root);
}

test('sends the change request on stdin and returns the parsed reply', async (t) => {
  const checks = await plugin(t, `console.log(JSON.stringify({ schemaVersion: 1, complete: false, checks: [
    { name: 'main', state: 'done' },
    { name: input.repository + '#' + input.number, state: 'unknown', detail: 'No tag.', url: input.url },
  ] }));`);
  assert.deepEqual(await checks.check(merged), {
    complete: false,
    checks: [
      { name: 'main', state: 'done', detail: null, url: null },
      { name: 'example/service#7', state: 'unknown', detail: 'No tag.', url: merged.url },
    ],
  });
});

test('rejects failures, invalid replies and timeouts', async (t) => {
  await assert.rejects((await plugin(t, `console.error('no token'); process.exit(2);`)).check(merged), /no token/);
  await assert.rejects((await plugin(t, `console.log('not json');`)).check(merged), /did not print JSON/);
  await assert.rejects((await plugin(t, `console.log(JSON.stringify({ schemaVersion: 1, complete: true, checks: [{ name: 'prod', state: 'released' }] }));`)).check(merged), /invalid reply/);
  await assert.rejects((await plugin(t, `await new Promise(resolve => setTimeout(resolve, 5_000));`, 200)).check(merged), /failed/);
});
