import { randomUUID } from 'node:crypto';
import type { Attachment, StartWorkLaunchInput, ToolLaunchDraftPayload } from '@lovelace/core';
import type { DatabaseState } from '../database.js';
import { addAttachments } from '../repositories/work-item-repository.js';

/** Persists the exact launch intent before any slow or fallible launch step. */
export function saveToolLaunchDraft(
  database: DatabaseState,
  workItemId: string,
  input: StartWorkLaunchInput,
  requestId: string,
): Attachment<'prompt-draft'> {
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
  return addAttachments(database, workItemId, [{ type: 'prompt-draft', payload }])[0] as Attachment<'prompt-draft'>;
}

export function markToolLaunchDraftLaunched(database: DatabaseState, draft: Attachment<'prompt-draft'>): Attachment<'prompt-draft'> | null {
  const current = database.getAttachment('prompt-draft', draft.id);
  if (!current) return null;
  // A replaced prompt is a new revision that stays pending.
  if (current.payload.revision !== draft.payload.revision) return current;
  return database.updateAttachment('prompt-draft', draft.id, {
    ...current.payload,
    status: 'launched',
    updatedAt: new Date().toISOString(),
  });
}
