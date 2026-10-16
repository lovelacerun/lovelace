import type { Cached, CacheStore } from '@lovelace/cache';
import type { GitHubClient, GitHubPullRequestDetails, GitHubPullRequestStatus, GitHubReviewBuckets, RepoRecord } from '@lovelace/github-client';
import type { JiraClient, JiraIssueSummary, JiraProjectSummary } from '@lovelace/jira-client';
import { listModels, type HarnessModel } from '@lovelace/model-catalog';
import { executableSearchPath } from './tools/executables.js';
import type { LoadedTool } from './tools/tool-loader.js';

/** Lists refreshed by the scheduled sync. */
const LIST_TTL_MS = 5 * 60_000;
const PROJECTS_TTL_MS = 24 * 60 * 60_000;
/** Per-item lookups: short enough for interactive freshness, long enough to absorb bursts. */
const DETAIL_TTL_MS = 60_000;
/** Harness model catalogs change with harness updates, not by the minute. */
const MODELS_TTL_MS = 60 * 60_000;

interface Resource<T> {
  read(): Promise<T>;
  refresh(): Promise<T>;
  peek(): Cached<T> | undefined;
}

function resource<T>(cache: CacheStore, key: string, ttlMs: number, fetch: (signal: AbortSignal) => Promise<T>,
  validate?: (value: unknown) => value is T, persist = true): Resource<T> {
  const request = { key, ttlMs, fetch, validate, persist };
  return { read: () => cache.read(request), refresh: () => cache.refresh(request), peek: () => cache.peek(key, validate) };
}

/** Per-item lookups stay in memory: their durable copy lives in work-item metas. */
function detail<T>(cache: CacheStore, key: string, fetch: (signal: AbortSignal) => Promise<T>): Resource<T> {
  return resource(cache, key, DETAIL_TTL_MS, fetch, undefined, false);
}

export type CachedGitHub = ReturnType<typeof createCachedGitHub>;

/** GitHub reads through the cache. Method shapes match `GitHubClient`, plus explicit refresh/peek. */
export function createCachedGitHub(cache: CacheStore, github: GitHubClient) {
  // The catalog's durable copy is the `repos` table; the cache only coalesces refreshes.
  const repositories = resource(cache, 'github.repoCatalog', LIST_TTL_MS, (signal) => github.fetchRepositories({ signal }), isArray<RepoRecord>, false);
  const reviews = resource(cache, 'github.reviewRequests', LIST_TTL_MS, (signal) => github.fetchReviewRequests({ signal }), isReviewBuckets);
  const status = (repoFullName: string, number: number) => detail<GitHubPullRequestStatus | null>(cache, `github.pullRequestStatus:${repoFullName}#${number}`,
    (signal) => github.fetchPullRequestStatus(repoFullName, number, { signal }));
  const details = (repoFullName: string, number: number) => detail<GitHubPullRequestDetails | null>(cache, `github.pullRequestDetails:${repoFullName}#${number}`,
    (signal) => github.fetchPullRequestDetails(repoFullName, number, { signal }));
  return {
    isConfigured: () => github.isConfigured(),
    fetchRepositories: repositories.read,
    refreshRepositories: repositories.refresh,
    peekRepositories: repositories.peek,
    fetchReviewRequests: reviews.read,
    refreshReviewRequests: reviews.refresh,
    peekReviewRequests: reviews.peek,
    fetchPullRequestStatus: (repoFullName: string, number: number) => status(repoFullName, number).read(),
    refreshPullRequestStatus: (repoFullName: string, number: number) => status(repoFullName, number).refresh(),
    fetchPullRequestDetails: (repoFullName: string, number: number) => details(repoFullName, number).read(),
  };
}

export type CachedJira = ReturnType<typeof createCachedJira>;

/** Jira reads through the cache. Method shapes match `JiraClient`, plus explicit refresh/peek. */
export function createCachedJira(cache: CacheStore, jira: JiraClient) {
  const assigned = resource(cache, 'jira.assigned', LIST_TTL_MS, (signal) => jira.fetchAssignedIssues({ signal }), isIssues);
  const projects = resource(cache, 'jira.projects', PROJECTS_TTL_MS, (signal) => jira.fetchProjects({ signal }), isArray<JiraProjectSummary>);
  const issue = (keyOrId: string) => detail(cache, `jira.issue:${keyOrId}`, (signal) => jira.fetchIssue(keyOrId, { signal }));
  return {
    isConfigured: () => jira.isConfigured(),
    refreshAssignedIssues: assigned.refresh,
    peekAssignedIssues: assigned.peek,
    refreshProjects: projects.refresh,
    peekProjects: projects.peek,
    fetchIssue: (keyOrId: string) => issue(keyOrId).read(),
    refreshIssue: (keyOrId: string) => issue(keyOrId).refresh(),
  };
}

export type ModelLister = (tool: LoadedTool) => Promise<HarnessModel[]>;

/**
 * Each harness's models through the cache, per executable: persisted so a
 * restart serves them at once, revalidated in the background when stale.
 */
export function createCachedModels(cache: CacheStore): ModelLister {
  const env = () => ({ ...process.env, PATH: executableSearchPath() });
  return tool => resource(cache, `models.${tool.id}:${tool.executablePath}`, MODELS_TTL_MS,
    (signal) => listModels(tool.id, tool.executablePath, { signal, env: env() }), isArray<HarnessModel>).read();
}

// Persisted values may predate a shape change; failing values count as missing and are refetched.
function isArray<T>(value: unknown): value is T[] {
  return Array.isArray(value);
}

function isReviewBuckets(value: unknown): value is GitHubReviewBuckets {
  const buckets = value as Partial<GitHubReviewBuckets> | null;
  return Boolean(buckets && Array.isArray(buckets.human) && Array.isArray(buckets.automated));
}

function isIssues(value: unknown): value is JiraIssueSummary[] {
  return Array.isArray(value) && value.every((entry) => {
    const issue = entry as Record<string, unknown> | null;
    return Boolean(issue) && ['id', 'key', 'title', 'url', 'updatedAt'].every((key) => typeof issue![key] === 'string')
      && issue!.id !== '' && issue!.key !== ''
      && ['status', 'issueType', 'statusCategory'].every((key) => issue![key] === null || typeof issue![key] === 'string');
  });
}
