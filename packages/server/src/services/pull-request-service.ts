import type { Attachment, PullRequestPayload } from '@lovelace/core';
import type { DatabaseState } from '../database.js';
import type { GitHubPullRequestStatus } from '@lovelace/github-client';
import type { CachedGitHub } from '../cached-providers.js';
import { addAttachments } from '../repositories/work-item-repository.js';

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
): Promise<Attachment<'pull-request'> | null> {
  if (!database.getWorkItem(workItemId)) return null;
  const status = await github.fetchPullRequestStatus(ref.repoFullName, ref.number);
  if (!status) throw new Error(`GitHub pull request not found: ${externalIdForPullRequest(ref)}`);
  return upsertPullRequest(database, workItemId, status);
}

export async function refreshPullRequestsForWorkItem(
  database: DatabaseState,
  github: CachedGitHub,
  workItemId: string,
): Promise<Array<Attachment<'pull-request'>> | null> {
  if (!database.getWorkItem(workItemId)) return null;
  const updated: Array<Attachment<'pull-request'>> = [];
  for (const attachment of gitHubPullRequests(database, workItemId)) {
    const status = await github.refreshPullRequestStatus(attachment.payload.repoFullName, attachment.payload.number);
    if (!status) continue;
    updated.push(upsertPullRequest(database, workItemId, status, attachment));
  }
  return updated;
}

export function detachPullRequestFromWorkItem(database: DatabaseState, workItemId: string, externalId: string): boolean {
  if (!database.getWorkItem(workItemId)) return false;
  database.deleteLinkAttachments(workItemId, 'pull-request', 'github', [externalId]);
  database.touchWorkItem(workItemId);
  return true;
}

export async function refreshOpenPullRequests(
  database: DatabaseState,
  github: CachedGitHub,
  logger: { warn: (obj: unknown, msg: string) => void },
) {
  const result = { attempted: 0, updated: 0, failed: 0 };
  for (const workItem of database.listWorkItems('active')) {
    for (const attachment of gitHubPullRequests(database, workItem.id)) {
      const { payload } = attachment;
      if (payload.status === 'closed' || payload.status === 'merged') continue;
      result.attempted += 1;
      try {
        const status = await github.refreshPullRequestStatus(payload.repoFullName, payload.number);
        if (status) {
          upsertPullRequest(database, workItem.id, status, attachment);
          result.updated += 1;
        }
      } catch (error) {
        result.failed += 1;
        logger.warn({ err: error, workItemId: workItem.id, externalId: attachment.externalId }, 'Failed to refresh pull request');
      }
    }
  }
  return result;
}

function gitHubPullRequests(database: DatabaseState, workItemId: string): Array<Attachment<'pull-request'>> {
  return database.listAttachmentsOfType('pull-request', workItemId).filter((attachment) => attachment.provider === 'github');
}

function upsertPullRequest(
  database: DatabaseState,
  workItemId: string,
  status: GitHubPullRequestStatus,
  existing?: Attachment<'pull-request'>,
): Attachment<'pull-request'> {
  const now = new Date().toISOString();
  const externalId = externalIdForPullRequest(status);
  const current = existing ?? gitHubPullRequests(database, workItemId).find((attachment) => attachment.externalId === externalId);
  const payload: PullRequestPayload = {
    ...status,
    attachedAt: current?.payload.attachedAt ?? now,
    lastSyncedAt: now,
  };
  if (current) {
    const updated = database.updateAttachment('pull-request', current.id, payload);
    database.touchWorkItem(workItemId);
    return updated ?? current;
  }
  return addAttachments(database, workItemId, [{ type: 'pull-request', provider: 'github', externalId, payload }])[0] as Attachment<'pull-request'>;
}

function externalIdForPullRequest(ref: PullRequestRef): string {
  return `${ref.repoFullName}#${ref.number}`;
}
