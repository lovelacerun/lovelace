import type { Attachment, JiraIssueSummary } from '@lovelace/core';
import type { DatabaseState } from '../database.js';
import type { CachedJira } from '../cached-providers.js';
import groupBy from '@nkzw/core/groupBy.js';
import { isNonEmptyString, truncateText } from '../helpers.js';
import { addAttachments } from '../repositories/work-item-repository.js';

interface JiraIssueRef {
  /** Issue key ("PROJ-123") or numeric Jira issue id. */
  key: string;
}

const ISSUE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const ISSUE_ID_PATTERN = /^\d+$/;
/** A title led by an issue key, as Jira-started work is titled (`PROJ-1: Title`). */
const KEYED_TITLE_PATTERN = /^[A-Z][A-Z0-9]+-\d+(?::\s*|\s+[-–—]\s+|\s+)\S/;
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
): Promise<Attachment<'tracker-item'> | null> {
  if (!database.getWorkItem(workItemId)) return null;
  if (!jira.isConfigured()) throw new Error('Jira is not configured');
  const issue = await jira.fetchIssue(ref.key);
  if (!issue) throw new Error(`Jira issue not found: ${ref.key}`);
  database.deleteInboxMeta('tracker-item', 'jira', issue.id);
  return database.transaction(() => {
    const attachment = upsertTrackerItem(database, workItemId, issue);
    keyWorkItemTitle(database, workItemId);
    return attachment;
  });
}

/** Detaches by the attachment's external id (Jira issue id) or by issue key. */
export function detachJiraIssueFromWorkItem(database: DatabaseState, workItemId: string, idOrKey: string): boolean {
  if (!database.getWorkItem(workItemId)) return false;
  const needle = idOrKey.trim();
  const detached = jiraIssues(database, workItemId)
    .filter((attachment) => attachment.externalId === needle || attachment.payload.key?.toUpperCase() === needle.toUpperCase());
  if (detached.length === 0) return true;
  database.transaction(() => {
    const keys = detached.map((attachment) => attachment.payload.key).filter(isNonEmptyString);
    database.deleteLinkAttachments(workItemId, 'tracker-item', 'jira', detached.map((attachment) => attachment.externalId));
    database.touchWorkItem(workItemId);
    const title = database.getWorkItem(workItemId)!.title;
    const key = keys.find((entry) => title.startsWith(`${entry}: `));
    if (key) database.updateWorkItem(workItemId, { title: title.slice(key.length + 2).trim() || title });
    keyWorkItemTitle(database, workItemId);
  });
  return true;
}

/** Leads an unkeyed title with the first attached Jira issue key, as Jira-started work is titled. */
function keyWorkItemTitle(database: DatabaseState, workItemId: string): void {
  const title = database.getWorkItem(workItemId)?.title;
  if (!title || KEYED_TITLE_PATTERN.test(title)) return;
  const key = jiraIssues(database, workItemId)
    .map((attachment) => attachment.payload.key)
    .find(isNonEmptyString);
  if (key) database.updateWorkItem(workItemId, { title: `${key}: ${title}` });
}

function jiraIssues(database: DatabaseState, workItemId?: string): Array<Attachment<'tracker-item'>> {
  return database.listAttachmentsOfType('tracker-item', workItemId).filter((attachment) => attachment.provider === 'jira');
}

function upsertTrackerItem(database: DatabaseState, workItemId: string, issue: JiraIssueSummary): Attachment<'tracker-item'> {
  const payload: JiraIssueSummary = {
    ...issue,
    descriptionText: truncateText(issue.descriptionText, DESCRIPTION_MAX_LENGTH),
  };
  const current = jiraIssues(database, workItemId).find((attachment) => attachment.externalId === issue.id);
  if (current) {
    const updated = database.updateAttachment('tracker-item', current.id, payload);
    database.touchWorkItem(workItemId);
    return updated ?? current;
  }
  return addAttachments(database, workItemId, [{ type: 'tracker-item', provider: 'jira', externalId: issue.id, payload }])[0] as Attachment<'tracker-item'>;
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
    jiraIssues(deps.database),
    (attachment) => isNonEmptyString(attachment.payload.key) ? attachment.payload.key : attachment.externalId,
  );

  let refreshed = 0;
  let failed = 0;
  for (const [lookup, attachments] of groups) {
    try {
      const latest = await deps.jira.refreshIssue(lookup);
      if (!latest) continue;
      const payload = { ...latest, descriptionText: truncateText(latest.descriptionText, DESCRIPTION_MAX_LENGTH) };
      for (const attachment of attachments) {
        // May have been explicitly detached while the provider request was pending.
        if (deps.database.updateAttachment('tracker-item', attachment.id, payload)) refreshed += 1;
      }
    } catch (error) {
      failed += attachments.length;
      deps.logger.warn({ err: error, lookup }, 'Failed to refresh attached Jira issue');
    }
  }
  if (refreshed > 0 || failed > 0) deps.logger.info({ refreshed, failed }, 'Refreshed attached tracker issues');
  return { refreshed, failed };
}
