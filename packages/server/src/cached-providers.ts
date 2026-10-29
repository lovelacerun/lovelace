import type { Cached, CacheStore } from '@lovelace/cache';
import type { ChangeRequest, Repository, TrackerIssue } from '@lovelace/core';
import { listModels, type HarnessModel } from '@lovelace/model-catalog';
import { executableSearchPath } from './tools/executables.js';
import type { LoadedTool } from './tools/tool-loader.js';
import { changeRequestId, type ChangeRequestRef, type CodeHost, type Tracker } from './providers/types.js';

/** Lists refreshed by the scheduled sync. */
const LIST_TTL_MS = 5 * 60_000;
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

/** Per-item lookups stay in memory: their durable copy lives in attachments. */
function detail<T>(cache: CacheStore, key: string, fetch: (signal: AbortSignal) => Promise<T>): Resource<T> {
  return resource(cache, key, DETAIL_TTL_MS, fetch, undefined, false);
}

export type CachedCodeHost = ReturnType<typeof createCachedCodeHost>;

/** Code host reads through the cache, plus explicit refresh/peek. */
export function createCachedCodeHost(cache: CacheStore, codeHost: CodeHost) {
  const prefix = `codeHost.${codeHost.provider}`;
  // The catalog's durable copy is the `repos` table; the cache only coalesces refreshes.
  const repositories = resource(cache, `${prefix}.repositories`, LIST_TTL_MS, (signal) => codeHost.fetchRepositories({ signal }), isArray<Repository>, false);
  const reviews = resource(cache, `${prefix}.reviewRequests`, LIST_TTL_MS, (signal) => codeHost.fetchReviewRequests({ signal }), isChangeRequests);
  const changeRequest = (ref: ChangeRequestRef) => detail(cache, `${prefix}.changeRequest:${changeRequestId(ref)}`,
    (signal) => codeHost.fetchChangeRequest(ref, { signal }));
  return {
    provider: codeHost.provider,
    name: codeHost.name,
    isConfigured: () => codeHost.isConfigured(),
    parseChangeRequestUrl: (url: string) => codeHost.parseChangeRequestUrl(url),
    fetchRepositories: repositories.read,
    refreshRepositories: repositories.refresh,
    peekRepositories: repositories.peek,
    refreshReviewRequests: reviews.refresh,
    peekReviewRequests: reviews.peek,
    fetchChangeRequest: (ref: ChangeRequestRef) => changeRequest(ref).read(),
    refreshChangeRequest: (ref: ChangeRequestRef) => changeRequest(ref).refresh(),
  };
}

export type CachedTracker = ReturnType<typeof createCachedTracker>;

/** Tracker reads through the cache, plus explicit refresh/peek. */
export function createCachedTracker(cache: CacheStore, tracker: Tracker) {
  const prefix = `tracker.${tracker.provider}`;
  const assigned = resource(cache, `${prefix}.assignedIssues`, LIST_TTL_MS, (signal) => tracker.fetchAssignedIssues({ signal }), isIssues);
  const issue = (idOrKey: string) => detail(cache, `${prefix}.issue:${idOrKey}`, (signal) => tracker.fetchIssue(idOrKey, { signal }));
  return {
    provider: tracker.provider,
    name: tracker.name,
    isConfigured: () => tracker.isConfigured(),
    parseIssueRef: (input: { key?: string; url?: string }) => tracker.parseIssueRef(input),
    refreshAssignedIssues: assigned.refresh,
    peekAssignedIssues: assigned.peek,
    fetchIssue: (idOrKey: string) => issue(idOrKey).read(),
    refreshIssue: (idOrKey: string) => issue(idOrKey).refresh(),
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

function isIssues(value: unknown): value is TrackerIssue[] {
  return Array.isArray(value) && value.every((entry) => {
    const issue = entry as Record<string, unknown> | null;
    return Boolean(issue) && ['id', 'key', 'title', 'url', 'updatedAt'].every((key) => typeof issue![key] === 'string')
      && issue!.id !== '' && issue!.key !== '' && typeof issue!.done === 'boolean'
      && ['status', 'issueType'].every((key) => issue![key] === null || typeof issue![key] === 'string');
  });
}

function isChangeRequests(value: unknown): value is ChangeRequest[] {
  return Array.isArray(value) && value.every((entry) => {
    const request = entry as Record<string, unknown> | null;
    return Boolean(request) && ['id', 'repository', 'title', 'url', 'status', 'updatedAt'].every((key) => typeof request![key] === 'string')
      && Number.isInteger(request!.number);
  });
}
