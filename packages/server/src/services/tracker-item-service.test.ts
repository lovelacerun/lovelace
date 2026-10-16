import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { JiraIssueSummary, LovelaceConfig } from '@lovelace/core';
import { openDatabase } from '../database.js';
import type { CachedJira } from '../cached-providers.js';
import { createActiveWorkItemFromMetas } from '../repositories/work-item-repository.js';
import { attachJiraIssueToWorkItem, refreshAttachedTrackerIssues } from './tracker-item-service.js';

const logger = { info() {}, warn() {}, error() {} };
function issue(id: string): JiraIssueSummary {
  return { id, key: `PROJ-${id}`, title: 'Fixture', url: 'https://jira.invalid/fixture', project: 'PROJ', status: 'To Do', statusCategory: 'new', issueType: 'Task', type: 'Task', author: null, descriptionText: 'Description', updatedAt: new Date().toISOString() };
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-tracker-sync-'));
  const config: LovelaceConfig = { domainRoot: root, lovelaceDir: join(root, '.lovelace'), port: 27421, logLevel: 'info', syncIntervalMs: 300_000, defaultAgent: 'pi', tui: { sidebarSide: 'right' } };
  const database = openDatabase(config);
  t.after(async () => { database.db.close(); await rm(root, { recursive: true, force: true }); });
  return database;
}
function client(fetchIssue: CachedJira['fetchIssue']) {
  return { isConfigured: () => true, fetchIssue, refreshIssue: fetchIssue };
}

test('five-minute tracker refresh includes done work, coalesces and never changes local state/activity', async (t) => {
  const database = await fixture(t);
  const first = createActiveWorkItemFromMetas(database, { title: 'One', metas: [{ metaType: 'tracker-item', provider: 'jira', externalId: '1', payload: issue('1') }] });
  const second = createActiveWorkItemFromMetas(database, { title: 'Two', metas: [{ metaType: 'tracker-item', provider: 'jira', externalId: '1', payload: issue('1') }] });
  database.updateWorkItemState(second.id, 'done');
  const beforeActivity = database.listWorkActivity();
  const beforeWork = database.listWorkItems();
  let requests = 0;
  const jira = client(async () => { requests++; await Promise.resolve(); return { ...issue('1'), status: 'Erledigt', statusCategory: 'done' }; });
  const results = await Promise.all([refreshAttachedTrackerIssues({ database, jira, logger }), refreshAttachedTrackerIssues({ database, jira, logger })]);
  assert.equal(requests, 1, 'one provider lookup even when linked from multiple work items');
  assert.deepEqual(results, [{ refreshed: 2, failed: 0 }, { refreshed: 2, failed: 0 }]);
  assert.deepEqual(database.listWorkActivity(), beforeActivity);
  assert.deepEqual(database.listWorkItems(), beforeWork, 'upstream updates cannot complete or reactivate local work');
  for (const id of [first.id, second.id]) assert.equal(JSON.parse(database.listWorkItemMeta(id)[0]!.payloadJson!).status, 'Erledigt');
});

test('failed refresh keeps last-good attached payload and allows subsequent retry', async (t) => {
  const database = await fixture(t);
  const work = createActiveWorkItemFromMetas(database, { title: 'One', metas: [{ metaType: 'tracker-item', provider: 'jira', externalId: '1', payload: issue('1') }] });
  const before = database.listWorkItemMeta(work.id);
  const failed = await refreshAttachedTrackerIssues({ database, jira: client(async () => { throw new Error('fixture unavailable'); }), logger });
  assert.deepEqual(failed, { refreshed: 0, failed: 1 });
  assert.deepEqual(database.listWorkItemMeta(work.id), before);
  const retried = await refreshAttachedTrackerIssues({ database, jira: client(async () => issue('1')), logger });
  assert.deepEqual(retried, { refreshed: 1, failed: 0 });
});

test('explicit Jira attachment records a local event but repeated upsert does not duplicate creation', async (t) => {
  const database = await fixture(t);
  const work = createActiveWorkItemFromMetas(database, { title: 'One', metas: [] });
  const jira = client(async () => issue('1'));
  await attachJiraIssueToWorkItem(database, jira, work.id, { key: 'PROJ-1' });
  await attachJiraIssueToWorkItem(database, jira, work.id, { key: 'PROJ-1' });
  assert.equal(database.listWorkItemMeta(work.id).length, 1);
  assert.equal(database.listWorkActivity().filter((row) => row.kind === 'work-item.tracker-attached').length, 1);
});
