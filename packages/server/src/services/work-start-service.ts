import { existsSync, rmdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { WorkspaceManager, WorkspaceManagerEvent } from '@lovelace/coriol';
import {
  matchesRepositorySelection,
  repositorySelectionKey,
  type RepositoryWorkspaceMetaPayload,
  type StartWorkRepositoryInput,
  type StartWorkSource,
  type WorkspaceMode,
  type WorkItemDetails,
} from '@lovelace/core';
import type { GitHubClient } from '@lovelace/github-client';
import type { DatabaseState } from '../database.js';
import { isNonEmptyString, isRecord, managedRepositoryId, metaSources, repositoryWorkspaces, slugify } from '../helpers.js';
import { emitActivity } from './activity-bus.js';
import { ensureTaskWorkspacePath, deriveTaskLabel } from './task-workspace-service.js';
import { addWorkItemMetas, getWorkItemDetails } from '../repositories/work-item-repository.js';

const WORKTREE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
type PreparationResult = { outcome: 'prepared' | 'reused' | 'failed'; payload: RepositoryWorkspaceMetaPayload };
const inFlight = new WeakMap<DatabaseState, Map<string, Promise<PreparationResult>>>();

interface WorkspaceActivityLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

interface WorkStartDeps {
  database: DatabaseState;
  github: GitHubClient;
  logger: WorkspaceActivityLogger;
  workspaceManager: WorkspaceManager;
}

export async function attachRepositoriesToExistingWorkItem(
  deps: WorkStartDeps,
  workItemId: string,
  repositories: StartWorkRepositoryInput[],
): Promise<WorkItemDetails | null> {
  const operation = beginRepositoryPreparation(deps, workItemId, repositories);
  if (!operation) return null;
  await operation.completion;
  return getWorkItemDetails(deps.database, workItemId);
}

/** Registers durable repository state before any asynchronous preparation side effect. */
export function beginRepositoryPreparation(
  deps: WorkStartDeps,
  workItemId: string,
  repositories: StartWorkRepositoryInput[],
): { details: WorkItemDetails; completion: Promise<void> } | null {
  const details = getWorkItemDetails(deps.database, workItemId);
  if (!details) return null;
  const completion = attachRepositoriesToWorkItem(deps, workItemId, details.workItem.title, repositories, metaSources(details.metas));
  return { details: getWorkItemDetails(deps.database, workItemId)!, completion };
}

/** A server restart ends its preparations, not their work items or worktrees. */
export function recoverInterruptedRepositoryPreparations(database: DatabaseState): void {
  for (const { meta, payload } of repositoryWorkspaces(database.listWorkItemMeta())) {
    if ((payload.status === 'pending' || payload.status === 'preparing') && !inFlight.get(database)?.has(meta.id)) {
      database.updateWorkItemMetaPayload(meta.id, {
        ...payload, status: 'failed', errorMessage: 'Workspace preparation interrupted by server restart; retry workspace creation.',
      });
    }
  }
}

export async function cleanupManagedWorktrees(deps: WorkStartDeps): Promise<{ cleaned: number }> {
  const workItems = deps.database.listWorkItems().filter((workItem) => {
    if (workItem.state !== 'done' && workItem.state !== 'cancelled') return false;
    const completedAt = workItem.completedAt ?? workItem.updatedAt;
    return Date.now() - new Date(completedAt).getTime() >= WORKTREE_RETENTION_MS;
  });

  const pending = workItems.flatMap((workItem) => {
    const metas = repositoryWorkspaces(deps.database.listWorkItemMeta(workItem.id)).filter(({ payload }) => payload.status === 'ready' || payload.status === 'failed');
    return metas.length > 0 ? [{ workItem, metas }] : [];
  });

  if (pending.length === 0) return { cleaned: 0 };

  deps.logger.info({ workItemCount: pending.length }, 'Cleaning managed worktrees for completed work items');

  let cleaned = 0;
  for (const { workItem, metas } of pending) {
    for (const { meta, payload } of metas) {
      const repository = deps.database.listRepos().find((entry) => entry.id === payload.repoId);
      if (existsSync(payload.worktreePath) && !repository) {
        deps.logger.warn({ workItemId: workItem.id, repoId: payload.repoId, worktreePath: payload.worktreePath }, 'Cannot remove managed workspace because its repository record is missing');
        continue;
      }
      if (existsSync(payload.worktreePath) && repository) {
        try {
          deps.logger.info({ workItemId: workItem.id, repoPath: payload.repoPath, worktreePath: payload.worktreePath }, 'Removing managed workspace');
          await deps.workspaceManager.removeRepositoryWorkspace({
            repositoryId: managedRepositoryId(repository),
            workspacePath: payload.worktreePath,
          });
        } catch (error) {
          // Leave the meta pending so the next cleanup run retries instead of orphaning the worktree.
          deps.logger.warn({ err: error, workItemId: workItem.id, worktreePath: payload.worktreePath }, 'Failed to remove managed worktree, will retry on next run');
          continue;
        }
      }

      const updatedPayload: RepositoryWorkspaceMetaPayload = {
        ...payload,
        status: 'cleaned',
        cleanedAt: new Date().toISOString(),
      };
      deps.database.updateWorkItemMetaPayload(meta.id, updatedPayload);
      cleaned += 1;
      removeTaskDirIfEmpty(deps, payload.worktreePath);
    }
  }

  return { cleaned };
}

function removeTaskDirIfEmpty(deps: WorkStartDeps, worktreePath: string) {
  const taskDir = dirname(worktreePath);
  const parent = dirname(taskDir);
  if (parent !== deps.workspaceManager.workspacesDirectory) return;
  try {
    rmdirSync(taskDir);
  } catch {
    // Not empty (or already gone) — leave it.
  }
}

function attachRepositoriesToWorkItem(
  deps: WorkStartDeps,
  workItemId: string,
  workItemTitle: string,
  repositories: StartWorkRepositoryInput[],
  sources: StartWorkSource[],
): Promise<void> {
  const repoRecords = deps.database.listRepos();
  // Validate the entire batch before recording or starting any repository.
  for (const repository of repositories) {
    if (!repoRecords.some(record => record.id === repository.repoId)) throw new Error(`Unknown repository: ${repository.repoId}`);
  }
  deps.logger.info({ workItemId, repositoryCount: repositories.length }, 'Preparing repository workspaces');
  const taskDir = ensureTaskWorkspacePath(deps.workspaceManager.workspacesDirectory, workItemId, sources, workItemTitle);
  const workspaceId = basename(taskDir);
  const existingWorkspaces = repositoryWorkspaces(deps.database.listWorkItemMeta(workItemId)).filter(({ payload }) => payload.status !== 'cleaned');
  const reservedNames = new Set(existingWorkspaces.map(entry => basename(entry.payload.worktreePath)));
  let pending = inFlight.get(deps.database);
  if (!pending) { pending = new Map(); inFlight.set(deps.database, pending); }

  // Source- and branch-specific worktrees remain distinct. Duplicate selections and
  // overlapping batches join the same meta/operation before Coriol is called.
  const selected = new Map(repositories.map(repository => [repositorySelectionKey(repository), repository]));
  const tasks = [...selected.values()].map(repository => {
    const record = repoRecords.find(record => record.id === repository.repoId)!;
    const managerId = managedRepositoryId(record);
    const repo = { ...record, managerId, path: deps.workspaceManager.repositoryPath(managerId) };
    const existing = existingWorkspaces.find(entry => matchesRepositorySelection(repository, entry.payload));
    const current = existing ? pending.get(existing.meta.id) : undefined;
    if (current) return current;
    if (existing?.payload.status === 'ready' && existsSync(existing.payload.worktreePath)) {
      deps.logger.info({ workItemId, repoId: repo.id, worktreePath: existing.payload.worktreePath }, 'Reusing prepared repository workspace');
      emitActivity({ type: 'workspace.reused', workItemId, repoName: repo.name, message: `Reusing prepared workspace for ${repo.name}` });
      return Promise.resolve({ outcome: 'reused' as const, payload: existing.payload });
    }

    const workspaceMode = resolveWorkspaceMode(repository, sources);
    const worktreePath = existing?.payload.worktreePath ?? buildUniqueWorktreePath(taskDir, repo.name, repository, reservedNames);
    const initialPayload = repositoryWorkspacePayload(repo, repository, workspaceMode, {
      worktreePath, status: 'pending',
      branchName: repository.branchName?.trim() || (workspaceMode === 'fresh' ? deriveFreshBranchName(workItemId, sources, repo.name) : null),
    });
    const meta = existing?.meta ?? addWorkItemMetas(deps.database, workItemId, [{
      metaType: 'repository', provider: repo.provider, externalId: `${repo.id}:${worktreePath}`, payload: initialPayload,
    }])[0]!;
    if (existing) deps.database.updateWorkItemMetaPayload(meta.id, initialPayload);

    // Deferring execution ensures the in-flight entry and every pending meta
    // exist before provider calls, fetches or dependency installs can begin.
    const task = Promise.resolve().then(async (): Promise<PreparationResult> => {
      deps.logger.info({ workItemId, repoId: repo.id, repoPath: repo.path, workspaceMode, worktreePath }, 'Preparing repository workspace');
      emitActivity({ type: 'workspace.preparing', workItemId, repoName: repo.name, message: `Preparing workspace for ${repo.name}` });
      let payload: RepositoryWorkspaceMetaPayload;
      let outcome: 'prepared' | 'failed';
      try {
        payload = await prepareRepositoryWorkspace({
          deps, repo, worktreePath, workItemId, workspaceMode, repository, sources, workspaceId, metaId: meta.id,
        });
        outcome = 'prepared';
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.logger.error({ err: error, workItemId, repoId: repo.id, worktreePath }, 'Failed to prepare repository workspace');
        payload = { ...initialPayload, status: 'failed', errorMessage: message };
        outcome = 'failed';
      }
      // Commit each result independently: a slow sibling must not hide it.
      deps.database.updateWorkItemMetaPayload(meta.id, payload);
      emitActivity({
        type: outcome === 'prepared' ? 'workspace.ready' : 'workspace.failed',
        workItemId, repoName: repo.name,
        message: outcome === 'prepared' ? `Workspace ready for ${repo.name}` : `Workspace failed for ${repo.name}: ${payload.errorMessage}`,
      });
      return { outcome, payload };
    }).finally(() => { if (pending!.get(meta.id) === task) pending!.delete(meta.id); });
    pending.set(meta.id, task);
    return task;
  });

  // Coriol still bounds concurrency and serializes each seed; cache reuse is
  // unchanged. Coalescing here prevents repeat preparation of the same worktree.
  return Promise.all(tasks).then(results => {
    const failed = results.filter(result => result.outcome === 'failed');
    emitActivity({
      type: failed.length ? 'work-item.start-partial' : 'work-item.started', workItemId,
      message: failed.length ? `${workItemTitle}: ${failed.length} of ${results.length} workspaces failed`
        : `${workItemTitle}: all ${results.length} workspaces ready`,
    });
    deps.logger.info({
      workItemId, preparedRepositoryCount: results.filter(result => result.outcome === 'prepared').length,
      reusedRepositoryCount: results.filter(result => result.outcome === 'reused').length,
      failedRepositoryCount: failed.length,
    }, 'Attached repository workspaces to work item');
  });
}

async function prepareRepositoryWorkspace(input: {
  deps: WorkStartDeps;
  repo: { id: string; name: string; fullName: string; managerId: string; path: string; defaultBranch: string | null; cloneUrl: string };
  workspaceId: string;
  worktreePath: string;
  workItemId: string;
  metaId: string;
  workspaceMode: WorkspaceMode;
  repository: StartWorkRepositoryInput;
  sources: StartWorkSource[];
}): Promise<RepositoryWorkspaceMetaPayload> {
  const { deps, repo, workspaceMode, repository, sources } = input;
  const updateProgress = (preparationStep: string) => {
    const meta = deps.database.listWorkItemMeta(input.workItemId).find(meta => meta.id === input.metaId)!;
    const payload = JSON.parse(meta.payloadJson!) as RepositoryWorkspaceMetaPayload;
    deps.database.updateWorkItemMetaPayload(input.metaId, {
      ...payload, status: 'preparing', preparationStep,
    });
  };
  if (workspaceMode === 'change-request') updateProgress('Resolving review source');
  const preparedAt = new Date().toISOString();
  const reviewSource = workspaceMode === 'change-request'
    ? await resolveReviewSource(deps.github, repo, repository, sources)
    : null;
  const baseBranch = reviewSource?.baseBranch ?? (repository.baseBranch?.trim() || repo.defaultBranch);
  const branchName = reviewSource
    ? deriveChangeRequestBranchName(reviewSource.remoteBranch, input.workItemId, repo.name)
    : repository.branchName?.trim() || deriveFreshBranchName(input.workItemId, sources, repo.name);
  const remoteBranch = reviewSource?.remoteBranch ?? null;

  deps.logger.info(
    { workItemId: input.workItemId, repoId: repo.id, mode: workspaceMode, branchName, remoteBranch, baseBranch, worktreePath: input.worktreePath },
    'Creating branched workspace with Coriol',
  );
  const workspace = await deps.workspaceManager.createWorkspace({
    workspaceId: input.workspaceId,
    repository: {
      id: repo.managerId,
      cloneUrl: repo.cloneUrl,
      defaultBranch: repo.defaultBranch,
    },
    directoryName: basename(input.worktreePath),
    mode: reviewSource ? 'existing' : 'fresh',
    branchName,
    remoteBranch,
    baseBranch,
    onEvent: (event) => {
      updateProgress(event.command ? `${event.type}: ${event.command}` : event.type);
      reportWorkspaceManagerEvent(deps, input.workItemId, repo.id, repo.name, event);
    },
  });

  const npmPreparation = workspace.preparations.find((preparation) => preparation.toolchain === 'npm') ?? null;
  return repositoryWorkspacePayload(repo, repository, workspaceMode, {
    worktreePath: workspace.path,
    branchName: workspace.branchName,
    baseBranch: workspace.baseBranch,
    remoteBranch: workspace.remoteBranch,
    sourceExternalId: reviewSource?.source.externalId ?? repository.sourceExternalId ?? null,
    installCommand: npmPreparation?.command ?? null,
    installedAt: npmPreparation?.preparedAt ?? null,
    dependenciesReused: npmPreparation?.strategy === 'reflink',
    status: 'ready',
    preparedAt,
  });
}

function reportWorkspaceManagerEvent(
  deps: WorkStartDeps,
  workItemId: string,
  repoId: string,
  repoName: string,
  event: WorkspaceManagerEvent,
): void {
  deps.logger.info({ workItemId, repoId, event }, 'Coriol workspace progress');
  if (event.type !== 'seed.preparing' && event.type !== 'workspace.preparing') return;
  const command = event.command ?? event.toolchain ?? 'workspace setup';
  emitActivity({
    type: 'workspace.installing',
    workItemId,
    repoName,
    message: event.type === 'seed.preparing'
      ? `Warming ${repoName} with ${command}`
      : `Running ${command} in ${basename(event.path)}`,
  });
}

/** Defaults describe a workspace that was never prepared; `details` fills in what is known. */
function repositoryWorkspacePayload(
  repo: { id: string; name: string; path: string },
  repository: StartWorkRepositoryInput,
  workspaceMode: WorkspaceMode,
  details: Partial<RepositoryWorkspaceMetaPayload> & Pick<RepositoryWorkspaceMetaPayload, 'worktreePath' | 'status'>,
): RepositoryWorkspaceMetaPayload {
  return {
    repoId: repo.id,
    repoName: repo.name,
    repoPath: repo.path,
    role: repository.role ?? 'primary',
    workspaceMode,
    branchName: null,
    baseBranch: null,
    remoteBranch: null,
    sourceExternalId: repository.sourceExternalId ?? null,
    installCommand: null,
    installedAt: null,
    dependenciesReused: false,
    cleanedAt: null,
    preparedAt: new Date().toISOString(),
    ...details,
  };
}

function resolveWorkspaceMode(repository: StartWorkRepositoryInput, sources: StartWorkSource[]): WorkspaceMode {
  if (repository.workspaceMode) return repository.workspaceMode;
  const source = repository.sourceExternalId
    ? sources.find((entry) => entry.externalId === repository.sourceExternalId)
    : null;
  return source?.sourceType === 'change-request' ? 'change-request' : 'fresh';
}

async function resolveReviewSource(
  github: GitHubClient,
  repo: { id: string; name: string; fullName: string; path: string; defaultBranch: string | null; cloneUrl: string },
  repository: StartWorkRepositoryInput,
  sources: StartWorkSource[],
) {
  const source = repository.sourceExternalId
    ? sources.find((entry) => entry.externalId === repository.sourceExternalId && entry.sourceType === 'change-request')
    : sources.find((entry) => entry.sourceType === 'change-request' && matchesRepository(repo, entry));
  if (!source) {
    throw new Error(`Could not resolve review source for repository ${repo.name}`);
  }

  const payload = parseSourcePayload(source.payload);
  const fetchedBranch = payload.headRefName && payload.baseRefName ? null : await fetchPullRequestBranch(github, payload.repoFullName, payload.number);
  const remoteBranch = payload.headRefName ?? fetchedBranch?.headRefName ?? null;
  const baseBranch = payload.baseRefName ?? fetchedBranch?.baseRefName ?? null;
  if (!remoteBranch) {
    throw new Error(`Could not resolve remote branch for change request ${source.externalId}`);
  }

  return {
    source,
    remoteBranch,
    baseBranch: baseBranch ?? repo.defaultBranch,
  };
}

async function fetchPullRequestBranch(github: GitHubClient, repoFullName: string | null, number: number | null) {
  if (!repoFullName || number === null) return { headRefName: null, baseRefName: null };
  const details = await github.fetchPullRequestDetails(repoFullName, number);
  return {
    headRefName: details?.headRefName ?? null,
    baseRefName: details?.baseRefName ?? null,
  };
}

function matchesRepository(
  repo: { name: string; fullName: string },
  source: Pick<StartWorkSource, 'payload'>,
): boolean {
  const payload = parseSourcePayload(source.payload);
  if (!payload.repoFullName) return false;
  return repo.fullName.toLowerCase() === payload.repoFullName.toLowerCase();
}

function parseSourcePayload(payload: unknown): { repoFullName: string | null; number: number | null; headRefName: string | null; baseRefName: string | null } {
  if (!isRecord(payload)) {
    return { repoFullName: null, number: null, headRefName: null, baseRefName: null };
  }

  return {
    repoFullName: isNonEmptyString(payload.repoFullName) ? payload.repoFullName.trim() : null,
    number: typeof payload.number === 'number' ? payload.number : null,
    headRefName: isNonEmptyString(payload.headRefName) ? payload.headRefName.trim() : null,
    baseRefName: isNonEmptyString(payload.baseRefName) ? payload.baseRefName.trim() : null,
  };
}

function buildUniqueWorktreePath(taskDir: string, repoName: string, repository: StartWorkRepositoryInput, reservedNames: Set<string>): string {
  const suffixSeed = repository.sourceExternalId ?? repository.branchName ?? '';
  const baseName = [slugify(repoName), slugify(suffixSeed)].filter(Boolean).join('-') || 'repo';
  let candidate = baseName;
  let counter = 2;

  while (reservedNames.has(candidate)) {
    candidate = `${baseName}-${counter}`;
    counter += 1;
  }

  reservedNames.add(candidate);
  return join(taskDir, candidate);
}

function deriveFreshBranchName(workItemId: string, sources: StartWorkSource[], repoName: string): string {
  const taskLabel = deriveTaskLabel(sources, repoName);
  return `lovelace/${slugify(taskLabel || repoName)}-${workItemId.slice(0, 8)}`;
}

function deriveChangeRequestBranchName(remoteBranch: string, workItemId: string, repoName: string): string {
  return `review/${slugify(remoteBranch || repoName)}-${workItemId.slice(0, 8)}`;
}
