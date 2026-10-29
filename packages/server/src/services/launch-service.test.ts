import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import type { LovelaceConfig } from '@lovelace/core';
import { openDatabase } from '../database.js';
import { createActiveWorkItem } from '../repositories/work-item-repository.js';
import { retryLaunch, startLaunch } from './launch-service.js';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-launch-'));
  const config: LovelaceConfig = { domainRoot: root, lovelaceDir: join(root, '.lovelace'), port: 27421, logLevel: 'info', syncIntervalMs: 300_000, defaultAgent: 'pi', tui: { sidebarSide: 'right' } };
  const state = { database: openDatabase(config) };
  t.after(async () => { state.database.db.close(); await rm(root, { recursive: true, force: true }); });
  return { state, reopen: () => { state.database.db.close(); state.database = openDatabase(config); state.database.recoverInterruptedLaunches(); } };
}

const fields = (workItemId: string, prompt: string) => ({ workItemId, harness: 'pi', repoIds: [], promptId: null, prompt });
const never = { run: async () => assert.fail('must not launch'), onError: () => {} };

test('a launch interrupted by a restart becomes uncertain and is never replayed', async (t) => {
  const { state, reopen } = await fixture(t);
  const id = randomUUID();
  const work = createActiveWorkItem(state.database, { title: 'Uncertain', attachments: [] });
  const prompt = '  Exact interrupted text\n  ';
  state.database.createLaunch({ id, kind: 'quick-start', requestJson: JSON.stringify({ prompt }), ...fields(work.id, prompt) });
  reopen();
  const response = await startLaunch(state.database, {
    id, kind: 'quick-start', request: { prompt }, prepare: () => assert.fail('restart must not recreate item'), ...never,
  });
  assert.equal(response.launch.state, 'uncertain');
  assert.equal(response.launch.prompt, prompt);
  assert.equal(response.details.workItem.id, work.id);
  assert.equal(state.database.getWorkItemCount(), 1);
  assert.throws(() => retryLaunch(state.database, id, never), /Only failed launches/);
});

test('a launch of the current boot is left alone on recovery', async (t) => {
  const { state } = await fixture(t);
  const work = createActiveWorkItem(state.database, { title: 'Running', attachments: [] });
  state.database.createLaunch({ id: randomUUID(), kind: 'new-session', requestJson: '{}', ...fields(work.id, 'Text') });
  state.database.recoverInterruptedLaunches();
  assert.equal(state.database.listLaunches()[0]!.state, 'accepted');
});

test('a failed launch retries in place with its saved prompt', async (t) => {
  const { state } = await fixture(t);
  const prompts: string[] = [];
  let fail = true;
  const run = async (launch: { prompt: string }) => { prompts.push(launch.prompt); if (fail) throw new Error('herdr down'); };
  const failed = await startLaunch(state.database, {
    kind: 'quick-start', request: { prompt: 'Saved' }, run, onError: () => {},
    prepare: () => fields(createActiveWorkItem(state.database, { title: 'Work', attachments: [] }).id, 'Saved'),
  });
  assert.deepEqual([failed.launch.state, failed.launch.error], ['failed', 'herdr down']);
  fail = false;
  const retried = retryLaunch(state.database, failed.launch.id, { run, onError: () => {} });
  assert.equal(retried.launch.id, failed.launch.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.database.getLaunch(failed.launch.id)!.state, 'started');
  assert.deepEqual(prompts, ['Saved', 'Saved']);
  assert.equal(state.database.listLaunches().length, 1);
});

test('a request ID only ever replays its own request', async (t) => {
  const { state } = await fixture(t);
  const id = randomUUID();
  const work = createActiveWorkItem(state.database, { title: 'Work', attachments: [] });
  await startLaunch(state.database, { id, kind: 'new-session', request: { prompt: 'One' }, prepare: () => fields(work.id, 'One'), run: async () => {}, onError: () => {} });
  await assert.rejects(startLaunch(state.database, { id, kind: 'new-session', request: { prompt: 'Two' }, prepare: () => assert.fail(), ...never }), /different launch/);
  const replay = await startLaunch(state.database, { id: id.toUpperCase(), kind: 'new-session', request: { prompt: 'One' }, prepare: () => assert.fail(), ...never });
  assert.equal(replay.launch.state, 'started');
});

test('the launch and its work item are one transaction', async (t) => {
  const { state } = await fixture(t);
  assert.throws(() => startLaunch(state.database, { id: randomUUID(), kind: 'quick-start', request: { prompt: 'Text' }, prepare: () => {
    createActiveWorkItem(state.database, { title: 'Should roll back', attachments: [] });
    throw new Error('fixture transaction interrupted');
  }, ...never }), /interrupted/);
  assert.equal(state.database.getWorkItemCount(), 0);
  assert.deepEqual(state.database.listLaunches(), []);
  assert.deepEqual(state.database.listWorkActivity(), []);
});
