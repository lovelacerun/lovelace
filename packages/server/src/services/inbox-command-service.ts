import type { InboxSourceType, WorkItem } from '@lovelace/core';
import type { DatabaseState } from '../database.js';
import { createActiveWorkItemFromMetas } from '../repositories/work-item-repository.js';

export interface InboxActionSource {
  sourceType: InboxSourceType;
  provider: string;
  externalId: string;
  payload?: unknown;
}

export type ActivateInboxInput =
  | { sourceType: 'work-item'; id: string }
  | { title: string; sources: InboxActionSource[] };

export type DismissInboxInput =
  | { sourceType: 'work-item'; id: string }
  | { sources: Array<Pick<InboxActionSource, 'sourceType' | 'provider' | 'externalId'>> };

export function activateInboxItem(database: DatabaseState, input: ActivateInboxInput): WorkItem | null {
  if (isWorkItemActivateInput(input)) {
    return database.updateWorkItemState(input.id, 'active');
  }

  for (const source of input.sources) {
    database.deleteInboxMeta(source.sourceType, source.provider, source.externalId);
  }

  return createActiveWorkItemFromMetas(database, {
    title: input.title,
    metas: input.sources.map((source) => ({
      metaType: source.sourceType,
      provider: source.provider,
      externalId: source.externalId,
      payload: source.payload ?? null,
    })),
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
