import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { ChangeRequest, ServerConfig } from '@lovelace/core';
import { openDatabase } from '../database.js';
import type { ReleaseCheckPlugin, ReleaseCheckResult } from '../plugins/release-checks.js';
import { createActiveWorkItem } from '../repositories/work-item-repository.js';
import { changeRequest } from '../test-support/providers.js';
import { refreshReleaseChecks } from './release-check-service.js';

const logger = { warn() {} };

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-release-checks-'));
  const config: ServerConfig = { domainRoot: root, lovelaceDir: join(root, '.lovelace'), port: 27421, logLevel: 'info', syncIntervalMs: 300_000, defaultAgent: 'pi' };
  const database = openDatabase(config);
  t.after(async () => { database.db.close(); await rm(root, { recursive: true, force: true }); });
  return database;
}

function attached(request: ChangeRequest) {
  const now = new Date().toISOString();
  return { type: 'pull-request' as const, provider: 'github', externalId: request.id, payload: { ...request, attachedAt: now, lastSyncedAt: now } };
}

function fakePlugin(answer: (request: ChangeRequest) => ReleaseCheckResult) {
  const asked: string[] = [];
  const plugin: ReleaseCheckPlugin = { check: async (request) => { asked.push(request.id); return answer(request); } };
  return { plugin, asked };
}

const pending: ReleaseCheckResult = { complete: false, checks: [{ name: 'prod', state: 'pending', detail: null, url: null }] };
const released: ReleaseCheckResult = { complete: true, checks: [{ name: 'prod', state: 'done', detail: null, url: null }] };

test('checks merged change requests on active work items until complete', async (t) => {
  const database = await fixture(t);
  const open = changeRequest({ repository: 'example/service', number: 1, status: 'open' });
  const merged = changeRequest({ repository: 'example/service', number: 2, status: 'merged' });
  const active = createActiveWorkItem(database, { title: 'Active', attachments: [attached(open), attached(merged)] });
  const done = createActiveWorkItem(database, { title: 'Done', attachments: [attached(changeRequest({ repository: 'example/service', number: 3, status: 'merged' }))] });
  database.updateWorkItemState(done.id, 'done');

  let answer = pending;
  const { plugin, asked } = fakePlugin(() => answer);
  assert.deepEqual(await refreshReleaseChecks(database, plugin, logger), { attempted: 1, updated: 1, failed: 0 });
  assert.deepEqual(asked, [merged.id]);
  const stored = () => database.listAttachmentsOfType('pull-request', active.id).find(a => a.externalId === merged.id)!.payload.releaseChecks;
  assert.deepEqual(stored()?.checks, pending.checks);

  answer = released;
  await refreshReleaseChecks(database, plugin, logger);
  assert.equal(stored()?.complete, true);
  assert.deepEqual(await refreshReleaseChecks(database, plugin, logger), { attempted: 0, updated: 0, failed: 0 });
  assert.equal(asked.length, 2);
});

test('a failed check keeps the last good result and records the error', async (t) => {
  const database = await fixture(t);
  const merged = changeRequest({ repository: 'example/service', number: 2, status: 'merged' });
  const work = createActiveWorkItem(database, { title: 'Active', attachments: [attached(merged)] });
  await refreshReleaseChecks(database, fakePlugin(() => pending).plugin, logger);

  const failing = fakePlugin(() => { throw new Error('dpl timed out'); });
  assert.deepEqual(await refreshReleaseChecks(database, failing.plugin, logger, work.id), { attempted: 1, updated: 0, failed: 1 });
  const releaseChecks = database.listAttachmentsOfType('pull-request', work.id)[0]!.payload.releaseChecks!;
  assert.deepEqual(releaseChecks.checks, pending.checks);
  assert.equal(releaseChecks.complete, false);
  assert.equal(releaseChecks.error, 'dpl timed out');
});
