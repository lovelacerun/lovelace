import type { WorkItem } from '@lovelace/core';
import type { DatabaseState } from '../database.js';
import { addAttachments } from '../repositories/work-item-repository.js';
import type { HerdrClient } from './herdr-client.js';

/** Workspace token naming the owning work item. Herdr forgets tokens on restart; Lovelace re-reports them. */
const WORK_ITEM_TOKEN = 'lovelace';

interface LaunchPane { workspaceId: string; tabId: string; paneId: string }
const workspaceQueues = new WeakMap<DatabaseState, Map<string, Promise<unknown>>>();

/**
 * Returns a fresh shell pane in the work item's Herdr workspace. The workspace
 * ID is recorded on the work item; a workspace another owner tagged, or one
 * the user closed, is replaced by a new one.
 */
export function openLaunchPane(database: DatabaseState, herdr: HerdrClient, workItem: WorkItem, input: { cwd: string; label: string }): Promise<LaunchPane> {
  return serialize(database, workItem.id, () => openLaunchPaneUnlocked(database, herdr, workItem, input));
}

/** Relabels the work item's recorded Herdr workspace after its title changed; a closed or foreign workspace is left alone. */
export function renameWorkItemWorkspace(database: DatabaseState, herdr: HerdrClient, workItemId: string): Promise<void> {
  return serialize(database, workItemId, async () => {
    const workItem = database.getWorkItem(workItemId);
    const attachment = database.listAttachmentsOfType('herdr-workspace', workItemId)[0];
    if (!workItem || !attachment) return;
    const recorded = await herdr.getWorkspace(attachment.payload.workspaceId);
    const owner = recorded?.tokens[WORK_ITEM_TOKEN];
    if (!recorded || (owner !== undefined && owner !== workItemId)) return;
    await herdr.renameWorkspace(recorded.workspaceId, workspaceLabel(workItem));
  });
}

/** Serializes workspace changes per work item; independent work items and agent starts stay concurrent. */
async function serialize<T>(database: DatabaseState, workItemId: string, run: () => Promise<T>): Promise<T> {
  let queues = workspaceQueues.get(database);
  if (!queues) { queues = new Map(); workspaceQueues.set(database, queues); }
  const previous = queues.get(workItemId);
  const task = (previous ?? Promise.resolve()).catch(() => undefined).then(run);
  queues.set(workItemId, task);
  try { return await task; }
  finally { if (queues.get(workItemId) === task) queues.delete(workItemId); }
}

async function openLaunchPaneUnlocked(database: DatabaseState, herdr: HerdrClient, workItem: WorkItem, input: { cwd: string; label: string }): Promise<LaunchPane> {
  const attachment = database.listAttachmentsOfType('herdr-workspace', workItem.id)[0];
  const recorded = attachment ? await herdr.getWorkspace(attachment.payload.workspaceId) : null;
  const owner = recorded?.tokens[WORK_ITEM_TOKEN];
  if (recorded && (owner === undefined || owner === workItem.id)) {
    if (owner === undefined) await herdr.reportWorkspaceTokens(recorded.workspaceId, { [WORK_ITEM_TOKEN]: workItem.id });
    const tab = await herdr.createTab({ workspaceId: recorded.workspaceId, ...input });
    return { workspaceId: recorded.workspaceId, ...tab };
  }
  // The new workspace's root shell hosts this launch; no extra tab.
  const created = await herdr.createWorkspace({ cwd: input.cwd, label: workspaceLabel(database.getWorkItem(workItem.id) ?? workItem) });
  await herdr.reportWorkspaceTokens(created.workspaceId, { [WORK_ITEM_TOKEN]: workItem.id });
  database.transaction(() => {
    if (attachment) database.deleteAttachment('herdr-workspace', attachment.id);
    addAttachments(database, workItem.id, [{ type: 'herdr-workspace', payload: { workspaceId: created.workspaceId } }]);
  });
  return created;
}

function workspaceLabel(workItem: WorkItem): string {
  const title = workItem.title.replace(/\s+/g, ' ').trim() || 'Lovelace work';
  return title.length > 48 ? `${title.slice(0, 47)}…` : title;
}
