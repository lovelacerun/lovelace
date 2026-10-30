import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createCacheStore } from '@lovelace/cache';
import type { ServerConfig } from '@lovelace/core';
import { createCachedCodeHost, createCachedTracker } from './cached-providers.js';
import { openDatabase } from './database.js';
import { changeRequest, fixtureCodeHost, fixtureTracker, trackerIssue } from './test-support/providers.js';
import { testDirs } from './test-support/dirs.js';

const issue = trackerIssue({ id: '1' });

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-cached-providers-'));
  const config: ServerConfig = { ...testDirs(join(root, '.lovelace')), port: 27421, logLevel: 'info', syncIntervalMs: 300_000, defaultAgent: 'pi' };
  const database = openDatabase(config);
  t.after(async () => { database.db.close(); await rm(root, { recursive: true, force: true }); });
  return database;
}

function tracker(calls: string[]) {
  return fixtureTracker({
    fetchAssignedIssues: async () => { calls.push('assigned'); return [issue]; },
    fetchIssue: async (key) => { calls.push('issue:' + key); return issue; },
  });
}

test('provider lists persist to SQLite once and load on restart without refetching', async (t) => {
  const database = await fixture(t);
  const calls: string[] = [];
  const cached = createCachedTracker(createCacheStore({ storage: database.cacheStorage }), tracker(calls));
  await cached.refreshAssignedIssues();
  await cached.fetchIssue('PROJ-1');
  assert.deepEqual(database.cacheStorage.load().map((row) => row.key), ['tracker.jira.assignedIssues'], 'per-item lookups stay in memory');

  const restarted = createCachedTracker(createCacheStore({ storage: database.cacheStorage }), tracker(calls));
  assert.deepEqual(restarted.peekAssignedIssues()?.value, [issue]);
  assert.deepEqual(calls, ['assigned', 'issue:PROJ-1']);
});

test('eviction removes persisted rows so storage stays bounded', async (t) => {
  const database = await fixture(t);
  const cache = createCacheStore({ storage: database.cacheStorage, maxEntries: 1 });
  await createCachedTracker(cache, tracker([])).refreshAssignedIssues();
  await createCachedCodeHost(cache, fixtureCodeHost()).refreshReviewRequests();
  assert.deepEqual(database.cacheStorage.load().map((row) => row.key), ['codeHost.github.reviewRequests']);
});

test('persisted lists of an older shape count as missing', async (t) => {
  const database = await fixture(t);
  database.cacheStorage.save({ key: 'tracker.jira.assignedIssues', fetchedAt: new Date().toISOString(), payloadJson: JSON.stringify([{ ...issue, done: undefined }]) });
  assert.equal(createCachedTracker(createCacheStore({ storage: database.cacheStorage }), tracker([])).peekAssignedIssues(), undefined);
});

test('per-item reads are cached within their TTL; sync refreshes bypass it', async () => {
  let calls = 0;
  const codeHost = createCachedCodeHost(createCacheStore(), fixtureCodeHost({
    fetchChangeRequest: async (ref) => { calls++; return changeRequest(ref); },
  }));
  const ref = { repository: 'org/repo', number: 1 };
  await Promise.all([codeHost.fetchChangeRequest(ref), codeHost.fetchChangeRequest(ref)]);
  await codeHost.fetchChangeRequest(ref);
  assert.equal(calls, 1);
  await codeHost.refreshChangeRequest(ref);
  assert.equal(calls, 2);
  await codeHost.fetchChangeRequest({ ...ref, number: 2 });
  assert.equal(calls, 3);
});

test('a failed sync keeps the last-good list', async () => {
  let fail = false;
  const cached = createCachedTracker(createCacheStore(), fixtureTracker({
    fetchAssignedIssues: async () => { if (fail) throw new Error('rate limited'); return [issue]; },
  }));
  await cached.refreshAssignedIssues();
  fail = true;
  await assert.rejects(cached.refreshAssignedIssues(), /rate limited/);
  assert.deepEqual(cached.peekAssignedIssues()?.value, [issue]);
});
