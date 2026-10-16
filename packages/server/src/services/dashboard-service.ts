import {
  isJiraStatusTerminal,
  type DashboardSettings,
  type DashboardFreshness,
  type DashboardJiraIssue,
  type DashboardResponse,
  type DashboardRecent,
  type JiraIssueSummary,
  type PullRequestMetaPayload,
  type WorkItem,
  type WorkItemMeta,
  type WorkItemSummary,
} from '@lovelace/core';
import groupBy from '@nkzw/core/groupBy.js';
import safeParse from '@nkzw/core/safeParse.js';
import { latestLaunchPhase } from '../repositories/launch-operation-repository.js';
import type { DatabaseState, LaunchOperation, WorkActivityRow } from '../database.js';
import type { CachedGitHub, CachedJira } from '../cached-providers.js';

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
  const metasByWorkItemId = groupBy(deps.database.listWorkItemMeta(), (meta) => meta.workItemId);
  const launchesByWorkItemId = groupBy(deps.database.listLaunchOperations(), operation => operation.workItemId);

  const activeWorkItems = workItems
    .filter((item) => item.state === 'active')
    .map((item) => toSummary(item, metasByWorkItemId.get(item.id) ?? [], launchesByWorkItemId.get(item.id) ?? []))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const pendingJiraIssues = buildPendingJiraIssues(deps.jira, deps.database, workItems, metasByWorkItemId);
  const recent = buildRecent(deps.database, workItems, metasByWorkItemId, launchesByWorkItemId, now);
  const freshness = buildFreshness(deps, deps.syncIntervalMs, now);

  return {
    activeWorkItems,
    pendingJiraIssues,
    recent,
    settings: deps.settings,
    freshness,
  };
}

function buildPendingJiraIssues(
  jira: DashboardDeps['jira'],
  database: DatabaseState,
  workItems: WorkItem[],
  metasByWorkItemId: Map<string, WorkItemMeta[]>,
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
    for (const meta of metasByWorkItemId.get(workItem.id) ?? []) {
      if (meta.metaType !== 'tracker-item' || meta.provider !== 'jira') continue;
      if (meta.externalId) activeAttachedIds.add(meta.externalId);
      const payload = safeParse<JiraIssueSummary>(meta.payloadJson);
      if (typeof payload?.key === 'string' && payload.key) activeAttachedKeys.add(payload.key.toUpperCase());
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

function buildRecent(
  database: DatabaseState,
  workItems: WorkItem[],
  metasByWorkItemId: Map<string, WorkItemMeta[]>,
  launchesByWorkItemId: Map<string, LaunchOperation[]>,
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
    recentWorkItems.push(toSummary(workItem, metasByWorkItemId.get(id) ?? [], launchesByWorkItemId.get(id) ?? []));
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

function toSummary(workItem: WorkItem, metas: WorkItemMeta[], launches: LaunchOperation[]): WorkItemSummary {
  const trackerIssueKeys: string[] = [];
  const pullRequestRefs: Array<{ repoFullName: string; number: number }> = [];
  let sessionCount = 0;
  let repositoryCount = 0;
  for (const meta of metas) {
    if (meta.metaType === 'session') {
      const payload = safeParse<{ status?: string }>(meta.payloadJson);
      if ((payload?.status ?? 'unknown') !== 'ended') sessionCount += 1;
    } else if (meta.metaType === 'repository') {
      const payload = safeParse<{ status?: string }>(meta.payloadJson);
      if (payload?.status === 'ready') repositoryCount += 1;
    } else if (meta.metaType === 'tracker-item' && meta.provider === 'jira') {
      const payload = safeParse<JiraIssueSummary>(meta.payloadJson);
      if (typeof payload?.key === 'string' && payload.key) trackerIssueKeys.push(payload.key);
    } else if (meta.metaType === 'pull-request') {
      const payload = safeParse<PullRequestMetaPayload>(meta.payloadJson);
      if (payload?.repoFullName && typeof payload.number === 'number') {
        pullRequestRefs.push({ repoFullName: payload.repoFullName, number: payload.number });
      }
    }
  }
  const launchPhase = latestLaunchPhase(launches);
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
    ...(launchPhase ? { launchPhase } : {}),
    trackerIssueKeys,
    pullRequestRefs,
  };
}

/** Recent work spans yesterday and today, so items stay put during the day. */
export function startOfPreviousLocalDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
}
