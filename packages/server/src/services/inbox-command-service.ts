import type { StartWorkSource, WorkItem } from '@lovelace/core';
import type { DatabaseState } from '../database.js';
import { createActiveWorkItem, type PendingAttachment } from '../repositories/work-item-repository.js';

export type ActivateInboxInput =
  | { sourceType: 'work-item'; id: string }
  | { title: string; sources: StartWorkSource[] };

export type DismissInboxInput =
  | { sourceType: 'work-item'; id: string }
  | { sources: Array<Omit<StartWorkSource, 'payload'>> };

export function activateInboxItem(database: DatabaseState, input: ActivateInboxInput): WorkItem | null {
  if (isWorkItemActivateInput(input)) {
    return database.updateWorkItemState(input.id, 'active');
  }

  for (const source of input.sources) {
    database.deleteInboxMeta(source.sourceType, source.provider, source.externalId);
  }

  return createActiveWorkItem(database, {
    title: input.title,
    // Inbox sources carry the provider record the client listed.
    attachments: input.sources.map((source) => ({
      type: source.sourceType,
      provider: source.provider,
      externalId: source.externalId,
      payload: source.payload,
    }) as PendingAttachment),
  });
}

export function dismissInboxItem(database: DatabaseState, input: DismissInboxInput): WorkItem | { dismissed: number } | null {
  if (isWorkItemDismissInput(input)) {
    return database.updateWorkItemState(input.id, 'cancelled');
  }

  const now = new Date().toISOString();
  for (const source of input.sources) {
    database.upsertInboxMeta({ ...source, state: 'dismissed', createdAt: now, updatedAt: now });
  }

  return { dismissed: input.sources.length };
}

function isWorkItemActivateInput(value: ActivateInboxInput): value is Extract<ActivateInboxInput, { sourceType: 'work-item' }> {
  return 'sourceType' in value && value.sourceType === 'work-item';
}

function isWorkItemDismissInput(value: DismissInboxInput): value is Extract<DismissInboxInput, { sourceType: 'work-item' }> {
  return 'sourceType' in value && value.sourceType === 'work-item';
}
