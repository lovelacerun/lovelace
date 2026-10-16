import { matchesRepositorySelection, repositorySelectionKey, type RepositoryWorkspaceMetaPayload, type StartWorkRepositoryInput, type WorkItemDetails } from '@lovelace/core';
import { ApiError, type LovelaceClient, type RequestOptions } from './client.js';

export interface PrepareRepositoriesOptions extends RequestOptions {
  /** Each HTTP call is bounded separately; preparation itself has no fixed deadline. */
  pollIntervalMs?: number;
  onProgress?: (workspaces: RepositoryWorkspaceMetaPayload[]) => void;
}

/** A lost reply or cancelled wait is not a workspace preparation failure. */
export class WorkspacePreparationWaitError extends Error {
  constructor(workItemId: string, lastKnown: RepositoryWorkspaceMetaPayload[], cause: unknown) {
    const state = lastKnown.length
      ? lastKnown.map(workspace => `${workspace.repoName}: ${workspace.status}`).join(', ')
      : 'unknown (the submission may have reached the server)';
    const reason = cause instanceof DOMException && cause.name === 'TimeoutError' ? 'Timed out waiting' : 'Stopped waiting';
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
  let lastKnown: RepositoryWorkspaceMetaPayload[] = [];
  const selected = (details: WorkItemDetails) => {
    const workspaces = details.metas.flatMap(meta => meta.metaType === 'repository' && meta.payloadJson
      ? [{ id: meta.id, payload: JSON.parse(meta.payloadJson) as RepositoryWorkspaceMetaPayload }] : []);
    // Match the server's selected workspace, then poll its stable meta identity.
    return [...selections.values()].flatMap(repository => {
      const workspace = workspaces.find(entry => matchesRepositorySelection(repository, entry.payload));
      return workspace ? [workspace] : [];
    });
  };
  try {
    // Submit once. Retries are deliberate caller actions, never transport retries.
    let details = await client.requestJson<WorkItemDetails>(`/work-items/${encodeURIComponent(workItemId)}/repositories`, {
      method: 'POST', body: JSON.stringify({ repositories, wait: false }),
    }, options);
    const metaIds = selected(details).map(entry => entry.id);
    if (metaIds.length !== selections.size) throw new Error('Server did not record every selected repository');
    while (true) {
      const workspaces = details.metas.flatMap(meta => metaIds.includes(meta.id) && meta.payloadJson
        ? [{ id: meta.id, payload: JSON.parse(meta.payloadJson) as RepositoryWorkspaceMetaPayload }] : []);
      if (workspaces.length !== metaIds.length) throw new Error('Workspace preparation records are missing');
      lastKnown = workspaces.map(entry => entry.payload);
      options.onProgress?.(lastKnown);
      // Partial failures are returned as data, preserving the automation contract.
      if (lastKnown.every(workspace => workspace.status === 'ready' || workspace.status === 'failed')) return details;
      await pause(pollIntervalMs, options.signal);
      details = await client.getWorkItem(workItemId, options);
    }
  } catch (error) {
    if (error instanceof ApiError && error.status > 0 && !options.signal?.aborted) throw error;
    // A bounded read can disambiguate a lost submission reply without resubmitting.
    if (!options.signal?.aborted) {
      try { lastKnown = selected(await client.getWorkItem(workItemId, options)).map(entry => entry.payload); } catch { /* Retain last observation. */ }
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
