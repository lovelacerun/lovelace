import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { backgroundEnvironment, claimPidFile, ensureServer, serverCommand, serverEnvironment, type BackgroundDeps } from './background.js';
import { version } from './self.js';

async function fixture(t: TestContext, initial: { version: string | null } | null) {
  const lovelaceDir = await mkdtemp(join(tmpdir(), 'lovelace-background-'));
  t.after(() => rm(lovelaceDir, { recursive: true, force: true }));
  let running = initial ? { ...initial, pid: 1 } : null;
  const alive = new Set<number>();
  const events: string[] = [];
  const deps: BackgroundDeps = {
    port: 48999, lovelaceDir,
    fetchStatus: async () => running,
    launch: () => {
      events.push('launch');
      alive.add(4242);
      writeFileSync(join(lovelaceDir, 'server.pid'), '4242');
      running = { version, pid: 2 };
    },
    isAlive: pid => alive.has(pid),
    kill: pid => { events.push(`kill ${pid}`); alive.delete(pid); running = null; },
    sleep: async () => undefined,
    log: message => events.push(message),
  };
  return { deps, events, lovelaceDir, adopt: async (pid: number) => { alive.add(pid); await writeFile(join(lovelaceDir, 'server.pid'), String(pid)); } };
}

test('commands start a missing server in the background and reuse a running one', async t => {
  const { deps, events } = await fixture(t, null);
  await ensureServer(deps, { LOVELACE_NO_AUTOSTART: '1' });
  assert.deepEqual(events, []);
  await ensureServer(deps, {});
  await ensureServer(deps, {});
  assert.deepEqual(events, ['Starting the Lovelace server…', 'launch']);
});

test('a background server from another version is replaced, a foreground one is left alone', async t => {
  const foreground = await fixture(t, { version: '0.0.1' });
  await ensureServer(foreground.deps, {});
  assert.deepEqual(foreground.events, []);

  const background = await fixture(t, { version: '0.0.1' });
  await background.adopt(777);
  await ensureServer(background.deps, {});
  assert.deepEqual(background.events, [`Restarting the Lovelace server 0.0.1 as ${version}…`, 'kill 777', 'Starting the Lovelace server…', 'launch']);
});

test('server status, stop and restart act on the background supervisor only', async t => {
  const { deps, events, lovelaceDir } = await fixture(t, null);
  assert.deepEqual(await serverCommand('stop', deps), { stopped: false });
  await serverCommand('start', deps);
  assert.equal(await readFile(join(lovelaceDir, 'server.pid'), 'utf8'), '4242');
  assert.deepEqual(await serverCommand('status', deps), {
    running: true, port: 48999, version, pid: 2, background: true, log: join(lovelaceDir, 'logs', 'server-process.log'),
  });
  await serverCommand('restart', deps);
  assert.deepEqual(events.filter(event => !event.startsWith('Starting')), ['launch', 'kill 4242', 'launch']);
  await assert.rejects(serverCommand('bogus', deps), /Usage/);
});

test('one supervisor holds the pid file; a stale one is replaced', async t => {
  const lovelaceDir = await mkdtemp(join(tmpdir(), 'lovelace-pid-'));
  t.after(() => rm(lovelaceDir, { recursive: true, force: true }));
  await writeFile(join(lovelaceDir, 'server.pid'), '999999');
  assert.equal(claimPidFile(lovelaceDir, () => true), false);
  assert.equal(claimPidFile(lovelaceDir, () => false), true);
  assert.equal(await readFile(join(lovelaceDir, 'server.pid'), 'utf8'), String(process.pid));
});

test('the background server inherits only tool, locale and Lovelace location settings', () => {
  const env = backgroundEnvironment({
    PATH: '/bin', HOME: '/home', SSH_AUTH_SOCK: '/agent', LC_ALL: 'C', LOVELACE_CONFIG: '/c.jsonc', LOVELACE_PORT: '1',
    JIRA_API_TOKEN: 'secret', GITHUB_TOKEN: 'secret', DIRENV_DIR: '/worktree', HERDR_PANE_ID: 'w1:p1', HTTPS_PROXY: 'http://stale',
  });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/home', SSH_AUTH_SOCK: '/agent', LC_ALL: 'C', LOVELACE_CONFIG: '/c.jsonc', LOVELACE_PORT: '1' });
});

test('the server gets the system proxy, or none at all', () => {
  const env = { HOME: '/home', HTTPS_PROXY: 'http://stale:1', all_proxy: 'socks://stale:2', NODE_USE_ENV_PROXY: '1' };
  assert.deepEqual(serverEnvironment(env, null), { HOME: '/home' });
  assert.deepEqual(serverEnvironment(env, 'http://proxy:8080'), {
    HOME: '/home', HTTP_PROXY: 'http://proxy:8080', HTTPS_PROXY: 'http://proxy:8080', NODE_USE_ENV_PROXY: '1',
  });
});
