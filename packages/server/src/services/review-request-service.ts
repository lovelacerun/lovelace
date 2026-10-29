import type { GitHubReviewRequest } from '@lovelace/core';
import type { CachedGitHub } from '../cached-providers.js';
import type { DatabaseState } from '../database.js';

/**
 * Cached review requests that are neither dismissed nor attached to local work.
 * Like Jira issues, finished local work is not an invitation to review again.
 */
export function pendingReviewRequests(database: DatabaseState, github: Pick<CachedGitHub, 'peekReviewRequests'>): GitHubReviewRequest[] {
  const dismissed = new Set(database.listInboxMeta()
    .filter((meta) => meta.sourceType === 'change-request' && meta.provider === 'github' && meta.state === 'dismissed')
    .map((meta) => meta.externalId));
  const workItemIds = new Set(database.listWorkItems().filter((item) => item.state !== 'cancelled').map((item) => item.id));
  const attached = new Set(database.listAttachmentsOfType('change-request')
    .filter((attachment) => attachment.provider === 'github' && workItemIds.has(attachment.workItemId))
    .map((attachment) => attachment.externalId));
  return (github.peekReviewRequests()?.value ?? [])
    .filter((review) => !dismissed.has(review.id) && !attached.has(review.id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
