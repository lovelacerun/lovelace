import { createCacheStore, type CacheSnapshot } from '@lovelace/cache';
import type { JiraIssueSummary } from '@lovelace/core';
import type { GitHubReviewBuckets } from '@lovelace/github-client';
import type { JiraProjectSummary } from '@lovelace/jira-client';
import { createCachedGitHub, createCachedJira } from '../cached-providers.js';

/** Cached providers over in-memory fixtures. `stored` seeds the cache as if loaded from SQLite. */
export function fixtureProviders(stored: CacheSnapshot[] = []) {
  const data = {
    assigned: [] as JiraIssueSummary[],
    projects: [] as JiraProjectSummary[],
    reviews: { human: [], automated: [] } as GitHubReviewBuckets,
  };
  const cache = createCacheStore({ storage: { load: () => stored, save() {}, delete() {} } });
  const jira = createCachedJira(cache, {
    isConfigured: () => true,
    fetchAssignedIssues: async () => data.assigned,
    fetchProjects: async () => data.projects,
    fetchIssue: async () => null,
  });
  const github = createCachedGitHub(cache, {
    isConfigured: () => true,
    fetchRepositories: async () => [],
    fetchReviewRequests: async () => data.reviews,
    fetchPullRequestDetails: async () => null,
    fetchPullRequestStatus: async () => null,
  });
  return {
    cache, jira, github, data,
    async setAssigned(issues: JiraIssueSummary[]) {
      data.assigned = issues;
      await jira.refreshAssignedIssues();
    },
  };
}

export function storedSnapshot(key: string, value: unknown, fetchedAt = new Date()): CacheSnapshot {
  return { key, fetchedAt: fetchedAt.toISOString(), payloadJson: typeof value === 'string' ? value : JSON.stringify(value) };
}
