import type { GitHubReviewRequest, InboxSourceType, JiraIssueSummary, LovelaceLink, WorkItem, WorkItemDetails, WorkItemMeta } from '@lovelace/core';
import groupBy from '@nkzw/core/groupBy.js';
import isPresent from '@nkzw/core/isPresent.js';
import safeParse from '@nkzw/core/safeParse.js';
import type { CachedGitHub, CachedJira } from '../cached-providers.js';
import type { DatabaseState } from '../database.js';
import { asRecord, dedupeLinks, isNonEmptyString, truncateText } from '../helpers.js';
import { pendingReviewRequests } from './review-request-service.js';

export interface InboxProviders {
  github: Pick<CachedGitHub, 'peekReviewRequests'>;
  jira: Pick<CachedJira, 'peekAssignedIssues'>;
}

type InboxItemSourceType = 'work-item' | 'tracker-item' | 'change-request';

interface InboxItemSource {
  sourceType: InboxSourceType;
  provider: string;
  externalId: string;
  payload: unknown;
}

interface RelatedWorkItemRef {
  id: string;
  title: string;
  state: WorkItem['state'];
  completedAt: string | null;
}

interface InboxItem {
  id: string;
  sourceType: InboxItemSourceType;
  title: string;
  subtitle: string | null;
  url: string | null;
  updatedAt: string;
  sources?: InboxItemSource[];
  links?: LovelaceLink[];
  relatedWorkItems?: RelatedWorkItemRef[];
  raw: JiraIssueSummary | WorkItemDetails | GitHubReviewRequest;
}

interface InboxResponse {
  activeWorkItems: InboxItem[];
  jiraIssues: InboxItem[];
  reviewRequests: InboxItem[];
}

export function buildInbox(database: DatabaseState, providers: InboxProviders): InboxResponse {
  const workItems = database.listWorkItems();
  const metas = database.listWorkItemMeta();
  const metasByWorkItemId = groupBy(metas, (meta) => meta.workItemId);
  const dismissedSourceKeys = buildDismissedSourceKeySet(database.listInboxMeta());
  const linkedSourceKeys = buildLinkedSourceKeySet(workItems, metas);
  const assignedIssues = providers.jira.peekAssignedIssues()?.value ?? [];

  const relatedWorkItemsBySourceKey = buildRelatedWorkItemRefMap(workItems, metas);

  const jiraIssues = assignedIssues
    .filter((issue) => !dismissedSourceKeys.has(sourceKey('tracker-item', 'jira', issue.id)))
    .filter((issue) => !linkedSourceKeys.has(sourceKey('tracker-item', 'jira', issue.id)))
    .map((issue) => toTrackerInboxItem(issue, relatedWorkItemsBySourceKey.get(sourceKey('tracker-item', 'jira', issue.id)) ?? []));

  const activeWorkItems = workItems
    .filter((workItem) => workItem.state === 'active')
    .map((workItem) => toWorkItemInboxItem(workItem, metasByWorkItemId.get(workItem.id) ?? []));

  return {
    activeWorkItems: sortByUpdatedAt(activeWorkItems),
    jiraIssues: sortByUpdatedAt(jiraIssues),
    reviewRequests: pendingReviewRequests(database, providers.github).map(toChangeRequestInboxItem),
  };
}

function toWorkItemInboxItem(workItem: WorkItem, metas: WorkItemMeta[]): InboxItem {
  const firstUrl = findPrimaryUrl(metas);
  return {
    id: workItem.id,
    sourceType: 'work-item',
    title: workItem.title,
    subtitle: summarizeWorkItemMeta(workItem, metas),
    url: firstUrl,
    updatedAt: workItem.updatedAt,
    links: extractManualTrackerLinks(metas),
    raw: { workItem, metas },
  };
}

function toTrackerInboxItem(issue: JiraIssueSummary, relatedWorkItems: RelatedWorkItemRef[]): InboxItem {
  const slimIssue = toSlimTrackerIssue(issue);
  return {
    id: issue.id,
    sourceType: 'tracker-item',
    title: `${issue.key}: ${issue.title}`,
    subtitle: [issue.issueType, issue.status].filter(Boolean).join(' · ') || null,
    url: issue.url,
    updatedAt: issue.updatedAt,
    relatedWorkItems: relatedWorkItems.length > 0 ? relatedWorkItems : undefined,
    sources: [
      {
        sourceType: 'tracker-item',
        provider: 'jira',
        externalId: issue.id,
        payload: slimIssue,
      },
    ],
    raw: slimIssue,
  };
}

function toChangeRequestInboxItem(review: GitHubReviewRequest): InboxItem {
  const slimReview = { ...review, descriptionText: truncateText(review.descriptionText, 4000) };
  return {
    id: review.id,
    sourceType: 'change-request',
    title: `${review.repoFullName}#${review.number}: ${review.title}`,
    subtitle: review.authorLogin,
    url: review.url,
    updatedAt: review.updatedAt,
    sources: [{ sourceType: 'change-request', provider: 'github', externalId: review.id, payload: slimReview }],
    raw: slimReview,
  };
}

function toSlimTrackerIssue(issue: JiraIssueSummary): JiraIssueSummary {
  return {
    ...issue,
    descriptionText: truncateText(issue.descriptionText, 4000),
  };
}

function summarizeWorkItemMeta(workItem: WorkItem, metas: WorkItemMeta[]): string | null {
  const trackerCount = metas.filter((meta) => meta.metaType === 'tracker-item').length;
  const changeRequestCount = metas.filter((meta) => meta.metaType === 'change-request').length;
  const sessionCount = metas.filter((meta) => meta.metaType === 'session').length;
  const repositoryCount = metas.filter((meta) => meta.metaType === 'repository').length;
  const parts = [
    trackerCount > 0 ? `${trackerCount} tracker ${trackerCount === 1 ? 'item' : 'items'}` : null,
    changeRequestCount > 0 ? `${changeRequestCount} change ${changeRequestCount === 1 ? 'request' : 'requests'}` : null,
    sessionCount > 0 ? `${sessionCount} ${sessionCount === 1 ? 'session' : 'sessions'}` : null,
    repositoryCount > 0 ? `${repositoryCount} ${repositoryCount === 1 ? 'repository' : 'repositories'}` : null,
  ].filter(isPresent);

  if (parts.length > 0) return parts.join(' · ');
  if (workItem.notes) return workItem.notes;
  return workItem.state;
}

function findPrimaryUrl(metas: WorkItemMeta[]): string | null {
  const linkedItems = metas.filter((item) => item.metaType === 'change-request' || item.metaType === 'tracker-item');
  if (linkedItems.length !== 1) return null;
  const url = asRecord(safeParse(linkedItems[0]!.payloadJson)).url;
  return isNonEmptyString(url) ? url : null;
}

function extractManualTrackerLinks(metas: WorkItemMeta[]): LovelaceLink[] {
  return dedupeLinks(
    metas.flatMap((meta) => {
      if (meta.metaType !== 'tracker-item' || !meta.externalId) return [];
      const payload = asRecord(safeParse(meta.payloadJson));
      return [
        {
          type: 'tracker-item' as const,
          provider: meta.provider ?? 'unknown',
          externalId: meta.externalId,
          key: typeof payload.key === 'string' ? payload.key : meta.externalId,
          url: typeof payload.url === 'string' ? payload.url : null,
        },
      ];
    }),
  );
}

function buildLinkedSourceKeySet(workItems: WorkItem[], metas: WorkItemMeta[]): Set<string> {
  const hiddenStates = new Set<WorkItem['state']>(['done', 'cancelled']);
  const activeWorkItemIds = new Set(workItems.filter((workItem) => !hiddenStates.has(workItem.state)).map((workItem) => workItem.id));
  return new Set(
    metas
      .filter((meta) => activeWorkItemIds.has(meta.workItemId))
      .filter((meta) => (meta.metaType === 'tracker-item' || meta.metaType === 'change-request') && meta.externalId)
      .map((meta) => sourceKey(meta.metaType as InboxSourceType, meta.provider, meta.externalId as string)),
  );
}

function buildRelatedWorkItemRefMap(workItems: WorkItem[], metas: WorkItemMeta[]): Map<string, RelatedWorkItemRef[]> {
  const workItemsById = new Map(workItems.map((workItem) => [workItem.id, workItem]));
  const grouped = new Map<string, RelatedWorkItemRef[]>();
  for (const meta of metas) {
    if ((meta.metaType !== 'tracker-item' && meta.metaType !== 'change-request') || !meta.externalId) continue;
    const workItem = workItemsById.get(meta.workItemId);
    if (!workItem) continue;
    const key = sourceKey(meta.metaType as InboxSourceType, meta.provider, meta.externalId);
    const refs = grouped.get(key) ?? [];
    if (!refs.some((ref) => ref.id === workItem.id)) {
      refs.push({ id: workItem.id, title: workItem.title, state: workItem.state, completedAt: workItem.completedAt });
    }
    grouped.set(key, refs);
  }
  return grouped;
}

function buildDismissedSourceKeySet(entries: { sourceType: InboxSourceType; provider: string | null; externalId: string; state: string }[]) {
  return new Set(entries.filter((entry) => entry.state === 'dismissed').map((entry) => sourceKey(entry.sourceType, entry.provider, entry.externalId)));
}

function sourceKey(sourceType: InboxSourceType, provider: string | null, externalId: string): string {
  return `${sourceType}:${provider ?? ''}:${externalId}`;
}

function sortByUpdatedAt<T extends { updatedAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
