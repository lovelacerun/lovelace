import {
  isLaunchInProgress,
  type DashboardSettings,
  type DashboardFreshness,
  type DashboardIssue,
  type DashboardResponse,
  type DashboardReview,
  type DashboardRecent,
  type WorkItem,
  type WorkItemAttachment,
  type WorkItemSummary,
} from '@lovelace/core';
import groupBy from '@nkzw/core/groupBy.js';
import type { DatabaseState, LaunchRecord, WorkActivityRow } from '../database.js';
import type { CachedCodeHost, CachedTracker } from '../cached-providers.js';
import { pendingReviewRequests } from './review-request-service.js';

interface DashboardDeps {
  database: DatabaseState;
  codeHost: Pick<CachedCodeHost, 'provider' | 'peekRepositories' | 'peekReviewRequests'>;
  tracker: Pick<CachedTracker, 'provider' | 'peekAssignedIssues'>;
  settings: DashboardSettings;
  syncIntervalMs: number;
  /** Allows deterministic recent-activity windows in tests. Server passes `new Date()`. */
  now?: Date;
}

export function buildDashboard(deps: DashboardDeps): DashboardResponse {
  const now = deps.now ?? new Date();
  const workItems = deps.database.listWorkItems();
  const attachmentsByWorkItemId = groupBy(deps.database.listAttachments(), (attachment) => attachment.workItemId);
  const launchesByWorkItemId = groupBy(deps.database.listLaunches(), launch => launch.workItemId);

  const activeWorkItems = workItems
    .filter((item) => item.state === 'active')
    .map((item) => toSummary(item, attachmentsByWorkItemId.get(item.id) ?? [], launchesByWorkItemId.get(item.id) ?? []))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const pendingIssues = buildPendingIssues(deps.tracker, deps.database, workItems, attachmentsByWorkItemId);
  const pendingReviews = buildPendingReviews(deps.database, deps.codeHost);
  const recent = buildRecent(deps.database, workItems, attachmentsByWorkItemId, launchesByWorkItemId, now);
  const freshness = buildFreshness(deps, deps.syncIntervalMs, now);

  return {
    activeWorkItems,
    pendingIssues,
    pendingReviews,
    recent,
    settings: deps.settings,
    freshness,
  };
}

function buildPendingIssues(
  tracker: DashboardDeps['tracker'],
  database: DatabaseState,
  workItems: WorkItem[],
  attachmentsByWorkItemId: Map<string, WorkItemAttachment[]>,
): DashboardIssue[] {
  const issues = tracker.peekAssignedIssues()?.value ?? [];
  const hiddenInboxIds = new Set(database.listInboxMeta()
    .filter((meta) => meta.sourceType === 'tracker-item' && meta.provider === tracker.provider)
    .filter((meta) => meta.state === 'dismissed')
    .map((meta) => meta.externalId));
  const activeAttachedIds = new Set<string>();
  const activeAttachedKeys = new Set<string>();
  for (const workItem of workItems) {
    // Local completion is not an invitation to start the same issue again.
    if (workItem.state === 'cancelled') continue;
    for (const attachment of attachmentsByWorkItemId.get(workItem.id) ?? []) {
      if (attachment.type !== 'tracker-item' || attachment.provider !== tracker.provider) continue;
      activeAttachedIds.add(attachment.externalId);
      if (attachment.payload.key) activeAttachedKeys.add(attachment.payload.key.toUpperCase());
    }
  }

  return issues
    .filter((issue) => !activeAttachedIds.has(issue.id))
    .filter((issue) => !activeAttachedKeys.has(issue.key.toUpperCase()))
    .filter((issue) => !hiddenInboxIds.has(issue.id) && !hiddenInboxIds.has(issue.key))
    .filter((issue) => !issue.done)
    .map((issue): DashboardIssue => ({
      id: issue.id,
      key: issue.key,
      title: issue.title,
      url: issue.url,
      status: issue.status,
      issueType: issue.issueType,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
    }));
}

function buildPendingReviews(database: DatabaseState, codeHost: DashboardDeps['codeHost']): DashboardReview[] {
  const repositories = database.listRepos();
  return pendingReviewRequests(database, codeHost).map((review): DashboardReview => ({
    id: review.id,
    number: review.number,
    title: review.title,
    url: review.url,
    repository: review.repository,
    repoId: repositories.find((repo) => repo.fullName.toLowerCase() === review.repository.toLowerCase())?.id ?? null,
    author: review.author,
    sourceBranch: review.sourceBranch,
    targetBranch: review.targetBranch,
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
  }));
}

function buildRecent(
  database: DatabaseState,
  workItems: WorkItem[],
  attachmentsByWorkItemId: Map<string, WorkItemAttachment[]>,
  launchesByWorkItemId: Map<string, LaunchRecord[]>,
  now: Date,
): DashboardRecent {
  const since = startOfPreviousLocalDay(now).toISOString();
  const activity = database.listWorkActivity({ sinceIso: since });
  const workItemsById = new Map(workItems.map((item) => [item.id, item]));

  const touchedWorkItemIds = new Set(activity.map((row: WorkActivityRow) => row.workItemId));
  const recentWorkItems: WorkItemSummary[] = [];
  for (const id of touchedWorkItemIds) {
    const workItem = workItemsById.get(id);
    if (!workItem) continue;
    recentWorkItems.push(toSummary(workItem, attachmentsByWorkItemId.get(id) ?? [], launchesByWorkItemId.get(id) ?? []));
  }
  recentWorkItems.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const sessionCount = activity.filter((row) => row.kind === 'session.created').length;
  const distinctWorkItems = (kind: string) => new Set(activity.filter((row) => row.kind === kind).map((row) => row.workItemId)).size;

  return {
    since,
    workItems: recentWorkItems,
    sessionCount,
    completedCount: distinctWorkItems('work-item.completed'),
    cancelledCount: distinctWorkItems('work-item.cancelled'),
    activityCount: activity.length,
  };
}

function buildFreshness(deps: Pick<DashboardDeps, 'codeHost' | 'tracker'>, syncIntervalMs: number, now: Date): DashboardFreshness {
  const trackerFetchedAt = deps.tracker.peekAssignedIssues()?.fetchedAt ?? null;
  const codeHostFetchedAt = [deps.codeHost.peekRepositories()?.fetchedAt, deps.codeHost.peekReviewRequests()?.fetchedAt]
    .reduce<string | null>((latest, fetchedAt) => (fetchedAt && (!latest || fetchedAt > latest) ? fetchedAt : latest), null);
  const staleAfter = syncIntervalMs * 2;
  return {
    trackerFetchedAt,
    codeHostFetchedAt,
    trackerStale: isStale(trackerFetchedAt, now, staleAfter),
    codeHostStale: isStale(codeHostFetchedAt, now, staleAfter),
  };
}

function isStale(fetchedAt: string | null, now: Date, staleAfter: number): boolean {
  if (!fetchedAt) return true;
  const parsed = Date.parse(fetchedAt);
  if (!Number.isFinite(parsed)) return true;
  return now.getTime() - parsed > staleAfter;
}

function toSummary(workItem: WorkItem, attachments: WorkItemAttachment[], launches: LaunchRecord[]): WorkItemSummary {
  const trackerIssueKeys: string[] = [];
  const changeRequestRefs: WorkItemSummary['changeRequestRefs'] = [];
  let sessionCount = 0;
  let repositoryCount = 0;
  for (const attachment of attachments) {
    if (attachment.type === 'session') {
      if (attachment.payload.status !== 'ended') sessionCount += 1;
    } else if (attachment.type === 'worktree') {
      if (attachment.payload.status === 'ready') repositoryCount += 1;
    } else if (attachment.type === 'tracker-item') {
      if (attachment.payload.key) trackerIssueKeys.push(attachment.payload.key);
    } else if (attachment.type === 'pull-request') {
      changeRequestRefs.push({ repository: attachment.payload.repository, number: attachment.payload.number });
    }
  }
  // A launch in progress takes priority; a later launch supersedes an old failure.
  const launchState = (launches.findLast(launch => isLaunchInProgress(launch.state)) ?? launches.at(-1))?.state;
  return {
    id: workItem.id,
    title: workItem.title,
    state: workItem.state,
    notes: workItem.notes,
    createdAt: workItem.createdAt,
    updatedAt: workItem.updatedAt,
    startedAt: workItem.startedAt,
    completedAt: workItem.completedAt,
    sessionCount,
    repositoryCount,
    ...(launchState && launchState !== 'started' ? { launchState } : {}),
    trackerIssueKeys,
    changeRequestRefs,
  };
}

/** Recent work spans yesterday and today, so items stay put during the day. */
export function startOfPreviousLocalDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
}
