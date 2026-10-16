import { randomUUID } from 'node:crypto';
import { isToolLaunchOptionsById } from '@lovelace/core';
import safeParse from '@nkzw/core/safeParse.js';
import type { StartWorkLaunchInput, ToolLaunchDraftPayload, WorkItemMeta } from '@lovelace/core';
import type { DatabaseState } from '../database.js';
import { addWorkItemMetas } from '../repositories/work-item-repository.js';

/** Persists the exact launch intent before any slow or fallible launch step. */
export function saveToolLaunchDraft(
  database: DatabaseState,
  workItemId: string,
  input: StartWorkLaunchInput,
  requestId: string,
): WorkItemMeta {
  const now = new Date().toISOString();
  const payload: ToolLaunchDraftPayload = {
    revision: randomUUID(),
    requestId,
    toolIds: [...input.toolIds],
    toolOptions: input.toolOptions,
    repoIds: input.repoIds ? [...input.repoIds] : null,
    promptId: input.promptId ?? null,
    prompt: input.prompt ?? null,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  return addWorkItemMetas(database, workItemId, [{
    metaType: 'prompt-draft',
    provider: 'lovelace',
    externalId: `launch:${requestId}`,
    payload,
  }])[0]!;
}

export function markToolLaunchDraftLaunched(database: DatabaseState, draft: WorkItemMeta): WorkItemMeta | null {
  const current = database.listWorkItemMeta(draft.workItemId).find((meta) => meta.id === draft.id);
  if (!current) return null;
  const payload = parseToolLaunchDraft(current.payloadJson);
  const captured = parseToolLaunchDraft(draft.payloadJson);
  if (!payload || !captured) return null;
  // A replaced prompt is a new revision that stays pending.
  if (payload.revision !== captured.revision) return current;
  return database.updateWorkItemMetaPayload(draft.id, {
    ...payload,
    status: 'launched',
    updatedAt: new Date().toISOString(),
  } satisfies ToolLaunchDraftPayload);
}

function parseToolLaunchDraft(payloadJson: string | null): ToolLaunchDraftPayload | null {
  const value = safeParse<Partial<ToolLaunchDraftPayload>>(payloadJson);
  if (!Array.isArray(value?.toolIds) || !value.toolIds.every((entry) => typeof entry === 'string')) return null;
  if (typeof value.revision !== 'string' || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') return null;
  return {
    revision: value.revision,
    requestId: typeof value.requestId === 'string' ? value.requestId : undefined,
    toolIds: value.toolIds,
    toolOptions: isToolLaunchOptionsById(value.toolOptions) ? value.toolOptions : undefined,
    repoIds: Array.isArray(value.repoIds) && value.repoIds.every((entry) => typeof entry === 'string') ? value.repoIds : null,
    promptId: typeof value.promptId === 'string' ? value.promptId : null,
    prompt: typeof value.prompt === 'string' ? value.prompt : null,
    status: value.status === 'launched' ? 'launched' : 'pending',
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}
