import {
  isJiraStatusTerminal,
  isLaunchInProgress,
  type DashboardSettings,
  type DashboardFreshness,
  type DashboardJiraIssue,
  type DashboardResponse,
  type DashboardReview,
  type DashboardRecent,
  type WorkItem,
  type WorkItemAttachment,
  type WorkItemSummary,
} from '@lovelace/core';
import groupBy from '@nkzw/core/groupBy.js';
import type { DatabaseState, LaunchRecord, WorkActivityRow } from '../database.js';
import type { CachedGitHub, CachedJira } from '../cached-providers.js';
import { pendingReviewRequests } from './review-request-service.js';

interface DashboardDeps {
  database: DatabaseState;
  github: Pick<CachedGitHub, 'peekRepositories' | 'peekReviewRequests'>;
  jira: Pick<CachedJira, 'peekAssignedIssues'>;
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

  const pendingJiraIssues = buildPendingJiraIssues(deps.jira, deps.database, workItems, attachmentsByWorkItemId);
  const pendingReviews = buildPendingReviews(deps.database, deps.github);
  const recent = buildRecent(deps.database, workItems, attachmentsByWorkItemId, launchesByWorkItemId, now);
  const freshness = buildFreshness(deps, deps.syncIntervalMs, now);

  return {
    activeWorkItems,
    pendingJiraIssues,
    pendingReviews,
    recent,
    settings: deps.settings,
    freshness,
  };
}

function buildPendingJiraIssues(
  jira: DashboardDeps['jira'],
  database: DatabaseState,
  workItems: WorkItem[],
  attachmentsByWorkItemId: Map<string, WorkItemAttachment[]>,
): DashboardJiraIssue[] {
  const issues = jira.peekAssignedIssues()?.value ?? [];
  const hiddenInboxIds = new Set(database.listInboxMeta()
    .filter((meta) => meta.sourceType === 'tracker-item' && meta.provider === 'jira')
    .filter((meta) => meta.state === 'dismissed')
    .map((meta) => meta.externalId));
  const activeAttachedIds = new Set<string>();
  const activeAttachedKeys = new Set<string>();
  for (const workItem of workItems) {
    // Local completion is not an invitation to start the same Jira issue again.
    if (workItem.state === 'cancelled') continue;
    for (const attachment of attachmentsByWorkItemId.get(workItem.id) ?? []) {
      if (attachment.type !== 'tracker-item' || attachment.provider !== 'jira') continue;
      activeAttachedIds.add(attachment.externalId);
      if (attachment.payload.key) activeAttachedKeys.add(attachment.payload.key.toUpperCase());
    }
  }

  return issues
    .filter((issue) => !activeAttachedIds.has(issue.id))
    .filter((issue) => !activeAttachedKeys.has(issue.key.toUpperCase()))
    .filter((issue) => !hiddenInboxIds.has(issue.id) && !hiddenInboxIds.has(issue.key))
    .filter((issue) => issue.statusCategory ? issue.statusCategory.trim().toLowerCase() !== 'done' : !isJiraStatusTerminal(issue.status))
    .map((issue): DashboardJiraIssue => ({
      id: issue.id,
      key: issue.key,
      title: issue.title,
      url: issue.url,
      status: issue.status,
      issueType: issue.issueType,
      updatedAt: issue.updatedAt,
    }));
}

function buildPendingReviews(database: DatabaseState, github: DashboardDeps['github']): DashboardReview[] {
  const repositories = database.listRepos();
  return pendingReviewRequests(database, github).map((review): DashboardReview => ({
    id: review.id,
    number: review.number,
    title: review.title,
    url: review.url,
    repoFullName: review.repoFullName,
    repoId: repositories.find((repo) => repo.fullName.toLowerCase() === review.repoFullName.toLowerCase())?.id ?? null,
    authorLogin: review.authorLogin,
    headRefName: review.headRefName ?? null,
    baseRefName: review.baseRefName ?? null,
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

function buildFreshness(deps: Pick<DashboardDeps, 'github' | 'jira'>, syncIntervalMs: number, now: Date): DashboardFreshness {
  const jiraFetchedAt = deps.jira.peekAssignedIssues()?.fetchedAt ?? null;
  const githubFetchedAt = [deps.github.peekRepositories()?.fetchedAt, deps.github.peekReviewRequests()?.fetchedAt]
    .reduce<string | null>((latest, fetchedAt) => (fetchedAt && (!latest || fetchedAt > latest) ? fetchedAt : latest), null);
  const staleAfter = syncIntervalMs * 2;
  return {
    jiraFetchedAt,
    githubFetchedAt,
    jiraStale: isStale(jiraFetchedAt, now, staleAfter),
    githubStale: isStale(githubFetchedAt, now, staleAfter),
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
  const pullRequestRefs: Array<{ repoFullName: string; number: number }> = [];
  let sessionCount = 0;
  let repositoryCount = 0;
  for (const attachment of attachments) {
    if (attachment.type === 'session') {
      if (attachment.payload.status !== 'ended') sessionCount += 1;
    } else if (attachment.type === 'worktree') {
      if (attachment.payload.status === 'ready') repositoryCount += 1;
    } else if (attachment.type === 'tracker-item' && attachment.provider === 'jira') {
      if (attachment.payload.key) trackerIssueKeys.push(attachment.payload.key);
    } else if (attachment.type === 'pull-request') {
      pullRequestRefs.push({ repoFullName: attachment.payload.repoFullName, number: attachment.payload.number });
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
    pullRequestRefs,
  };
}

/** Recent work spans yesterday and today, so items stay put during the day. */
export function startOfPreviousLocalDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
}
