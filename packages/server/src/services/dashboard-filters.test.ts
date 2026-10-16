import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { JiraIssueSummary, LovelaceConfig } from '@lovelace/core';
import { openDatabase } from '../database.js';
import { createActiveWorkItemFromMetas, createManualWorkItem } from '../repositories/work-item-repository.js';
import { fixtureProviders, storedSnapshot } from '../test-support/providers.js';
import { buildDashboard, startOfPreviousLocalDay } from './dashboard-service.js';

function jiraIssue(id: string): JiraIssueSummary {
  return { id, key: `PROJ-${id}`, title: `Issue ${id}`, url: `https://jira.invalid/browse/PROJ-${id}`, project: 'PROJ', status: 'In Progress', statusCategory: null, issueType: 'Task', type: 'Task', author: 'fixture', descriptionText: null, updatedAt: '2026-01-01T10:00:00.000Z' };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-dashboard-filter-'));
  const config: LovelaceConfig = { domainRoot: root, lovelaceDir: join(root, '.lovelace'), port: 27421, logLevel: 'info', syncIntervalMs: 300_000, defaultAgent: 'pi', tui: { sidebarSide: 'right' } };
  const database = openDatabase(config);
  const providers = fixtureProviders();
  const now = new Date();
  t.after(async () => { database.db.close(); await rm(root, { recursive: true, force: true }); });
  const dashboard = () => buildDashboard({ database, github: providers.github, jira: providers.jira, settings: { defaultAgent: 'codex', sidebarSide: 'left', repositoryTopics: [] }, syncIntervalMs: 300_000, now });
  return { database, providers, now, dashboard };
}

test('pending Jira respects category, dismissal, snooze and all non-cancelled linked work', async (t) => {
  const { database, providers, now, dashboard } = await fixture(t);
  const issues = Array.from({ length: 12 }, (_, i) => jiraIssue(String(i + 1)));
  issues[1]!.status = 'Erledigt';
  issues[1]!.statusCategory = 'done';
  issues[2]!.status = 'Resolved';
  issues[3]!.status = 'Done';
  issues[3]!.statusCategory = 'new'; // Category, when present, wins over display text.
  await providers.setAssigned(issues);
  database.upsertInboxMeta({ sourceType: 'tracker-item', provider: 'jira', externalId: '5', state: 'dismissed', createdAt: now.toISOString(), updatedAt: now.toISOString() });
  for (const [id, state] of [['9', 'active'], ['10', 'done'], ['12', 'cancelled']] as const) {
    const work = createActiveWorkItemFromMetas(database, { title: id, metas: [{ metaType: 'tracker-item', provider: 'jira', externalId: id, payload: jiraIssue(id) }] });
    database.updateWorkItemState(work.id, state);
  }
  assert.deepEqual(dashboard().pendingJiraIssues.map((issue) => issue.id), ['1', '4', '6', '7', '8', '11', '12']);
  assert.deepEqual(dashboard().settings, { defaultAgent: 'codex', sidebarSide: 'left', repositoryTopics: [] });
  assert.equal(database.listWorkItems().find((work) => work.title === '10')!.state, 'done');
});

test('persisted assigned issues render before the first sync; malformed payloads count as missing', async (t) => {
  const { database, now } = await fixture(t);
  const render = (providers: ReturnType<typeof fixtureProviders>) => buildDashboard({ database, github: providers.github, jira: providers.jira, settings: { defaultAgent: 'pi', sidebarSide: 'right', repositoryTopics: [] }, syncIntervalMs: 300_000, now });
  const restored = render(fixtureProviders([storedSnapshot('jira.assigned', [jiraIssue('1')], now)]));
  assert.deepEqual(restored.pendingJiraIssues.map((issue) => issue.id), ['1']);
  assert.equal(restored.freshness.jiraStale, false);
  for (const payload of ['{}', '[null]', '[{"id":"broken"}]', '{broken']) {
    const dashboard = render(fixtureProviders([storedSnapshot('jira.assigned', payload, now)]));
    assert.equal(dashboard.pendingJiraIssues.length, 0);
    assert.equal(dashboard.freshness.jiraStale, true);
  }
});

test('recent work covers yesterday and today, excludes updatedAt-only history and deduplicates', async (t) => {
  const { database, now, dashboard } = await fixture(t);
  const touched = createManualWorkItem(database, { title: 'Touched' });
  const historical = createManualWorkItem(database, { title: 'No recorded work' });
  // Creation is recorded today; only the activity below should count.
  database.db.prepare('delete from work_activity').run();
  const start = startOfPreviousLocalDay(now);
  const windowStart = start.toISOString();
  const beforeWindow = new Date(start.getTime() - 1).toISOString();
  database.db.prepare('update work_items set updated_at = ? where id = ?').run(windowStart, historical.id);
  for (const kind of ['session.state-changed', 'session.created', 'work-item.completed']) database.recordWorkActivity({ workItemId: touched.id, kind, occurredAt: windowStart });
  // Today's completion counts too.
  database.recordWorkActivity({ workItemId: touched.id, kind: 'work-item.completed', occurredAt: now.toISOString() });
  database.recordWorkActivity({ workItemId: historical.id, kind: 'session.created', occurredAt: beforeWindow });
  const recent = dashboard().recent;
  assert.equal(recent.since, windowStart);
  assert.deepEqual(recent.workItems.map((work) => work.id), [touched.id]);
  assert.equal(recent.sessionCount, 1);
  assert.equal(recent.completedCount, 1);
  assert.equal(recent.activityCount, 4);
  assert.equal('hours' in recent, false);
});

test('recent work starts at local midnight yesterday across DST and year changes', () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'Europe/Berlin';
    for (const [now, start] of [
      ['2026-03-30T12:00:00+02:00', '2026-03-28T23:00:00.000Z'],
      ['2026-10-26T12:00:00+01:00', '2026-10-24T22:00:00.000Z'],
      ['2026-01-01T12:00:00+01:00', '2025-12-30T23:00:00.000Z'],
    ] as const) {
      assert.equal(startOfPreviousLocalDay(new Date(now)).toISOString(), start);
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('recent work counts done separately from cancellation', async (t) => {
  const { database, now, dashboard } = await fixture(t);
  const done = createManualWorkItem(database, { title: 'Done' });
  const cancelled = createManualWorkItem(database, { title: 'Cancelled' });
  database.recordWorkActivity({ workItemId: done.id, kind: 'work-item.completed', payload: { state: 'done' }, occurredAt: now.toISOString() });
  database.recordWorkActivity({ workItemId: cancelled.id, kind: 'work-item.cancelled', occurredAt: now.toISOString() });
  assert.equal(dashboard().recent.completedCount, 1);
  assert.equal(dashboard().recent.cancelledCount, 1);
});
