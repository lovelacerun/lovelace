import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { loadConfig } from './config.js';
import { isSidebarSide } from './dashboard.js';
import { isCodingHarnessId } from './harnesses.js';

async function fixture(t: TestContext, config?: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-v4-config-'));
  const keys = ['LOVELACE_ROOT', 'LOVELACE_CONFIG', 'LOVELACE_DEFAULT_AGENT', 'LOVELACE_TUI_SIDEBAR', 'LOVELACE_TUI_ICONS', 'LOVELACE_TUI_THEME', 'GITHUB_REPOSITORY_TOPICS'] as const;
  const original = keys.map((key) => [key, process.env[key]] as const);
  process.env.LOVELACE_ROOT = root;
  process.env.LOVELACE_CONFIG = join(root, 'config.jsonc');
  delete process.env.LOVELACE_DEFAULT_AGENT;
  delete process.env.LOVELACE_TUI_SIDEBAR;
  delete process.env.LOVELACE_TUI_ICONS;
  delete process.env.LOVELACE_TUI_THEME;
  delete process.env.GITHUB_REPOSITORY_TOPICS;
  t.after(async () => {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  if (config !== undefined) {
    await writeFile(join(root, 'config.jsonc'), JSON.stringify(config));
  }
  return root;
}

test('v4 defaults are Pi and a right sidebar without user configuration', async (t) => {
  const root = await fixture(t);
  const config = loadConfig();
  assert.equal(config.domainRoot, root);
  assert.equal(config.defaultAgent, 'pi');
  assert.deepEqual(config.tui, { sidebarSide: 'right', icons: 'nerd', theme: 'dark', colors: {} });
  assert.deepEqual(config.herdr, {});
});

test('the config file lives outside the state root and may choose it', async (t) => {
  const root = await fixture(t, { domainRoot: '~/work' });
  delete process.env.LOVELACE_ROOT;
  assert.equal(loadConfig().domainRoot, join(homedir(), 'work'));
  assert.equal(loadConfig().lovelaceDir, join(homedir(), 'work', '.lovelace'));
  process.env.LOVELACE_ROOT = root;
  assert.equal(loadConfig().lovelaceDir, join(root, '.lovelace'));
});

test('user configuration selects the agent and sidebar independently', async (t) => {
  await fixture(t, { defaultAgent: 'claude', tui: { sidebarSide: 'left' } });
  const config = loadConfig();
  assert.equal(config.defaultAgent, 'claude');
  assert.equal(config.tui.sidebarSide, 'left');
});

test('repository topic defaults are configurable and an empty list disables the initial filter', async t => {
  const root = await fixture(t);
  assert.deepEqual(loadConfig().github?.repositoryTopics, []);
  const path = join(root, 'config.jsonc');
  for (const topics of [['infra'], ['frontend', 'platform'], []]) {
    await writeFile(path, JSON.stringify({ github: { repositoryTopics: topics } }));
    assert.deepEqual(loadConfig().github?.repositoryTopics, topics);
  }
  process.env.GITHUB_REPOSITORY_TOPICS = 'infra, examplecom';
  assert.deepEqual(loadConfig().github?.repositoryTopics, ['infra', 'examplecom']);
});

test('valid environment overrides take precedence over user settings', async (t) => {
  await fixture(t, { defaultAgent: 'claude', tui: { sidebarSide: 'left' } });
  process.env.LOVELACE_DEFAULT_AGENT = 'codex';
  process.env.LOVELACE_TUI_SIDEBAR = 'right';
  const config = loadConfig();
  assert.equal(config.defaultAgent, 'codex');
  assert.equal(config.tui.sidebarSide, 'right');
});

test('invalid environment values preserve valid user settings', async (t) => {
  await fixture(t, { defaultAgent: 'claude', tui: { sidebarSide: 'left' } });
  process.env.LOVELACE_DEFAULT_AGENT = 'not-a-harness';
  process.env.LOVELACE_TUI_SIDEBAR = 'middle';
  const config = loadConfig();
  assert.equal(config.defaultAgent, 'claude');
  assert.equal(config.tui.sidebarSide, 'left');
});

test('invalid new settings and retired configuration leave safe defaults', async (t) => {
  await fixture(t, {
    defaultAgent: 42,
    tui: { sidebarSide: 'middle', icons: 'emoji' },
    repositoryInsightModulePaths: ['/retired/not-executed.mjs'],
    toolModulePaths: ['/retired/not-executed.mjs'],
  });
  const config = loadConfig();
  assert.equal(config.defaultAgent, 'pi');
  assert.equal(config.tui.sidebarSide, 'right');
  assert.equal(config.tui.icons, 'nerd');
});

test('tui themes take light mode and per-theme colour overrides, dropping invalid values', async (t) => {
  await fixture(t, { tui: { theme: 'light', colors: { light: { accent: '#123ABC', background: 'none', key: 'red' }, dim: { accent: '#000000' } } } });
  assert.equal(loadConfig().tui.theme, 'light');
  assert.deepEqual(loadConfig().tui.colors, { light: { accent: '#123ABC', background: 'none' } });
  process.env.LOVELACE_TUI_THEME = 'dark';
  assert.equal(loadConfig().tui.theme, 'dark');
});

test('herdr paths are optional absolute paths and invalid settings fail closed', async t => {
  const root = await fixture(t, { herdr: { executable: '/fixture/herdr', socketPath: '/fixture/herdr.sock' } });
  assert.deepEqual(loadConfig().herdr, { executable: '/fixture/herdr', socketPath: '/fixture/herdr.sock' });
  const path = join(root, 'config.jsonc');
  for (const herdr of [{ executable: 'herdr' }, { socketPath: 1 }, { workspaceId: 'w1' }, []]) {
    await writeFile(path, JSON.stringify({ herdr }));
    assert.throws(() => loadConfig(), /Invalid herdr configuration/);
  }
});

test('shared v4 discriminants reject unknown values', () => {
  for (const value of [null, undefined, {}, 'github', 'PI', '', 0]) {
    assert.equal(isCodingHarnessId(value), false);
  }
  for (const value of ['pi', 'claude', 'codex']) assert.equal(isCodingHarnessId(value), true);
  for (const value of [null, undefined, {}, 'middle', '', 0]) {
    assert.equal(isSidebarSide(value), false);
  }
  assert.equal(isSidebarSide('left'), true);
  assert.equal(isSidebarSide('right'), true);
});
