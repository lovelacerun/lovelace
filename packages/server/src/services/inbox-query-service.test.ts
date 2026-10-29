import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { GitHubReviewRequest, LovelaceConfig } from '@lovelace/core';
import { openDatabase } from '../database.js';
import { fixtureProviders, storedSnapshot } from '../test-support/providers.js';
import { buildInbox } from './inbox-query-service.js';

const review: GitHubReviewRequest = {
  id: 'pr-1', number: 1, title: 'fix: PROJ-7 retry uploads', url: 'https://github.invalid/org/repo/pull/1', repoFullName: 'org/repo',
  project: 'org/repo', type: 'Fix', authorLogin: 'human', author: 'human', descriptionText: null, updatedAt: '2026-10-01T00:00:00.000Z',
};

test('inbox lists pending review requests one by one', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-inbox-'));
  const config: LovelaceConfig = { domainRoot: root, lovelaceDir: join(root, '.lovelace'), port: 27421, logLevel: 'info', syncIntervalMs: 300_000, defaultAgent: 'pi', tui: { sidebarSide: 'right' } };
  const database = openDatabase(config);
  t.after(async () => { database.db.close(); await rm(root, { recursive: true, force: true }); });
  const { github, jira } = fixtureProviders([storedSnapshot('github.reviewRequests', [review])]);
  const inbox = buildInbox(database, { github, jira });
  assert.deepEqual(inbox.reviewRequests.map((item) => [item.sourceType, item.title, item.links]), [['change-request', 'org/repo#1: fix: PROJ-7 retry uploads', undefined]]);
});
