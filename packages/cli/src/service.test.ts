import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { renderPlist, service, serverEnvironment, SERVICE_LABEL } from './service.js';

test('the LaunchAgent reruns this CLI with the installing PATH and no other environment', () => {
  const plist = renderPlist({
    program: ['/opt/homebrew/opt/lovelace/bin/lovelace', 'service', 'run'],
    env: { PATH: '/a&b:/usr/bin', LOVELACE_EXECUTABLE: '/opt/homebrew/opt/lovelace/bin/lovelace', JIRA_API_TOKEN: 'secret' },
    logDir: '/state/logs',
  });
  assert.match(plist, new RegExp(`<string>${SERVICE_LABEL}</string>`));
  assert.match(plist, /<string>\/opt\/homebrew\/opt\/lovelace\/bin\/lovelace<\/string>\n {6}<string>service<\/string>\n {6}<string>run<\/string>/);
  assert.match(plist, /<key>PATH<\/key>\n {6}<string>\/a&amp;b:\/usr\/bin<\/string>/);
  assert.match(plist, /<key>LOVELACE_EXECUTABLE<\/key>/);
  assert.doesNotMatch(plist, /JIRA_API_TOKEN|secret/);
  assert.match(plist, /\/state\/logs\/launchd-error\.log/);
});

test('the server gets the system proxy, or none at all', () => {
  const env = { HOME: '/home', HTTPS_PROXY: 'http://stale:1', all_proxy: 'socks://stale:2', NODE_USE_ENV_PROXY: '1' };
  assert.deepEqual(serverEnvironment(env, null), { HOME: '/home' });
  assert.deepEqual(serverEnvironment(env, 'http://proxy:8080'), {
    HOME: '/home', HTTP_PROXY: 'http://proxy:8080', HTTPS_PROXY: 'http://proxy:8080', NODE_USE_ENV_PROXY: '1',
  });
});

test('service commands drive launchctl for the user domain', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-service-'));
  const keys = ['LOVELACE_ROOT', 'LOVELACE_CONFIG'] as const;
  const original = keys.map(key => [key, process.env[key]] as const);
  process.env.LOVELACE_ROOT = root;
  process.env.LOVELACE_CONFIG = join(root, 'config.jsonc');
  t.after(async () => {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  const calls: string[][] = [];
  const launchctl = async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'bootout') throw new Error('not loaded');
    return args[0] === 'print' ? 'state = running\n\tpid = 4242\n' : '';
  };
  const options = { launchctl, plistDir: join(root, 'LaunchAgents'), env: { PATH: '/usr/bin', LOVELACE_EXECUTABLE: '/fixture/lovelace' } };
  const target = `gui/${process.getuid!()}/${SERVICE_LABEL}`;
  const plistPath = join(root, 'LaunchAgents', `${SERVICE_LABEL}.plist`);

  await assert.rejects(service(['restart'], options), /not installed/);
  await service(['install'], options);
  assert.match(await readFile(plistPath, 'utf8'), /<string>\/fixture\/lovelace<\/string>/);
  assert.deepEqual(await service(['status'], options), { label: SERVICE_LABEL, installed: true, loaded: true, pid: 4242, plist: plistPath });
  await service(['restart'], options);
  await service(['uninstall'], options);
  assert.deepEqual(calls, [
    ['bootout', target], ['bootstrap', target.slice(0, target.lastIndexOf('/')), plistPath],
    ['print', target], ['kickstart', '-k', target], ['bootout', target],
  ]);
  assert.deepEqual(await service(['status'], options), { label: SERVICE_LABEL, installed: false, loaded: false, pid: null, plist: plistPath });
  await assert.rejects(service(['bogus'], options), /Usage/);
});
