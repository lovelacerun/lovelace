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

test('inbox infers Jira links for cached review requests from known project keys', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-inbox-'));
  const config: LovelaceConfig = { domainRoot: root, lovelaceDir: join(root, '.lovelace'), port: 27421, logLevel: 'info', syncIntervalMs: 300_000, defaultAgent: 'pi', tui: { sidebarSide: 'right' } };
  const database = openDatabase(config);
  t.after(async () => { database.db.close(); await rm(root, { recursive: true, force: true }); });
  const { github, jira } = fixtureProviders([
    storedSnapshot('github.reviewRequests', { human: [review], automated: [] }),
    storedSnapshot('jira.projects', [{ id: '1', key: 'PROJ', name: 'Core Services', url: 'https://jira.invalid/browse/PROJ' }]),
  ]);
  const inbox = buildInbox(database, { github, jira, jiraBaseUrl: 'https://jira.invalid' });
  assert.equal(inbox.humanReviewGroups.length, 1);
  assert.deepEqual(inbox.humanReviewGroups[0]!.links?.map((link) => [link.key, link.url]), [['PROJ-7', 'https://jira.invalid/browse/PROJ-7']]);
});
