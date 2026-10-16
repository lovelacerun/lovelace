import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getServerUrl } from './config.js';

test('default TUI address uses real root-config port, with env override', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-tui-config-'));
  const saved = { config: process.env.LOVELACE_CONFIG, port: process.env.LOVELACE_PORT, host: process.env.LOVELACE_HOST };
  t.after(async () => {
    for (const [name, value] of [['LOVELACE_CONFIG', saved.config], ['LOVELACE_PORT', saved.port], ['LOVELACE_HOST', saved.host]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, 'config.jsonc'), '{"port":4747}');
  process.env.LOVELACE_CONFIG = join(root, 'config.jsonc'); delete process.env.LOVELACE_PORT; delete process.env.LOVELACE_HOST;
  assert.equal(getServerUrl(), 'http://127.0.0.1:4747');
  process.env.LOVELACE_PORT = '48999';
  assert.equal(getServerUrl(), 'http://127.0.0.1:48999');
});
