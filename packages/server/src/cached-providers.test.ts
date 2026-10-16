import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createCacheStore } from '@lovelace/cache';
import type { JiraIssueSummary, LovelaceConfig } from '@lovelace/core';
import type { GitHubClient, GitHubPullRequestStatus } from '@lovelace/github-client';
import type { JiraClient } from '@lovelace/jira-client';
import { createCachedGitHub, createCachedJira } from './cached-providers.js';
import { openDatabase } from './database.js';

const issue: JiraIssueSummary = { id: '1', key: 'PROJ-1', title: 'Fixture', url: 'https://jira.invalid/browse/PROJ-1', project: 'PROJ', status: 'To Do', statusCategory: 'new', issueType: 'Task', type: 'Task', author: null, descriptionText: null, updatedAt: '2026-10-01T00:00:00.000Z' };

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-cached-providers-'));
  const config: LovelaceConfig = { domainRoot: root, lovelaceDir: join(root, '.lovelace'), port: 27421, logLevel: 'info', syncIntervalMs: 300_000, defaultAgent: 'pi', tui: { sidebarSide: 'right' } };
  const database = openDatabase(config);
  t.after(async () => { database.db.close(); await rm(root, { recursive: true, force: true }); });
  return database;
}

function jiraClient(calls: string[]): JiraClient {
  return {
    isConfigured: () => true,
    fetchAssignedIssues: async () => { calls.push('assigned'); return [issue]; },
    fetchProjects: async () => { calls.push('projects'); return []; },
    fetchIssue: async (key) => { calls.push('issue:' + key); return issue; },
  };
}

test('provider lists persist to SQLite once and load on restart without refetching', async (t) => {
  const database = await fixture(t);
  const calls: string[] = [];
  const jira = createCachedJira(createCacheStore({ storage: database.cacheStorage }), jiraClient(calls));
  await jira.refreshAssignedIssues();
  await jira.fetchIssue('PROJ-1');
  assert.deepEqual(database.cacheStorage.load().map((row) => row.key), ['jira.assigned'], 'per-item lookups stay in memory');

  const restarted = createCachedJira(createCacheStore({ storage: database.cacheStorage }), jiraClient(calls));
  assert.deepEqual(restarted.peekAssignedIssues()?.value, [issue]);
  assert.deepEqual(calls, ['assigned', 'issue:PROJ-1']);
});

test('eviction removes persisted rows so storage stays bounded', async (t) => {
  const database = await fixture(t);
  const cache = createCacheStore({ storage: database.cacheStorage, maxEntries: 1 });
  const jira = createCachedJira(cache, jiraClient([]));
  await jira.refreshAssignedIssues();
  await jira.refreshProjects();
  assert.deepEqual(database.cacheStorage.load().map((row) => row.key), ['jira.projects']);
});

test('per-item reads are cached within their TTL; sync refreshes bypass it', async () => {
  let calls = 0;
  const status = { repoFullName: 'org/repo', number: 1, status: 'open' } as GitHubPullRequestStatus;
  const github = createCachedGitHub(createCacheStore(), {
    isConfigured: () => true,
    fetchPullRequestStatus: async () => { calls++; return status; },
  } as unknown as GitHubClient);
  await Promise.all([github.fetchPullRequestStatus('org/repo', 1), github.fetchPullRequestStatus('org/repo', 1)]);
  await github.fetchPullRequestStatus('org/repo', 1);
  assert.equal(calls, 1);
  await github.refreshPullRequestStatus('org/repo', 1);
  assert.equal(calls, 2);
  await github.fetchPullRequestStatus('org/repo', 2);
  assert.equal(calls, 3);
});

test('a failed sync keeps the last-good list', async () => {
  let fail = false;
  const jira = createCachedJira(createCacheStore(), {
    ...jiraClient([]),
    fetchAssignedIssues: async () => { if (fail) throw new Error('rate limited'); return [issue]; },
  });
  await jira.refreshAssignedIssues();
  fail = true;
  await assert.rejects(jira.refreshAssignedIssues(), /rate limited/);
  assert.deepEqual(jira.peekAssignedIssues()?.value, [issue]);
});
