import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { copyTree } from '@openclaw/fs-safe/copy';
import { assertInside, validatePathSegment } from './paths.js';
import type {
  ManagedRepository,
  ToolchainPreparation,
  WorkspaceManagerEvent,
  WorkspaceManagerLogger,
  WorkspaceToolchain,
} from './types.js';

interface WarmToolchainState {
  fingerprint: string;
  artifacts: string[];
  preparedAt: string;
}

export class ToolchainManager {
  constructor(
    readonly stateDirectory: string,
    readonly toolchains: WorkspaceToolchain[],
    readonly logger: WorkspaceManagerLogger,
  ) {}

  async prepareSeed(
    repository: ManagedRepository,
    workspaceId: string,
    onEvent?: (event: WorkspaceManagerEvent) => void,
  ): Promise<Map<string, WarmToolchainState>> {
    const states = new Map<string, WarmToolchainState>();
    for (const toolchain of this.toolchains) {
      const statePath = this.#seedStatePath(repository.id, toolchain.id);
      try {
        if (!(await toolchain.detect(repository.path))) continue;
        const fingerprint = await toolchain.fingerprint(repository.path);
        if (!fingerprint) continue;
        const marker = await this.#readState(statePath);
        if (await this.#validState(toolchain, repository.path, fingerprint, marker)) {
          states.set(toolchain.id, marker!);
          continue;
        }
        // npm ci may remove the previous installation before failing. Never leave its old marker valid.
        await rm(statePath, { force: true });
        onEvent?.({ type: 'seed.preparing', repositoryId: repository.id, workspaceId, path: repository.path, toolchain: toolchain.id, command: toolchain.command });
        this.logger.info?.({ repositoryId: repository.id, toolchain: toolchain.id }, 'Preparing repository seed');
        await toolchain.prepare(repository.path);
        const state = await this.#preparedState(toolchain, repository.path, fingerprint);
        if (state) {
          await this.#writeState(statePath, state);
          states.set(toolchain.id, state);
        }
      } catch (error) {
        this.logger.warn?.({ error, repositoryId: repository.id, toolchain: toolchain.id }, 'Could not prepare repository seed; the workspace will be initialized directly');
      }
    }
    return states;
  }

  async prepareWorkspace(
    repository: ManagedRepository,
    workspaceId: string,
    workspacePath: string,
    warmStates: Map<string, WarmToolchainState>,
    onEvent?: (event: WorkspaceManagerEvent) => void,
  ): Promise<ToolchainPreparation[]> {
    const preparations: ToolchainPreparation[] = [];
    for (const toolchain of this.toolchains) {
      if (!(await toolchain.detect(workspacePath))) continue;
      const fingerprint = await toolchain.fingerprint(workspacePath);
      const statePath = this.#workspaceStatePath(workspacePath, toolchain.id);
      const previous = await this.#readState(statePath);
      if (await this.#validState(toolchain, workspacePath, fingerprint, previous)) {
        preparations.push({ toolchain: toolchain.id, command: toolchain.command, strategy: 'reuse', preparedAt: previous!.preparedAt });
        continue;
      }
      await rm(statePath, { force: true });
      const warmState = warmStates.get(toolchain.id);
      let strategy: 'reflink' | 'install' = 'install';
      if (fingerprint && warmState?.fingerprint === fingerprint && warmState.artifacts.length > 0 &&
          await this.#materializeArtifacts(repository, workspaceId, workspacePath, toolchain, warmState.artifacts, onEvent)) {
        strategy = 'reflink';
      } else {
        onEvent?.({ type: 'workspace.preparing', repositoryId: repository.id, workspaceId, path: workspacePath, toolchain: toolchain.id, command: toolchain.command });
        await toolchain.prepare(workspacePath);
      }
      const state = await this.#preparedState(toolchain, workspacePath, fingerprint);
      const preparedAt = state?.preparedAt ?? new Date().toISOString();
      if (state) await this.#writeState(statePath, state);
      preparations.push({ toolchain: toolchain.id, command: toolchain.command, strategy, preparedAt });
    }
    return preparations;
  }

  async #validState(toolchain: WorkspaceToolchain, path: string, fingerprint: string | null, marker: WarmToolchainState | null): Promise<boolean> {
    if (!fingerprint || marker?.fingerprint !== fingerprint) return false;
    return marker.artifacts.every(artifact => {
      const target = join(path, artifact);
      assertInside(path, target, 'artifact path');
      return existsSync(target);
    }) && await toolchain.validate(path);
  }

  async #preparedState(toolchain: WorkspaceToolchain, path: string, fingerprint: string | null): Promise<WarmToolchainState | null> {
    if (!(await toolchain.validate(path))) throw new Error(`${toolchain.id} installation does not match the lockfile at ${path}`);
    if (await toolchain.fingerprint(path) !== fingerprint) throw new Error(`Toolchain inputs changed during preparation at ${path}; retry preparation`);
    if (!fingerprint) return null;
    return { fingerprint, artifacts: await toolchain.artifacts(path), preparedAt: new Date().toISOString() };
  }

  async #materializeArtifacts(
    repository: ManagedRepository,
    workspaceId: string,
    workspacePath: string,
    toolchain: WorkspaceToolchain,
    artifacts: string[],
    onEvent?: (event: WorkspaceManagerEvent) => void,
  ): Promise<boolean> {
    const paths = artifacts.map(artifact => {
      const source = join(repository.path, artifact);
      const destination = join(workspacePath, artifact);
      assertInside(repository.path, source, 'artifact source');
      assertInside(workspacePath, destination, 'artifact destination');
      return { source, destination };
    });
    try {
      for (const { source, destination } of paths) {
        onEvent?.({ type: 'artifact.materializing', repositoryId: repository.id, workspaceId, path: destination, toolchain: toolchain.id });
        await mkdir(dirname(destination), { recursive: true });
        await copyTree(source, destination, { clone: 'always' });
      }
      if (!(await toolchain.validate(workspacePath))) throw new Error('Materialized dependencies do not match the lockfile');
      return true;
    } catch (error) {
      this.logger.warn?.({ error, repositoryId: repository.id, toolchain: toolchain.id }, 'Copy-on-write artifact materialization unavailable; initializing the workspace directly');
      for (const { destination } of paths) await rm(destination, { recursive: true, force: true });
      return false;
    }
  }

  async #readState(path: string): Promise<WarmToolchainState | null> {
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as Partial<WarmToolchainState>;
      return typeof value.fingerprint === 'string' && Array.isArray(value.artifacts) && value.artifacts.every(entry => typeof entry === 'string') && typeof value.preparedAt === 'string'
        ? value as WarmToolchainState : null;
    } catch { return null; }
  }

  async #writeState(path: string, state: WarmToolchainState): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
  }

  #seedStatePath(repositoryId: string, toolchainId: string): string {
    return join(this.stateDirectory, validatePathSegment(toolchainId, 'toolchain id'), `${createHash('sha256').update(repositoryId).digest('hex')}.json`);
  }

  #workspaceStatePath(path: string, toolchainId: string): string {
    return join(this.stateDirectory, 'workspaces', createHash('sha256').update(path).digest('hex'), `${validatePathSegment(toolchainId, 'toolchain id')}.json`);
  }
}
