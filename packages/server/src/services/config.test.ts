import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);

test('config defaults and file/environment overrides are resolved without operator configuration', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-config-'));
  await mkdir(join(root, '.config', 'lovelace'), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = "const {loadConfig}=await import('@lovelace/core');const c=loadConfig();console.log(JSON.stringify({defaultAgent:c.defaultAgent,sidebarSide:c.tui.sidebarSide,syncIntervalMs:c.syncIntervalMs}));";
  async function settings(env: Record<string, string> = {}) {
    // Only this allowlisted fixture environment reaches the child. No credentials,
    // operator config, interactive shell or installed coding harness is consulted.
    const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', script], { env: { HOME: root, LOVELACE_ROOT: root, ...env } });
    return JSON.parse(stdout);
  }
  assert.deepEqual(await settings(), { defaultAgent: 'pi', sidebarSide: 'right', syncIntervalMs: 300_000 });
  await writeFile(join(root, '.config', 'lovelace', 'config.jsonc'), JSON.stringify({ defaultAgent: 'codex', tui: { sidebarSide: 'left' } }));
  assert.deepEqual(await settings(), { defaultAgent: 'codex', sidebarSide: 'left', syncIntervalMs: 300_000 });
  assert.deepEqual(await settings({ LOVELACE_DEFAULT_AGENT: 'pi', LOVELACE_TUI_SIDEBAR: 'right' }), { defaultAgent: 'pi', sidebarSide: 'right', syncIntervalMs: 300_000 });
  assert.deepEqual(await settings({ LOVELACE_DEFAULT_AGENT: 'invalid', LOVELACE_TUI_SIDEBAR: 'invalid' }), { defaultAgent: 'codex', sidebarSide: 'left', syncIntervalMs: 300_000 });
});
