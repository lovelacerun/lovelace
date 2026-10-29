import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { LovelaceConfig } from '@lovelace/core';
import { openDatabase } from '../database.js';
import { changeRequest, fixtureProviders, storedSnapshot } from '../test-support/providers.js';
import { buildInbox } from './inbox-query-service.js';

const review = changeRequest({ repository: 'org/repo', number: 1, title: 'fix: PROJ-7 retry uploads', author: 'human' });

test('inbox lists pending review requests one by one', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-inbox-'));
  const config: LovelaceConfig = { domainRoot: root, lovelaceDir: join(root, '.lovelace'), port: 27421, logLevel: 'info', syncIntervalMs: 300_000, defaultAgent: 'pi', tui: { sidebarSide: 'right' } };
  const database = openDatabase(config);
  t.after(async () => { database.db.close(); await rm(root, { recursive: true, force: true }); });
  const { codeHost, tracker } = fixtureProviders([storedSnapshot('codeHost.github.reviewRequests', [review])]);
  const inbox = buildInbox(database, { codeHost, tracker });
  assert.deepEqual(inbox.reviewRequests.map((item) => [item.sourceType, item.title, item.links]), [['change-request', 'org/repo#1: fix: PROJ-7 retry uploads', undefined]]);
});
