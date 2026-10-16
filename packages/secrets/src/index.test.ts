import assert from 'node:assert/strict';
import test from 'node:test';
import { command, isOnePasswordReference, keychain, onePassword, plaintext, resolveSecret, type Execute } from './index.js';

const exit = (code: number) => Object.assign(new Error(`exit ${code}`), { code });

test('the first source with a value wins and later sources are never read', async () => {
  let read = false;
  const later = { name: 'later', read: async () => { read = true; return 'later'; } };
  assert.deepEqual(await resolveSecret([undefined, plaintext(' '), plaintext(' first\n'), later]), { value: 'first', source: 'plaintext' });
  assert.equal(read, false);
  assert.equal(await resolveSecret([plaintext(undefined)]), undefined);
});

test('failing sources are reported and skipped', async () => {
  const errors: string[] = [];
  const broken = { name: 'broken', read: async () => { throw new Error('locked'); } };
  const resolved = await resolveSecret([broken, plaintext('ok')], (error, source) => errors.push(`${source}: ${(error as Error).message}`));
  assert.deepEqual(resolved, { value: 'ok', source: 'plaintext' });
  assert.deepEqual(errors, ['broken: locked']);
});

test('keychain reads a generic password and treats a missing item as absent', async () => {
  const calls: string[][] = [];
  const execute: Execute = async (file, args) => {
    calls.push([file, ...args]);
    if (args.includes('missing')) throw exit(44);
    if (args.includes('denied')) throw exit(51);
    return 'secret\n';
  };
  assert.equal(await keychain('svc', 'acct', { execute })?.read(), 'secret\n');
  assert.deepEqual(calls[0], ['/usr/bin/security', 'find-generic-password', '-s', 'svc', '-a', 'acct', '-w']);
  assert.equal(await keychain('svc', 'missing', { execute })?.read(), undefined);
  await assert.rejects(keychain('svc', 'denied', { execute })!.read(), /exit 51/);
});

test('1Password and command sources run their CLI with the given arguments', async () => {
  const calls: string[][] = [];
  const execute: Execute = async (file, args) => { calls.push([file.split('/').at(-1)!, ...args]); return 'value'; };
  assert.equal(isOnePasswordReference(' op://vault/item/field'), true);
  assert.equal(isOnePasswordReference('plain'), false);
  assert.equal(await onePassword('op://vault/item/field', { execute }).read(), 'value');
  assert.equal(await command('gh', 'gh', ['auth', 'token'], { execute }).read(), 'value');
  assert.deepEqual(calls, [['op', 'read', '--no-newline', 'op://vault/item/field'], ['gh', 'auth', 'token']]);
});
