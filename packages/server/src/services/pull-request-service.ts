import type { PullRequestMetaPayload, WorkItemMeta } from '@lovelace/core';
import safeParse from '@nkzw/core/safeParse.js';
import type { DatabaseState } from '../database.js';
import type { GitHubPullRequestStatus } from '@lovelace/github-client';
import type { CachedGitHub } from '../cached-providers.js';
import { addWorkItemMetas } from '../repositories/work-item-repository.js';
import type { PullRequestReleaseChecker } from './pull-request-release-service.js';

interface PullRequestRef {
  repoFullName: string;
  number: number;
}

export function parsePullRequestRef(input: { url?: string; repoFullName?: string; number?: number }): PullRequestRef | null {
  if (input.repoFullName && Number.isInteger(input.number) && input.number! > 0) {
    return { repoFullName: input.repoFullName, number: input.number! };
  }
  if (!input.url) return null;
  return parsePullRequestUrl(input.url);
}

function parsePullRequestUrl(value: string): PullRequestRef | null {
  try {
    const url = new URL(value);
    const parts = url.pathname.split('/').filter(Boolean);
    const pullIndex = parts.indexOf('pull');
    if (pullIndex !== 2) return null;
    const number = Number(parts[3]);
    if (!parts[0] || !parts[1] || !Number.isInteger(number) || number <= 0) return null;
    return { repoFullName: `${parts[0]}/${parts[1]}`, number };
  } catch {
    return null;
  }
}

export async function attachPullRequestToWorkItem(
  database: DatabaseState,
  github: CachedGitHub,
  workItemId: string,
  ref: PullRequestRef,
  releaseChecker: PullRequestReleaseChecker,
): Promise<WorkItemMeta | null> {
  if (!database.getWorkItem(workItemId)) return null;
  const status = await github.fetchPullRequestStatus(ref.repoFullName, ref.number);
  if (!status) throw new Error(`GitHub pull request not found: ${externalIdForPullRequest(ref)}`);
  const releaseStatuses = await releaseChecker.check(status);
  return upsertPullRequestMeta(database, workItemId, status, releaseStatuses);
}

export async function refreshPullRequestsForWorkItem(
  database: DatabaseState,
  github: CachedGitHub,
  workItemId: string,
  releaseChecker: PullRequestReleaseChecker,
): Promise<WorkItemMeta[] | null> {
  if (!database.getWorkItem(workItemId)) return null;
  const metas = database.listWorkItemMeta(workItemId).filter((meta) => meta.metaType === 'pull-request' && meta.provider === 'github');
  const updated: WorkItemMeta[] = [];
  for (const meta of metas) {
    const payload = parsePayload(meta);
    if (!payload) continue;
    const status = await github.refreshPullRequestStatus(payload.repoFullName, payload.number);
    if (!status) continue;
    const releaseStatuses = await releaseChecker.check(status);
    updated.push(upsertPullRequestMeta(database, workItemId, status, releaseStatuses, meta) ?? meta);
  }
  return updated;
}

export function detachPullRequestFromWorkItem(database: DatabaseState, workItemId: string, externalId: string): boolean {
  if (!database.getWorkItem(workItemId)) return false;
  database.deleteWorkItemMetasByExternalIds(workItemId, 'pull-request', 'github', [externalId]);
  database.touchWorkItem(workItemId);
  return true;
}

export async function refreshOpenPullRequests(
  database: DatabaseState,
  github: CachedGitHub,
  releaseChecker: PullRequestReleaseChecker,
  logger: { warn: (obj: unknown, msg: string) => void },
) {
  const result = { attempted: 0, updated: 0, failed: 0 };
  for (const workItem of database.listWorkItems('active')) {
    const metas = database.listWorkItemMeta(workItem.id).filter((meta) => meta.metaType === 'pull-request' && meta.provider === 'github');
    for (const meta of metas) {
      const payload = parsePayload(meta);
      if (!payload || payload.status === 'closed' || releaseTrackingComplete(payload, releaseChecker)) continue;
      result.attempted += 1;
      try {
        const status = await github.refreshPullRequestStatus(payload.repoFullName, payload.number);
        if (status) {
          const releaseStatuses = await releaseChecker.check(status);
          upsertPullRequestMeta(database, workItem.id, status, releaseStatuses, meta);
          result.updated += 1;
        }
      } catch (error) {
        result.failed += 1;
        logger.warn({ err: error, workItemId: workItem.id, externalId: meta.externalId }, 'Failed to refresh pull request meta');
      }
    }
  }
  return result;
}

function upsertPullRequestMeta(
  database: DatabaseState,
  workItemId: string,
  status: GitHubPullRequestStatus,
  releaseStatuses: PullRequestMetaPayload['releaseStatuses'],
  existing?: WorkItemMeta,
): WorkItemMeta {
  const now = new Date().toISOString();
  const externalId = externalIdForPullRequest(status);
  const current = existing ?? database.listWorkItemMeta(workItemId).find((meta) => meta.metaType === 'pull-request' && meta.provider === 'github' && meta.externalId === externalId);
  const previousPayload = current ? parsePayload(current) : null;
  const payload: PullRequestMetaPayload = {
    ...status,
    releaseStatuses,
    attachedAt: previousPayload?.attachedAt ?? now,
    lastSyncedAt: now,
  };
  if (current) {
    const updated = database.updateWorkItemMetaPayload(current.id, payload);
    database.touchWorkItem(workItemId);
    return updated ?? current;
  }
  return addWorkItemMetas(database, workItemId, [{ metaType: 'pull-request', provider: 'github', externalId, payload }])[0]!;
}

function releaseTrackingComplete(payload: PullRequestMetaPayload, checker: PullRequestReleaseChecker): boolean {
  return payload.status === 'merged'
    && checker.isComplete(payload.repoFullName, payload.releaseStatuses);
}

function externalIdForPullRequest(ref: PullRequestRef): string {
  return `${ref.repoFullName}#${ref.number}`;
}

function parsePayload(meta: WorkItemMeta): PullRequestMetaPayload | null {
  return safeParse<PullRequestMetaPayload>(meta.payloadJson);
}
