import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { agentCommand, selfInvocation, shellQuote } from './self.js';

test('the CLI reinvokes Homebrew\'s stable wrapper, else this Node and entry', () => {
  assert.deepEqual(selfInvocation({ LOVELACE_EXECUTABLE: '/opt/homebrew/opt/lovelace/bin/lovelace' }), ['/opt/homebrew/opt/lovelace/bin/lovelace']);
  assert.equal(selfInvocation({})[0], process.execPath);
  assert.equal(selfInvocation({}).at(-1), process.argv[1]);
  assert.equal(shellQuote('/opt/homebrew/bin/lovelace'), '/opt/homebrew/bin/lovelace');
  assert.equal(shellQuote("/Users/me/My Code/it's"), "'/Users/me/My Code/it'\\''s'");
});

test('agents call plain lovelace when PATH resolves to this executable, and pin only overridden ports', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-self-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'lovelace');
  await writeFile(executable, '');
  await symlink(executable, join(root, 'linked'));
  const env = { LOVELACE_EXECUTABLE: executable };
  assert.equal(agentCommand(27421, join(root, 'linked'), env), 'lovelace');
  assert.equal(agentCommand(27421, null, env), executable);
  assert.equal(agentCommand(27421, join(root, 'other'), env), executable);
  assert.equal(agentCommand(48999, join(root, 'linked'), { ...env, LOVELACE_PORT: '48999' }), 'LOVELACE_PORT=48999 lovelace');
  assert.ok(agentCommand(27421, executable, {}).startsWith(process.execPath));
});
