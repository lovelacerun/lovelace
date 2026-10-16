import type { RepositoryWorkspaceMetaPayload, StartWorkRepositoryInput } from './types.js';

/** Identifies one requested worktree; a repository can carry several branches (e.g. stacked diffs). */
export function repositorySelectionKey(input: StartWorkRepositoryInput): string {
  return JSON.stringify([input.repoId, input.sourceExternalId ?? null, input.branchName?.trim() || null]);
}

/** Without a requested branch, any existing worktree of the repository and source satisfies the selection. */
export function matchesRepositorySelection(input: StartWorkRepositoryInput, workspace: RepositoryWorkspaceMetaPayload): boolean {
  const branchName = input.branchName?.trim();
  return workspace.status !== 'cleaned' && workspace.repoId === input.repoId &&
    (workspace.sourceExternalId ?? null) === (input.sourceExternalId ?? null) &&
    (!branchName || workspace.branchName === branchName);
}
