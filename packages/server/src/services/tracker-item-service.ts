import type { Attachment, TrackerIssue } from '@lovelace/core';
import type { DatabaseState } from '../database.js';
import type { CachedTracker } from '../cached-providers.js';
import groupBy from '@nkzw/core/groupBy.js';
import { isNonEmptyString, truncateText } from '../helpers.js';
import { addAttachments } from '../repositories/work-item-repository.js';

/** A title led by an issue key, as tracker-started work is titled (`PROJ-1: Title`). */
const KEYED_TITLE_PATTERN = /^[A-Z][A-Z0-9]+-\d+(?::\s*|\s+[-–—]\s+|\s+)\S/;
const DESCRIPTION_MAX_LENGTH = 4000;

type IssueTracker = Pick<CachedTracker, 'provider' | 'name' | 'isConfigured' | 'fetchIssue'>;

/** `ref` is an issue ID or key. */
export async function attachTrackerIssueToWorkItem(
  database: DatabaseState,
  tracker: IssueTracker,
  workItemId: string,
  ref: string,
): Promise<Attachment<'tracker-item'> | null> {
  if (!database.getWorkItem(workItemId)) return null;
  if (!tracker.isConfigured()) throw new Error(`${tracker.name} is not configured`);
  const issue = await tracker.fetchIssue(ref);
  if (!issue) throw new Error(`${tracker.name} issue not found: ${ref}`);
  database.deleteInboxMeta('tracker-item', tracker.provider, issue.id);
  return database.transaction(() => {
    const attachment = upsertTrackerItem(database, tracker.provider, workItemId, issue);
    keyWorkItemTitle(database, workItemId);
    return attachment;
  });
}

/** Detaches by the tracker's issue ID or by issue key. */
export function detachTrackerIssueFromWorkItem(database: DatabaseState, workItemId: string, idOrKey: string): boolean {
  if (!database.getWorkItem(workItemId)) return false;
  const needle = idOrKey.trim();
  const detached = database.listAttachmentsOfType('tracker-item', workItemId)
    .filter((attachment) => attachment.externalId === needle || attachment.payload.key?.toUpperCase() === needle.toUpperCase());
  if (detached.length === 0) return true;
  database.transaction(() => {
    const keys = detached.map((attachment) => attachment.payload.key).filter(isNonEmptyString);
    for (const attachment of detached) database.deleteLinkAttachments(workItemId, 'tracker-item', attachment.provider, [attachment.externalId]);
    database.touchWorkItem(workItemId);
    const title = database.getWorkItem(workItemId)!.title;
    const key = keys.find((entry) => title.startsWith(`${entry}: `));
    if (key) database.updateWorkItem(workItemId, { title: title.slice(key.length + 2).trim() || title });
    keyWorkItemTitle(database, workItemId);
  });
  return true;
}

/** Leads an unkeyed title with the first attached issue key, as tracker-started work is titled. */
function keyWorkItemTitle(database: DatabaseState, workItemId: string): void {
  const title = database.getWorkItem(workItemId)?.title;
  if (!title || KEYED_TITLE_PATTERN.test(title)) return;
  const key = database.listAttachmentsOfType('tracker-item', workItemId)
    .map((attachment) => attachment.payload.key)
    .find(isNonEmptyString);
  if (key) database.updateWorkItem(workItemId, { title: `${key}: ${title}` });
}

function trackerIssues(database: DatabaseState, provider: string, workItemId?: string): Array<Attachment<'tracker-item'>> {
  return database.listAttachmentsOfType('tracker-item', workItemId).filter((attachment) => attachment.provider === provider);
}

function upsertTrackerItem(database: DatabaseState, provider: string, workItemId: string, issue: TrackerIssue): Attachment<'tracker-item'> {
  const payload = truncated(issue);
  const current = trackerIssues(database, provider, workItemId).find((attachment) => attachment.externalId === issue.id);
  if (current) {
    const updated = database.updateAttachment('tracker-item', current.id, payload);
    database.touchWorkItem(workItemId);
    return updated ?? current;
  }
  return addAttachments(database, workItemId, [{ type: 'tracker-item', provider, externalId: issue.id, payload }])[0] as Attachment<'tracker-item'>;
}

function truncated(issue: TrackerIssue): TrackerIssue {
  return { ...issue, description: truncateText(issue.description, DESCRIPTION_MAX_LENGTH) };
}

interface RefreshAttachedTrackerIssuesDeps {
  tracker: Pick<CachedTracker, 'provider' | 'isConfigured' | 'refreshIssue'>;
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
  if (!deps.tracker.isConfigured()) return { refreshed: 0, failed: 0 };
  const groups = groupBy(
    trackerIssues(deps.database, deps.tracker.provider),
    (attachment) => isNonEmptyString(attachment.payload.key) ? attachment.payload.key : attachment.externalId,
  );

  let refreshed = 0;
  let failed = 0;
  for (const [lookup, attachments] of groups) {
    try {
      const latest = await deps.tracker.refreshIssue(lookup);
      if (!latest) continue;
      const payload = truncated(latest);
      for (const attachment of attachments) {
        // May have been explicitly detached while the provider request was pending.
        if (deps.database.updateAttachment('tracker-item', attachment.id, payload)) refreshed += 1;
      }
    } catch (error) {
      failed += attachments.length;
      deps.logger.warn({ err: error, lookup }, 'Failed to refresh attached tracker issue');
    }
  }
  if (refreshed > 0 || failed > 0) deps.logger.info({ refreshed, failed }, 'Refreshed attached tracker issues');
  return { refreshed, failed };
}
