import assert from 'node:assert/strict';
import test from 'node:test';
import type { LovelaceConfig } from '@lovelace/core';
import type { Execute } from '@lovelace/secrets';
import { resolveProviderSecrets } from './secrets.js';

/** Fake CLIs: Keychain items by account, 1Password references and gh logins by `account@host`. */
function fakeExecute(store: { keychain?: Record<string, string>; op?: Record<string, string>; gh?: Record<string, string> }): Execute {
  return async (file, args) => {
    const value = file === '/usr/bin/security' ? store.keychain?.[args[4]!]
      : file.endsWith('op') ? store.op?.[args[2]!]
        : store.gh?.[`${args[5]}@${args[3]}`];
    if (value === undefined) throw Object.assign(new Error('not found'), { code: file === '/usr/bin/security' ? 44 : 1 });
    return `${value}\n`;
  };
}

function logger() {
  const info: unknown[] = [];
  const warn: unknown[] = [];
  return { info, warn, logger: { info: (value: unknown) => info.push(value), warn: (...args: unknown[]) => warn.push(args.at(-1)) } as never };
}

test('prefers the Keychain, then op:// references and plaintext values, and logs only sources', async () => {
  const config = { github: { token: 'op://v/gh/f', account: 'me' }, jira: { apiToken: 'plain' } } as LovelaceConfig;
  const log = logger();
  await resolveProviderSecrets(config, log.logger, { execute: fakeExecute({ keychain: { 'jira-api-token': 'kc' }, op: { 'op://v/gh/f': 'op' }, gh: { 'me@github.com': 'gh' } }) });
  assert.equal(config.github?.token, 'op');
  assert.equal(config.jira?.apiToken, 'kc');
  assert.deepEqual(log.info, [{ github: '1password', jira: 'keychain' }]);
});

test('never falls back to the reference text when 1Password cannot read it', async () => {
  const config = { github: {}, jira: { apiToken: 'op://v/missing/f' } } as LovelaceConfig;
  const log = logger();
  await resolveProviderSecrets(config, log.logger, { execute: fakeExecute({}) });
  assert.equal(config.jira?.apiToken, undefined);
  assert.ok(log.warn.includes('Secret source failed'));
});

test('falls back to the configured GitHub CLI account only without a configured GitHub token', async () => {
  const execute = fakeExecute({ gh: { 'me@github.example.com': 'from-gh', 'me@github.com': 'from-gh' } });
  const unset = { github: { host: 'https://github.example.com/', account: 'me' }, jira: {} } as LovelaceConfig;
  await resolveProviderSecrets(unset, logger().logger, { execute });
  assert.equal(unset.github?.token, 'from-gh');
  const configured = { github: { token: 'plain', account: 'me' }, jira: {} } as LovelaceConfig;
  await resolveProviderSecrets(configured, logger().logger, { execute });
  assert.equal(configured.github?.token, 'plain');
});

test('never borrows the active GitHub CLI account implicitly', async () => {
  const config = { github: {}, jira: {} } as LovelaceConfig;
  const log = logger();
  await resolveProviderSecrets(config, log.logger, { execute: fakeExecute({ gh: { 'me@github.com': 'from-gh' } }) });
  assert.equal(config.github?.token, undefined);
  assert.deepEqual(log.warn, ['No GitHub token configured; set github.account to use a GitHub CLI login']);
});
