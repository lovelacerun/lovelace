import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { loadClientSettings, loadServerConfig } from './config.js';
import { isCodingHarnessId } from './harnesses.js';

async function fixture(t: TestContext, config?: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-config-'));
  const original = process.env.LOVELACE_CONFIG;
  process.env.LOVELACE_CONFIG = join(root, 'config.jsonc');
  t.after(async () => {
    if (original === undefined) delete process.env.LOVELACE_CONFIG;
    else process.env.LOVELACE_CONFIG = original;
    await rm(root, { recursive: true, force: true });
  });
  if (config !== undefined) await write(root, config);
  return root;
}

const write = (root: string, config: unknown) =>
  writeFile(join(root, 'config.jsonc'), typeof config === 'string' ? config : JSON.stringify(config));

test('a missing file yields the defaults', async (t) => {
  await fixture(t);
  assert.deepEqual(loadServerConfig(), {
    domainRoot: join(homedir(), 'projects'), lovelaceDir: join(homedir(), 'projects', '.lovelace'),
    port: 27421, logLevel: 'info', syncIntervalMs: 300_000, defaultAgent: 'pi', herdr: {},
    github: { repositoryTopics: [], apiBaseUrl: undefined }, jira: { siteUrl: undefined }, plugins: {},
  });
  assert.deepEqual(loadClientSettings(), {
    port: 27421, tui: { sidebarSide: 'right', icons: 'nerd', theme: 'dark', colors: {} },
  });
});

test('one file feeds the server config and the client settings', async (t) => {
  await fixture(t, `{
    // Comments and trailing commas are fine.
    "domainRoot": "~/work",
    "port": 4747,
    "defaultAgent": "claude",
    "tui": { "sidebarSide": "left", "theme": "light", "colors": { "light": { "accent": "#123ABC", "background": "none" } } },
    "github": { "host": "github.example.com", "account": "  ", "repositoryTopics": ["infra"] },
    "jira": { "baseUrl": "https://jira.example.com" },
    "plugins": { "releaseChecks": { "command": ["~/bin/release-checks", "--json"] } },
  }`);
  const server = loadServerConfig();
  assert.equal(server.lovelaceDir, join(homedir(), 'work', '.lovelace'));
  assert.equal(server.port, 4747);
  assert.equal(server.defaultAgent, 'claude');
  assert.deepEqual(server.github, { host: 'github.example.com', account: undefined, repositoryTopics: ['infra'], apiBaseUrl: 'https://github.example.com/api/v3' });
  assert.equal(server.jira?.siteUrl, 'https://jira.example.com');
  assert.deepEqual(server.plugins?.releaseChecks, { command: [join(homedir(), 'bin', 'release-checks'), '--json'], timeoutMs: 30_000 });
  assert.equal('tui' in server, false);
  assert.deepEqual(loadClientSettings(), {
    port: 4747, tui: { sidebarSide: 'left', icons: 'nerd', theme: 'light', colors: { light: { accent: '#123ABC', background: 'none' } } },
  });
});

test('invalid values and unknown keys fail with the file and the offending path', async (t) => {
  const root = await fixture(t);
  const invalid: [unknown, RegExp][] = [
    [{ defaultAgent: 'gpt' }, /defaultAgent/],
    [{ port: 'x' }, /port/],
    [{ tui: { sidebarSide: 'middle' } }, /tui\.sidebarSide/],
    [{ tui: { colors: { light: { accent: 'red' } } } }, /#rrggbb or none[\s\S]*tui\.colors\.light\.accent/],
    [{ herdr: { executable: 'herdr' } }, /absolute path[\s\S]*herdr\.executable/],
    [{ pullRequestReleases: {} }, /pullRequestReleases/],
    [{ plugins: { releaseChecks: { command: [] } } }, /plugins\.releaseChecks\.command/],
    [{ github: { topics: [] } }, /topics/],
    ['{ "port": ', /Invalid config/],
  ];
  for (const [config, message] of invalid) {
    await write(root, config);
    for (const load of [loadServerConfig, loadClientSettings]) {
      assert.throws(load, (error: Error) => error.message.includes(join(root, 'config.jsonc')) && message.test(error.message));
    }
  }
});

test('coding harness ids reject unknown values', () => {
  for (const value of [null, undefined, {}, 'github', 'PI', '', 0]) assert.equal(isCodingHarnessId(value), false);
  for (const value of ['pi', 'claude', 'codex']) assert.equal(isCodingHarnessId(value), true);
});
