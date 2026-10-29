import { createCacheStore, type CacheSnapshot } from '@lovelace/cache';
import type { ChangeRequest, TrackerIssue } from '@lovelace/core';
import { createCachedCodeHost, createCachedTracker } from '../cached-providers.js';
import { changeRequestId, type CodeHost, type Tracker } from '../providers/types.js';

export function trackerIssue(overrides: Partial<TrackerIssue> & Pick<TrackerIssue, 'id'>): TrackerIssue {
  return {
    key: `PROJ-${overrides.id}`, title: 'Fixture', url: `https://jira.invalid/browse/PROJ-${overrides.id}`, project: 'PROJ', status: 'To Do',
    done: false, issueType: 'Task', author: null, description: null, updatedAt: '2026-10-01T00:00:00.000Z', ...overrides,
  };
}

export function changeRequest(overrides: Partial<ChangeRequest> & Pick<ChangeRequest, 'repository' | 'number'>): ChangeRequest {
  return {
    id: changeRequestId(overrides), title: 'Fixture', url: `https://github.invalid/${overrides.repository}/pull/${overrides.number}`,
    author: null, sourceBranch: null, targetBranch: null, status: 'open', review: null, build: null, updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

export const fixtureTracker = (overrides: Partial<Tracker> = {}): Tracker => ({
  provider: 'jira', name: 'Jira', isConfigured: () => true,
  fetchAssignedIssues: async () => [], fetchIssue: async () => null, parseIssueRef: ({ key }) => key ?? null,
  ...overrides,
});

export const fixtureCodeHost = (overrides: Partial<CodeHost> = {}): CodeHost => ({
  provider: 'github', name: 'GitHub', isConfigured: () => true,
  fetchRepositories: async () => [], fetchReviewRequests: async () => [], fetchChangeRequest: async () => null,
  parseChangeRequestUrl: () => null,
  ...overrides,
});

/** Cached providers over in-memory fixtures. `stored` seeds the cache as if loaded from SQLite. */
export function fixtureProviders(stored: CacheSnapshot[] = []) {
  const data = {
    assigned: [] as TrackerIssue[],
    reviews: [] as ChangeRequest[],
  };
  const cache = createCacheStore({ storage: { load: () => stored, save() {}, delete() {} } });
  const tracker = createCachedTracker(cache, fixtureTracker({ fetchAssignedIssues: async () => data.assigned }));
  const codeHost = createCachedCodeHost(cache, fixtureCodeHost({ fetchReviewRequests: async () => data.reviews }));
  return {
    cache, tracker, codeHost, data,
    async setAssigned(issues: TrackerIssue[]) {
      data.assigned = issues;
      await tracker.refreshAssignedIssues();
    },
  };
}

export function storedSnapshot(key: string, value: unknown, fetchedAt = new Date()): CacheSnapshot {
  return { key, fetchedAt: fetchedAt.toISOString(), payloadJson: typeof value === 'string' ? value : JSON.stringify(value) };
}
