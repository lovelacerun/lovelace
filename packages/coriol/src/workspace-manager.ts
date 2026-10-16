import { existsSync, mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { probeTreeClone } from '@openclaw/fs-safe/copy';
import pLimit, { type LimitFunction } from 'p-limit';
import { createWorktree, ensureClone, refreshSeed, removeWorktree, resolveBaseRef } from './git.js';
import { npmToolchain } from './npm-toolchain.js';
import { assertInside, validatePathSegment, validateRepository, validateRepositoryId } from './paths.js';
import { ToolchainManager } from './toolchain-manager.js';
import type {
  CreateWorkspaceRequest,
  ManagedRepository,
  PreparedRepositoryWorkspace,
  RemoveRepositoryWorkspaceRequest,
  RepositoryDescriptor,
  WorkspaceManagerCapabilities,
  WorkspaceManagerEvent,
  WorkspaceManagerOptions,
} from './types.js';

const DEFAULT_CONCURRENCY = 3;

export class WorkspaceManager {
  readonly root: string;
  readonly repositoriesDirectory: string;
  readonly workspacesDirectory: string;
  readonly #toolchains: ToolchainManager;
  /** Manager-wide bound on concurrent clone, fetch, worktree and toolchain work. */
  readonly #limit: LimitFunction;
  readonly #repositoryLocks = new Map<string, Promise<unknown>>();

  constructor(options: WorkspaceManagerOptions) {
    this.root = resolve(options.root);
    this.repositoriesDirectory = join(this.root, 'repos');
    this.workspacesDirectory = join(this.root, 'workspaces');
    const toolchainStateDirectory = join(this.root, 'toolchains');
    this.#toolchains = new ToolchainManager(
      toolchainStateDirectory,
      options.toolchains ?? [npmToolchain()],
      options.logger ?? {},
    );
    this.#limit = pLimit(options.concurrency ?? DEFAULT_CONCURRENCY);

    mkdirSync(this.repositoriesDirectory, { recursive: true });
    mkdirSync(this.workspacesDirectory, { recursive: true });
    mkdirSync(toolchainStateDirectory, { recursive: true });
  }

  repositoryPath(repositoryId: string): string {
    return join(this.repositoriesDirectory, ...validateRepositoryId(repositoryId));
  }

  capabilities(): WorkspaceManagerCapabilities {
    const backend = probeTreeClone(this.workspacesDirectory);
    return {
      copyOnWrite: {
        available: backend !== undefined,
        backend: backend ?? null,
      },
    };
  }

  async refreshRepository(
    repository: RepositoryDescriptor,
    onEvent?: (event: WorkspaceManagerEvent) => void,
  ): Promise<ManagedRepository> {
    validateRepository(repository);
    return await this.#schedule(repository.id, async () => await this.#refreshRepository(repository, onEvent));
  }

  /** Prepares one repository worktree below `workspaces/<workspaceId>/`. Calls may run concurrently. */
  async createWorkspace(request: CreateWorkspaceRequest): Promise<PreparedRepositoryWorkspace> {
    validateRepository(request.repository);
    if (!request.branchName.trim()) throw new Error('branchName is required');
    const { workspaceId, onEvent } = request;
    const path = join(
      this.workspacesDirectory,
      validatePathSegment(workspaceId, 'workspace id'),
      validatePathSegment(request.directoryName ?? basename(request.repository.id), 'workspace repository directory'),
    );
    const remoteBranch = request.mode === 'existing' ? request.remoteBranch ?? null : null;
    if (request.mode === 'existing' && !remoteBranch) throw new Error('remoteBranch is required for an existing workspace');

    return await this.#schedule(request.repository.id, async () => {
      const repository = await this.#refreshRepository(request.repository, onEvent, workspaceId);
      const baseBranch = request.baseBranch ?? repository.defaultBranch;
      const warmStates = await this.#toolchains.prepareSeed(repository, workspaceId, onEvent);

      onEvent?.({ type: 'workspace.creating', repositoryId: repository.id, workspaceId, path });
      await createWorktree({
        repositoryPath: repository.path,
        workspacePath: path,
        branchName: request.branchName,
        targetRef: remoteBranch ? `origin/${remoteBranch}` : await resolveBaseRef(repository.path, baseBranch, repository.defaultBranch),
      });

      const preparations = await this.#toolchains.prepareWorkspace(repository, workspaceId, path, warmStates, onEvent);
      return { repository, workspaceId, path, branchName: request.branchName, baseBranch, remoteBranch, preparations };
    });
  }

  async removeRepositoryWorkspace(request: RemoveRepositoryWorkspaceRequest): Promise<void> {
    assertInside(this.workspacesDirectory, request.workspacePath, 'workspace path');
    await this.#schedule(request.repositoryId, async () => {
      if (existsSync(request.workspacePath)) {
        await removeWorktree(this.repositoryPath(request.repositoryId), request.workspacePath);
      }
    });
  }

  /** Clones on demand, then fetches and resets the seed to its latest default branch. */
  async #refreshRepository(
    descriptor: RepositoryDescriptor,
    onEvent?: (event: WorkspaceManagerEvent) => void,
    workspaceId?: string,
  ): Promise<ManagedRepository & { defaultBranch: string }> {
    const path = this.repositoryPath(descriptor.id);
    if (!existsSync(path)) onEvent?.({ type: 'repository.cloning', repositoryId: descriptor.id, path });
    const clone = await ensureClone(descriptor.cloneUrl, path);
    const defaultBranch = descriptor.defaultBranch ?? clone.defaultBranch;
    if (!defaultBranch) throw new Error(`Could not determine the default branch for ${descriptor.id}`);
    onEvent?.({ type: 'repository.fetching', repositoryId: descriptor.id, workspaceId, path: clone.path });
    await refreshSeed(clone.path, defaultBranch);
    return { ...descriptor, defaultBranch, path: clone.path };
  }

  /**
   * Serializes work on one seed clone (fetch/reset, worktree add/remove and seed
   * toolchain state must not interleave), then waits for a manager-wide slot.
   * The lock is taken before the slot so queued same-seed work never occupies
   * a slot while it waits.
   */
  async #schedule<T>(repositoryId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#repositoryLocks.get(repositoryId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.#limit(task));
    this.#repositoryLocks.set(repositoryId, next);
    try {
      return await next;
    } finally {
      if (this.#repositoryLocks.get(repositoryId) === next) this.#repositoryLocks.delete(repositoryId);
    }
  }
}
