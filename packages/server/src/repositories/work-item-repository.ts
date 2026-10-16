import { randomUUID } from 'node:crypto';
import type { CreateManualWorkItemInput, WorkItem, WorkItemDetails, WorkItemMeta } from '@lovelace/core';
import type { DatabaseState } from '../database.js';
import { launchOperationSummary } from './launch-operation-repository.js';

export function getWorkItemDetails(database: DatabaseState, id: string): WorkItemDetails | null {
  const workItem = database.getWorkItem(id);
  if (!workItem) return null;
  const launchOperations = database.listLaunchOperations(id).map(launchOperationSummary);
  return {
    workItem,
    metas: database.listWorkItemMeta(id),
    ...(launchOperations.length ? { launchOperations } : {}),
  };
}

export function createManualWorkItem(database: DatabaseState, input: CreateManualWorkItemInput): WorkItem {
  return createActiveWorkItemFromMetas(database, { ...input, metas: [] });
}

export function updateWorkItem(
  database: DatabaseState,
  id: string,
  input: { title?: string; notes?: string | null },
): WorkItem | null {
  return database.updateWorkItem(id, {
    title: input.title?.trim(),
    notes: input.notes === undefined ? undefined : input.notes?.trim() || null,
  });
}

export function createActiveWorkItemFromMetas(
  database: DatabaseState,
  input: {
    title: string;
    notes?: string | null;
    metas: Array<{
      metaType: WorkItemMeta['metaType'];
      provider: string | null;
      externalId: string | null;
      payload: unknown;
    }>;
  },
): WorkItem {
  const now = new Date().toISOString();
  const workItem: WorkItem = {
    id: randomUUID(),
    title: input.title.trim(),
    state: 'active',
    notes: input.notes?.trim() || null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: null,
  };

  database.createWorkItem(workItem);
  database.createWorkItemMetas(
    input.metas.map((meta) =>
      buildWorkItemMeta({
        workItemId: workItem.id,
        metaType: meta.metaType,
        provider: meta.provider,
        externalId: meta.externalId,
        payload: meta.payload,
      }),
    ),
  );

  return workItem;
}

export function addWorkItemMetas(
  database: DatabaseState,
  workItemId: string,
  metas: Array<{
    metaType: WorkItemMeta['metaType'];
    provider: string | null;
    externalId: string | null;
    payload: unknown;
  }>,
): WorkItemMeta[] {
  const created = database.createWorkItemMetas(
    metas.map((meta) =>
      buildWorkItemMeta({
        workItemId,
        metaType: meta.metaType,
        provider: meta.provider,
        externalId: meta.externalId,
        payload: meta.payload,
      }),
    ),
  );
  database.touchWorkItem(workItemId);
  return created;
}

function buildWorkItemMeta(input: {
  workItemId: string;
  metaType: WorkItemMeta['metaType'];
  provider: string | null;
  externalId: string | null;
  payload: unknown;
}): WorkItemMeta {
  const now = new Date().toISOString();

  return {
    id: randomUUID(),
    workItemId: input.workItemId,
    metaType: input.metaType,
    provider: input.provider,
    externalId: input.externalId,
    payloadJson: JSON.stringify(input.payload),
    createdAt: now,
    updatedAt: now,
  };
}
