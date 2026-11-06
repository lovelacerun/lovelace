import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ServerConfig, TrackerIssue } from '@lovelace/core';
import { changeRequest, fixtureProviders, storedSnapshot, trackerIssue } from '../test-support/providers.js';
import { openDatabase } from '../database.js';
import { createActiveWorkItem, createManualWorkItem } from '../repositories/work-item-repository.js';
import { buildDashboard, startOfPreviousLocalDay } from './dashboard-service.js';
import { testDirs } from '../test-support/dirs.js';

function configForRoot(root: string): ServerConfig {
  return {
    ...testDirs(join(root, '.lovelace')),
    port: 27421,
    logLevel: 'info',
    syncIntervalMs: 300_000,
    defaultAgent: 'pi',

  };
}

function jiraIssue(id: string, overrides: Partial<TrackerIssue> = {}): TrackerIssue {
  return trackerIssue({ id, title: `Issue ${id}`, status: 'In Progress', author: 'alice', updatedAt: '2026-10-06T10:00:00.000Z', ...overrides });
}

test('dashboard pendingIssues excludes attached + terminal issues', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-dashboard-'));
  const config = configForRoot(root);
  const database = openDatabase(config);
  const providers = fixtureProviders();
  try {
    const open = jiraIssue('1', { createdAt: '2026-09-01T10:00:00Z' });
    const review = changeRequest({ repository: 'org/repo', number: 1, createdAt: '2026-09-02T10:00:00Z' });
    providers.data.reviews = [review];
    await providers.codeHost.refreshReviewRequests();
    const attached = jiraIssue('2');
    const done = jiraIssue('3', { status: 'Done', done: true });
    await providers.setAssigned([open, attached, done]);

    createActiveWorkItem(database, {
      title: 'Attached',
      attachments: [{ type: 'tracker-item', provider: 'jira', externalId: attached.id, payload: attached }],
    });

    const dashboard = buildDashboard({
      database,
      codeHost: providers.codeHost,
      tracker: providers.tracker,
      settings: { defaultAgent: 'pi', repositoryTopics: [] },
      syncIntervalMs: 300_000,
    });

    assert.deepEqual(dashboard.pendingIssues.map((issue) => issue.id), ['1']);
    assert.equal(dashboard.pendingIssues[0]?.createdAt, open.createdAt);
    assert.equal(dashboard.pendingIssues[0]?.updatedAt, open.updatedAt);
    assert.equal(dashboard.pendingReviews[0]?.createdAt, review.createdAt);
    assert.equal(dashboard.pendingReviews[0]?.updatedAt, review.updatedAt);
    assert.equal(dashboard.activeWorkItems.length, 1);
    assert.deepEqual(dashboard.activeWorkItems[0]!.trackerIssueKeys, [attached.key]);
    assert.equal(dashboard.settings.defaultAgent, 'pi');
  } finally {
    database.db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('dashboard recent counts work_activity rows from yesterday and today', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-dashboard-'));
  const config = configForRoot(root);
  const database = openDatabase(config);
  const providers = fixtureProviders();
  try {
    const workItem = createManualWorkItem(database, { title: 'Recent' });
    // Creation is recorded today; only the activity below should count.
    database.db.prepare('delete from work_activity').run();
    const now = new Date();
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12, 0, 0);
    const twoDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2, 12, 0, 0);
    database.recordWorkActivity({ workItemId: workItem.id, kind: 'session.created', occurredAt: yesterday.toISOString() });
    database.recordWorkActivity({ workItemId: workItem.id, kind: 'session.created', occurredAt: now.toISOString() });
    database.recordWorkActivity({ workItemId: workItem.id, kind: 'work-item.completed', occurredAt: now.toISOString() });
    database.recordWorkActivity({ workItemId: workItem.id, kind: 'session.created', occurredAt: twoDaysAgo.toISOString() });

    const dashboard = buildDashboard({
      database,
      codeHost: providers.codeHost,
      tracker: providers.tracker,
      settings: { defaultAgent: 'pi', repositoryTopics: [] },
      syncIntervalMs: 300_000,
      now,
    });

    assert.equal(dashboard.recent.since, startOfPreviousLocalDay(now).toISOString());
    assert.equal(dashboard.recent.sessionCount, 2);
    assert.equal(dashboard.recent.completedCount, 1);
    assert.equal(dashboard.recent.activityCount, 3);
    assert.equal(dashboard.recent.workItems.length, 1);
    assert.equal(dashboard.recent.workItems[0]!.id, workItem.id);
  } finally {
    database.db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('dashboard freshness marks stale caches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-dashboard-'));
  const config = configForRoot(root);
  const database = openDatabase(config);
  const now = new Date('2026-10-07T12:00:00.000Z');
  const providers = fixtureProviders([
    storedSnapshot('tracker.jira.assignedIssues', [], new Date(now.getTime() - 60_000)),
    storedSnapshot('codeHost.github.reviewRequests', [], new Date(now.getTime() - 60 * 60_000)),
  ]);
  try {

    const dashboard = buildDashboard({
      database,
      codeHost: providers.codeHost,
      tracker: providers.tracker,
      settings: { defaultAgent: 'pi', repositoryTopics: [] },
      syncIntervalMs: 300_000,
      now,
    });

    assert.equal(dashboard.freshness.trackerStale, false);
    assert.equal(dashboard.freshness.codeHostStale, true);
  } finally {
    database.db.close();
    await rm(root, { recursive: true, force: true });
  }
});
