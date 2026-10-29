import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { LovelaceConfig, TrackerIssue } from '@lovelace/core';
import { openDatabase } from '../database.js';
import type { CachedTracker } from '../cached-providers.js';
import { createActiveWorkItem } from '../repositories/work-item-repository.js';
import { trackerIssue } from '../test-support/providers.js';
import { attachTrackerIssueToWorkItem, detachTrackerIssueFromWorkItem, refreshAttachedTrackerIssues } from './tracker-item-service.js';

const logger = { info() {}, warn() {}, error() {} };
function issue(id: string): TrackerIssue {
  return trackerIssue({ id, description: 'Description', updatedAt: new Date().toISOString() });
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-tracker-sync-'));
  const config: LovelaceConfig = { domainRoot: root, lovelaceDir: join(root, '.lovelace'), port: 27421, logLevel: 'info', syncIntervalMs: 300_000, defaultAgent: 'pi', tui: { sidebarSide: 'right' } };
  const database = openDatabase(config);
  t.after(async () => { database.db.close(); await rm(root, { recursive: true, force: true }); });
  return database;
}
function client(fetchIssue: CachedTracker['fetchIssue']) {
  return { provider: 'jira', name: 'Jira', isConfigured: () => true, fetchIssue, refreshIssue: fetchIssue };
}

test('five-minute tracker refresh includes done work, coalesces and never changes local state/activity', async (t) => {
  const database = await fixture(t);
  const first = createActiveWorkItem(database, { title: 'One', attachments: [{ type: 'tracker-item', provider: 'jira', externalId: '1', payload: issue('1') }] });
  const second = createActiveWorkItem(database, { title: 'Two', attachments: [{ type: 'tracker-item', provider: 'jira', externalId: '1', payload: issue('1') }] });
  database.updateWorkItemState(second.id, 'done');
  const beforeActivity = database.listWorkActivity();
  const beforeWork = database.listWorkItems();
  let requests = 0;
  const tracker = client(async () => { requests++; await Promise.resolve(); return { ...issue('1'), status: 'Erledigt', done: true }; });
  const results = await Promise.all([refreshAttachedTrackerIssues({ database, tracker, logger }), refreshAttachedTrackerIssues({ database, tracker, logger })]);
  assert.equal(requests, 1, 'one provider lookup even when linked from multiple work items');
  assert.deepEqual(results, [{ refreshed: 2, failed: 0 }, { refreshed: 2, failed: 0 }]);
  assert.deepEqual(database.listWorkActivity(), beforeActivity);
  assert.deepEqual(database.listWorkItems(), beforeWork, 'upstream updates cannot complete or reactivate local work');
  for (const id of [first.id, second.id]) assert.equal(database.listAttachmentsOfType('tracker-item', id)[0]!.payload.status, 'Erledigt');
});

test('failed refresh keeps last-good attached payload and allows subsequent retry', async (t) => {
  const database = await fixture(t);
  const work = createActiveWorkItem(database, { title: 'One', attachments: [{ type: 'tracker-item', provider: 'jira', externalId: '1', payload: issue('1') }] });
  const before = database.listAttachments(work.id);
  const failed = await refreshAttachedTrackerIssues({ database, tracker: client(async () => { throw new Error('fixture unavailable'); }), logger });
  assert.deepEqual(failed, { refreshed: 0, failed: 1 });
  assert.deepEqual(database.listAttachments(work.id), before);
  const retried = await refreshAttachedTrackerIssues({ database, tracker: client(async () => issue('1')), logger });
  assert.deepEqual(retried, { refreshed: 1, failed: 0 });
});

test('explicit tracker attachment records a local event but repeated upsert does not duplicate creation', async (t) => {
  const database = await fixture(t);
  const work = createActiveWorkItem(database, { title: 'One', attachments: [] });
  const tracker = client(async () => issue('1'));
  await attachTrackerIssueToWorkItem(database, tracker, work.id, 'PROJ-1');
  await attachTrackerIssueToWorkItem(database, tracker, work.id, 'PROJ-1');
  assert.equal(database.listAttachments(work.id).length, 1);
  assert.equal(database.listWorkActivity().filter((row) => row.kind === 'work-item.tracker-attached').length, 1);
});

test('attaching an issue leads an unkeyed title with the issue key; detaching removes only that key', async (t) => {
  const database = await fixture(t);
  const work = createActiveWorkItem(database, { title: 'Fix the sync', attachments: [] });
  const keyed = createActiveWorkItem(database, { title: 'OTHER-7: Started from Jira', attachments: [] });
  const tracker = client(async (key) => issue(key.replace('PROJ-', '')));
  await attachTrackerIssueToWorkItem(database, tracker, work.id, 'PROJ-1');
  await attachTrackerIssueToWorkItem(database, tracker, work.id, 'PROJ-2');
  await attachTrackerIssueToWorkItem(database, tracker, keyed.id, 'PROJ-1');
  assert.equal(database.getWorkItem(work.id)!.title, 'PROJ-1: Fix the sync');
  assert.equal(database.getWorkItem(keyed.id)!.title, 'OTHER-7: Started from Jira');
  detachTrackerIssueFromWorkItem(database, work.id, 'PROJ-1');
  assert.equal(database.getWorkItem(work.id)!.title, 'PROJ-2: Fix the sync', 'the remaining issue keys the title');
  detachTrackerIssueFromWorkItem(database, work.id, 'PROJ-2');
  detachTrackerIssueFromWorkItem(database, keyed.id, 'PROJ-1');
  assert.equal(database.getWorkItem(work.id)!.title, 'Fix the sync');
  assert.equal(database.getWorkItem(keyed.id)!.title, 'OTHER-7: Started from Jira');
});
