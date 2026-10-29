import type { GitHubReviewRequest, InboxSourceType, JiraIssueSummary, LovelaceLink, WorkItem, WorkItemAttachment, WorkItemDetails } from '@lovelace/core';
import groupBy from '@nkzw/core/groupBy.js';
import isPresent from '@nkzw/core/isPresent.js';
import type { CachedGitHub, CachedJira } from '../cached-providers.js';
import { toLaunch, type DatabaseState, type LaunchRecord } from '../database.js';
import { dedupeLinks, isNonEmptyString, truncateText } from '../helpers.js';
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
  const attachments = database.listAttachments();
  const attachmentsByWorkItemId = groupBy(attachments, (attachment) => attachment.workItemId);
  const launchesByWorkItemId = groupBy(database.listLaunches(), (launch) => launch.workItemId);
  const dismissedSourceKeys = buildDismissedSourceKeySet(database.listInboxMeta());
  const linkedSourceKeys = buildLinkedSourceKeySet(workItems, attachments);
  const assignedIssues = providers.jira.peekAssignedIssues()?.value ?? [];

  const relatedWorkItemsBySourceKey = buildRelatedWorkItemRefMap(workItems, attachments);

  const jiraIssues = assignedIssues
    .filter((issue) => !dismissedSourceKeys.has(sourceKey('tracker-item', 'jira', issue.id)))
    .filter((issue) => !linkedSourceKeys.has(sourceKey('tracker-item', 'jira', issue.id)))
    .map((issue) => toTrackerInboxItem(issue, relatedWorkItemsBySourceKey.get(sourceKey('tracker-item', 'jira', issue.id)) ?? []));

  const activeWorkItems = workItems
    .filter((workItem) => workItem.state === 'active')
    .map((workItem) => toWorkItemInboxItem(workItem, attachmentsByWorkItemId.get(workItem.id) ?? [], launchesByWorkItemId.get(workItem.id) ?? []));

  return {
    activeWorkItems: sortByUpdatedAt(activeWorkItems),
    jiraIssues: sortByUpdatedAt(jiraIssues),
    reviewRequests: pendingReviewRequests(database, providers.github).map(toChangeRequestInboxItem),
  };
}

function toWorkItemInboxItem(workItem: WorkItem, attachments: WorkItemAttachment[], launches: LaunchRecord[]): InboxItem {
  const firstUrl = findPrimaryUrl(attachments);
  return {
    id: workItem.id,
    sourceType: 'work-item',
    title: workItem.title,
    subtitle: summarizeWorkItem(workItem, attachments),
    url: firstUrl,
    updatedAt: workItem.updatedAt,
    links: extractManualTrackerLinks(attachments),
    raw: { workItem, attachments, launches: launches.map(toLaunch) },
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

function summarizeWorkItem(workItem: WorkItem, attachments: WorkItemAttachment[]): string | null {
  const count = (type: WorkItemAttachment['type']) => attachments.filter((attachment) => attachment.type === type).length;
  const trackerCount = count('tracker-item');
  const changeRequestCount = count('change-request');
  const sessionCount = count('session');
  const repositoryCount = count('worktree');
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

function findPrimaryUrl(attachments: WorkItemAttachment[]): string | null {
  const linkedItems = attachments.filter((attachment) => attachment.type === 'change-request' || attachment.type === 'tracker-item');
  if (linkedItems.length !== 1) return null;
  const url = linkedItems[0]!.payload.url;
  return isNonEmptyString(url) ? url : null;
}

function extractManualTrackerLinks(attachments: WorkItemAttachment[]): LovelaceLink[] {
  return dedupeLinks(
    attachments.flatMap((attachment) => {
      if (attachment.type !== 'tracker-item') return [];
      return [
        {
          type: 'tracker-item' as const,
          provider: attachment.provider,
          externalId: attachment.externalId,
          key: attachment.payload.key || attachment.externalId,
          url: attachment.payload.url || null,
        },
      ];
    }),
  );
}

function buildLinkedSourceKeySet(workItems: WorkItem[], attachments: WorkItemAttachment[]): Set<string> {
  const hiddenStates = new Set<WorkItem['state']>(['done', 'cancelled']);
  const activeWorkItemIds = new Set(workItems.filter((workItem) => !hiddenStates.has(workItem.state)).map((workItem) => workItem.id));
  return new Set(
    attachments
      .filter((attachment) => activeWorkItemIds.has(attachment.workItemId))
      .flatMap((attachment) => attachment.type === 'tracker-item' || attachment.type === 'change-request'
        ? [sourceKey(attachment.type, attachment.provider, attachment.externalId)] : []),
  );
}

function buildRelatedWorkItemRefMap(workItems: WorkItem[], attachments: WorkItemAttachment[]): Map<string, RelatedWorkItemRef[]> {
  const workItemsById = new Map(workItems.map((workItem) => [workItem.id, workItem]));
  const grouped = new Map<string, RelatedWorkItemRef[]>();
  for (const attachment of attachments) {
    if (attachment.type !== 'tracker-item' && attachment.type !== 'change-request') continue;
    const workItem = workItemsById.get(attachment.workItemId);
    if (!workItem) continue;
    const key = sourceKey(attachment.type, attachment.provider, attachment.externalId);
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
