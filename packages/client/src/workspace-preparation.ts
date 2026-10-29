import { attachmentsOfType, matchesRepositorySelection, repositorySelectionKey, type Worktree, type StartWorkRepositoryInput, type WorkItemDetails } from '@lovelace/core';
import { errorStatus, isTimeout, type LovelaceClient, type RequestContext } from './client.js';

export interface PrepareRepositoriesOptions {
  signal?: AbortSignal;
  context?: RequestContext;
  /** Each HTTP call is bounded separately; preparation itself has no fixed deadline. */
  pollIntervalMs?: number;
  onProgress?: (workspaces: Worktree[]) => void;
}

/** A lost reply or cancelled wait is not a workspace preparation failure. */
export class WorkspacePreparationWaitError extends Error {
  constructor(workItemId: string, lastKnown: Worktree[], cause: unknown) {
    const state = lastKnown.length
      ? lastKnown.map(workspace => `${workspace.repoName}: ${workspace.status}`).join(', ')
      : 'unknown (the submission may have reached the server)';
    const reason = isTimeout(cause) ? 'Timed out waiting' : 'Stopped waiting';
    super(`${reason} for workspace preparation; server preparation was not cancelled. Last observed state: ${state}. Inspect progress: lovelace work-items workspaces ${workItemId}`, { cause });
    this.name = 'WorkspacePreparationWaitError';
  }
}

export async function prepareRepositories(
  client: LovelaceClient,
  workItemId: string,
  repositories: StartWorkRepositoryInput[],
  options: PrepareRepositoriesOptions = {},
): Promise<WorkItemDetails> {
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) throw new RangeError('pollIntervalMs must be positive');
  const selections = new Map(repositories.map(repository => [repositorySelectionKey(repository), repository]));
  let lastKnown: Worktree[] = [];
  const selected = (details: WorkItemDetails) => {
    const workspaces = attachmentsOfType(details.attachments, 'worktree');
    // Match the server's selected workspace, then poll its stable attachment identity.
    return [...selections.values()].flatMap(repository => {
      const workspace = workspaces.find(entry => matchesRepositorySelection(repository, entry.payload));
      return workspace ? [workspace] : [];
    });
  };
  try {
    // Submit once. Retries are deliberate caller actions, never transport retries.
    const request = { signal: options.signal, context: options.context };
    let details: WorkItemDetails = await client.workItems.addRepositories.mutate({ id: workItemId, repositories, wait: false }, request);
    const worktreeIds = selected(details).map(entry => entry.id);
    if (worktreeIds.length !== selections.size) throw new Error('Server did not record every selected repository');
    while (true) {
      const workspaces = attachmentsOfType(details.attachments, 'worktree').filter(entry => worktreeIds.includes(entry.id));
      if (workspaces.length !== worktreeIds.length) throw new Error('Workspace preparation records are missing');
      lastKnown = workspaces.map(entry => entry.payload);
      options.onProgress?.(lastKnown);
      // Partial failures are returned as data, preserving the automation contract.
      if (lastKnown.every(workspace => workspace.status === 'ready' || workspace.status === 'failed')) return details;
      await pause(pollIntervalMs, options.signal);
      details = await client.workItems.get.query({ id: workItemId }, request);
    }
  } catch (error) {
    if (errorStatus(error) > 0 && !options.signal?.aborted) throw error;
    // A bounded read can disambiguate a lost submission reply without resubmitting.
    if (!options.signal?.aborted) {
      try { lastKnown = selected(await client.workItems.get.query({ id: workItemId }, { signal: options.signal, context: options.context })).map(entry => entry.payload); } catch { /* Retain last observation. */ }
    }
    throw new WorkspacePreparationWaitError(workItemId, lastKnown, error);
  }
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
