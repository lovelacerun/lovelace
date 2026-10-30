import type { Attachment, ChangeRequest, TrackedChangeRequest } from '@lovelace/core';
import type { DatabaseState } from '../database.js';
import type { CachedCodeHost } from '../cached-providers.js';
import { changeRequestId, type ChangeRequestRef } from '../providers/types.js';
import { addAttachments } from '../repositories/work-item-repository.js';

type ChangeRequestHost = Pick<CachedCodeHost, 'provider' | 'name' | 'fetchChangeRequest' | 'refreshChangeRequest'>;

export function parseChangeRequestRef(
  codeHost: Pick<CachedCodeHost, 'parseChangeRequestUrl'>,
  input: { url?: string; repository?: string; number?: number },
): ChangeRequestRef | null {
  if (input.repository && Number.isInteger(input.number) && input.number! > 0) {
    return { repository: input.repository, number: input.number! };
  }
  return input.url ? codeHost.parseChangeRequestUrl(input.url) : null;
}

export async function attachChangeRequestToWorkItem(
  database: DatabaseState,
  codeHost: ChangeRequestHost,
  workItemId: string,
  ref: ChangeRequestRef,
): Promise<Attachment<'pull-request'> | null> {
  if (!database.getWorkItem(workItemId)) return null;
  const changeRequest = await codeHost.fetchChangeRequest(ref);
  if (!changeRequest) throw new Error(`${codeHost.name} change request not found: ${changeRequestId(ref)}`);
  return upsertChangeRequest(database, codeHost.provider, workItemId, changeRequest);
}

export async function refreshChangeRequestsForWorkItem(
  database: DatabaseState,
  codeHost: ChangeRequestHost,
  workItemId: string,
): Promise<Array<Attachment<'pull-request'>> | null> {
  if (!database.getWorkItem(workItemId)) return null;
  const updated: Array<Attachment<'pull-request'>> = [];
  for (const attachment of trackedChangeRequests(database, codeHost.provider, workItemId)) {
    const changeRequest = await codeHost.refreshChangeRequest(attachment.payload);
    if (!changeRequest) continue;
    updated.push(upsertChangeRequest(database, codeHost.provider, workItemId, changeRequest, attachment));
  }
  return updated;
}

export function detachChangeRequestFromWorkItem(database: DatabaseState, workItemId: string, externalId: string): boolean {
  if (!database.getWorkItem(workItemId)) return false;
  for (const attachment of database.listAttachmentsOfType('pull-request', workItemId)) {
    if (attachment.externalId === externalId) database.deleteLinkAttachments(workItemId, 'pull-request', attachment.provider, [externalId]);
  }
  database.touchWorkItem(workItemId);
  return true;
}

export async function refreshOpenChangeRequests(
  database: DatabaseState,
  codeHost: ChangeRequestHost,
  logger: { warn: (obj: unknown, msg: string) => void },
) {
  const result = { attempted: 0, updated: 0, failed: 0 };
  for (const workItem of database.listWorkItems('active')) {
    for (const attachment of trackedChangeRequests(database, codeHost.provider, workItem.id)) {
      const { payload } = attachment;
      if (payload.status === 'closed' || payload.status === 'merged') continue;
      result.attempted += 1;
      try {
        const changeRequest = await codeHost.refreshChangeRequest(payload);
        if (changeRequest) {
          upsertChangeRequest(database, codeHost.provider, workItem.id, changeRequest, attachment);
          result.updated += 1;
        }
      } catch (error) {
        result.failed += 1;
        logger.warn({ err: error, workItemId: workItem.id, externalId: attachment.externalId }, 'Failed to refresh change request');
      }
    }
  }
  return result;
}

function trackedChangeRequests(database: DatabaseState, provider: string, workItemId: string): Array<Attachment<'pull-request'>> {
  return database.listAttachmentsOfType('pull-request', workItemId).filter((attachment) => attachment.provider === provider);
}

function upsertChangeRequest(
  database: DatabaseState,
  provider: string,
  workItemId: string,
  changeRequest: ChangeRequest,
  existing?: Attachment<'pull-request'>,
): Attachment<'pull-request'> {
  const now = new Date().toISOString();
  const current = existing ?? trackedChangeRequests(database, provider, workItemId).find((attachment) => attachment.externalId === changeRequest.id);
  const payload: TrackedChangeRequest = {
    ...changeRequest,
    attachedAt: current?.payload.attachedAt ?? now,
    lastSyncedAt: now,
    ...current?.payload.releaseChecks && { releaseChecks: current.payload.releaseChecks },
  };
  if (current) {
    const updated = database.updateAttachment('pull-request', current.id, payload);
    database.touchWorkItem(workItemId);
    return updated ?? current;
  }
  return addAttachments(database, workItemId, [{ type: 'pull-request', provider, externalId: changeRequest.id, payload }])[0] as Attachment<'pull-request'>;
}
