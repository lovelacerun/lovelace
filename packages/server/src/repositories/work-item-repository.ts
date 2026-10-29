import { randomUUID } from 'node:crypto';
import type { CreateManualWorkItemInput, WorkItem, WorkItemAttachment, WorkItemDetails } from '@lovelace/core';
import { toLaunch, type DatabaseState, type NewAttachment } from '../database.js';

/** An attachment to add to a work item that is not created yet. */
export type PendingAttachment = NewAttachment extends infer A ? A extends NewAttachment ? Omit<A, 'workItemId'> : never : never;

export function getWorkItemDetails(database: DatabaseState, id: string): WorkItemDetails | null {
  const workItem = database.getWorkItem(id);
  if (!workItem) return null;
  return { workItem, attachments: database.listAttachments(id), launches: database.listLaunches(id).map(toLaunch) };
}

export function createManualWorkItem(database: DatabaseState, input: CreateManualWorkItemInput): WorkItem {
  return createActiveWorkItem(database, { ...input, attachments: [] });
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

export function createActiveWorkItem(
  database: DatabaseState,
  input: { title: string; notes?: string | null; attachments: PendingAttachment[] },
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

  database.transaction(() => {
    database.createWorkItem(workItem);
    database.addAttachments(input.attachments.map((attachment) => ({ ...attachment, workItemId: workItem.id }) as NewAttachment));
  });
  return workItem;
}

export function addAttachments(database: DatabaseState, workItemId: string, attachments: PendingAttachment[]): WorkItemAttachment[] {
  const created = database.addAttachments(attachments.map((attachment) => ({ ...attachment, workItemId }) as NewAttachment));
  database.touchWorkItem(workItemId);
  return created;
}
