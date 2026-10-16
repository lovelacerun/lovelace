import type { JiraIssueSummary, WorkItemMeta } from '@lovelace/core';
import type { DatabaseState } from '../database.js';
import type { CachedJira } from '../cached-providers.js';
import groupBy from '@nkzw/core/groupBy.js';
import safeParse from '@nkzw/core/safeParse.js';
import { isNonEmptyString, truncateText } from '../helpers.js';
import { addWorkItemMetas } from '../repositories/work-item-repository.js';

interface JiraIssueRef {
  /** Issue key ("PROJ-123") or numeric Jira issue id. */
  key: string;
}

const ISSUE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const ISSUE_ID_PATTERN = /^\d+$/;
const DESCRIPTION_MAX_LENGTH = 4000;

export function parseJiraIssueRef(input: { key?: string; url?: string }): JiraIssueRef | null {
  const key = input.key?.trim();
  if (key && (ISSUE_KEY_PATTERN.test(key) || ISSUE_ID_PATTERN.test(key))) return { key: key.toUpperCase() };
  if (!input.url) return null;
  return parseJiraIssueUrl(input.url);
}

function parseJiraIssueUrl(value: string): JiraIssueRef | null {
  try {
    const url = new URL(value);
    const parts = url.pathname.split('/').filter(Boolean);
    const browseIndex = parts.indexOf('browse');
    const key = browseIndex >= 0 ? parts[browseIndex + 1] : null;
    if (!key || !ISSUE_KEY_PATTERN.test(key)) return null;
    return { key: key.toUpperCase() };
  } catch {
    return null;
  }
}

export async function attachJiraIssueToWorkItem(
  database: DatabaseState,
  jira: Pick<CachedJira, 'isConfigured' | 'fetchIssue'>,
  workItemId: string,
  ref: JiraIssueRef,
): Promise<WorkItemMeta | null> {
  if (!database.getWorkItem(workItemId)) return null;
  if (!jira.isConfigured()) throw new Error('Jira is not configured');
  const issue = await jira.fetchIssue(ref.key);
  if (!issue) throw new Error(`Jira issue not found: ${ref.key}`);
  database.deleteInboxMeta('tracker-item', 'jira', issue.id);
  return upsertTrackerItemMeta(database, workItemId, issue);
}

/** Detaches by the meta external id (Jira issue id) or by issue key. */
export function detachJiraIssueFromWorkItem(database: DatabaseState, workItemId: string, idOrKey: string): boolean {
  if (!database.getWorkItem(workItemId)) return false;
  const needle = idOrKey.trim();
  const externalIds = database
    .listWorkItemMeta(workItemId)
    .filter((meta) => meta.metaType === 'tracker-item' && meta.provider === 'jira' && meta.externalId)
    .filter((meta) => meta.externalId === needle || parsePayload(meta)?.key?.toUpperCase() === needle.toUpperCase())
    .map((meta) => meta.externalId as string);
  if (externalIds.length === 0) return true;
  database.deleteWorkItemMetasByExternalIds(workItemId, 'tracker-item', 'jira', externalIds);
  database.touchWorkItem(workItemId);
  return true;
}

function upsertTrackerItemMeta(database: DatabaseState, workItemId: string, issue: JiraIssueSummary): WorkItemMeta {
  const payload: JiraIssueSummary = {
    ...issue,
    descriptionText: truncateText(issue.descriptionText, DESCRIPTION_MAX_LENGTH),
  };
  const current = database
    .listWorkItemMeta(workItemId)
    .find((meta) => meta.metaType === 'tracker-item' && meta.provider === 'jira' && meta.externalId === issue.id);
  if (current) {
    const updated = database.updateWorkItemMetaPayload(current.id, payload);
    database.touchWorkItem(workItemId);
    return updated ?? current;
  }
  return addWorkItemMetas(database, workItemId, [{ metaType: 'tracker-item', provider: 'jira', externalId: issue.id, payload }])[0]!;
}

interface RefreshAttachedTrackerIssuesDeps {
  jira: Pick<CachedJira, 'isConfigured' | 'refreshIssue'>;
  database: DatabaseState;
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void };
}

const refreshes = new WeakMap<DatabaseState, Promise<{ refreshed: number; failed: number }>>();

/** Refresh upstream payloads only; local work state and recorded activity stay independent. */
export async function refreshAttachedTrackerIssues(deps: RefreshAttachedTrackerIssuesDeps): Promise<{ refreshed: number; failed: number }> {
  const pending = refreshes.get(deps.database);
  if (pending) return pending;
  const refresh = refreshAttachedTrackerIssuesOnce(deps);
  refreshes.set(deps.database, refresh);
  try { return await refresh; }
  finally { if (refreshes.get(deps.database) === refresh) refreshes.delete(deps.database); }
}

async function refreshAttachedTrackerIssuesOnce(deps: RefreshAttachedTrackerIssuesDeps): Promise<{ refreshed: number; failed: number }> {
  if (!deps.jira.isConfigured()) return { refreshed: 0, failed: 0 };
  const groups = groupBy(
    deps.database.listWorkItemMeta().filter((meta) => meta.metaType === 'tracker-item' && meta.provider === 'jira' && meta.externalId),
    (meta) => {
      const key = parsePayload(meta)?.key;
      return isNonEmptyString(key) ? key : meta.externalId!;
    },
  );

  let refreshed = 0;
  let failed = 0;
  for (const [lookup, metas] of groups) {
    try {
      const latest = await deps.jira.refreshIssue(lookup);
      if (!latest) continue;
      const payload = { ...latest, descriptionText: truncateText(latest.descriptionText, DESCRIPTION_MAX_LENGTH) };
      for (const meta of metas) {
        // May have been explicitly detached while the provider request was pending.
        if (deps.database.updateWorkItemMetaPayload(meta.id, payload)) refreshed += 1;
      }
    } catch (error) {
      failed += metas.length;
      deps.logger.warn({ err: error, lookup }, 'Failed to refresh attached Jira issue');
    }
  }
  if (refreshed > 0 || failed > 0) deps.logger.info({ refreshed, failed }, 'Refreshed attached tracker issues');
  return { refreshed, failed };
}

function parsePayload(meta: WorkItemMeta): { key?: string } | null {
  return safeParse<{ key?: string }>(meta.payloadJson);
}
