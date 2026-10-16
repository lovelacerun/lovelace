import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  readonly #stateDirectory: string;
  readonly #logger: WorkspaceManagerLogger;
  readonly #toolchains: WorkspaceToolchain[];

  constructor(stateDirectory: string, toolchains: WorkspaceToolchain[], logger: WorkspaceManagerLogger) {
    this.#stateDirectory = stateDirectory;
    this.#toolchains = toolchains;
    this.#logger = logger;
  }

  async prepareSeed(
    repository: ManagedRepository,
    workspaceId: string,
    onEvent?: (event: WorkspaceManagerEvent) => void,
  ): Promise<Map<string, WarmToolchainState>> {
    const states = new Map<string, WarmToolchainState>();
    for (const toolchain of this.#toolchains) {
      if (!(await toolchain.detect(repository.path))) continue;
      const fingerprint = await toolchain.fingerprint(repository.path);
      if (!fingerprint) continue;
      const marker = await this.#readState(repository.id, toolchain.id);
      if (
        marker?.fingerprint === fingerprint &&
        marker.artifacts.length > 0 &&
        marker.artifacts.every((artifact) => existsSync(join(repository.path, artifact)))
      ) {
        states.set(toolchain.id, marker);
        continue;
      }

      emit(onEvent, {
        type: 'seed.preparing',
        repositoryId: repository.id,
        workspaceId,
        path: repository.path,
        toolchain: toolchain.id,
        command: toolchain.command,
      });
      this.#logger.info?.({ repositoryId: repository.id, toolchain: toolchain.id }, 'Preparing repository seed');
      try {
        await toolchain.prepare(repository.path);
        const state = {
          fingerprint,
          artifacts: await toolchain.artifacts(repository.path),
          preparedAt: new Date().toISOString(),
        };
        await this.#writeState(repository.id, toolchain.id, state);
        states.set(toolchain.id, state);
      } catch (error) {
        this.#logger.warn?.(
          { error, repositoryId: repository.id, toolchain: toolchain.id },
          'Could not prepare repository seed; the workspace will be initialized directly',
        );
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
    for (const toolchain of this.#toolchains) {
      if (!(await toolchain.detect(workspacePath))) continue;
      const targetFingerprint = await toolchain.fingerprint(workspacePath);
      const warmState = warmStates.get(toolchain.id);

      if (targetFingerprint && warmState?.fingerprint === targetFingerprint && warmState.artifacts.length > 0) {
        const materialized = await this.#materializeArtifacts(
          repository,
          workspaceId,
          workspacePath,
          toolchain,
          warmState.artifacts,
          onEvent,
        );
        if (materialized) {
          preparations.push({
            toolchain: toolchain.id,
            command: toolchain.command,
            strategy: 'reflink',
            preparedAt: new Date().toISOString(),
          });
          continue;
        }
      }

      emit(onEvent, {
        type: 'workspace.preparing',
        repositoryId: repository.id,
        workspaceId,
        path: workspacePath,
        toolchain: toolchain.id,
        command: toolchain.command,
      });
      await toolchain.prepare(workspacePath);
      preparations.push({
        toolchain: toolchain.id,
        command: toolchain.command,
        strategy: 'install',
        preparedAt: new Date().toISOString(),
      });
    }
    return preparations;
  }

  async #materializeArtifacts(
    repository: ManagedRepository,
    workspaceId: string,
    workspacePath: string,
    toolchain: WorkspaceToolchain,
    artifacts: string[],
    onEvent?: (event: WorkspaceManagerEvent) => void,
  ): Promise<boolean> {
    try {
      for (const artifact of artifacts) {
        const source = join(repository.path, artifact);
        const destination = join(workspacePath, artifact);
        assertInside(repository.path, source, 'artifact source');
        assertInside(workspacePath, destination, 'artifact destination');
        emit(onEvent, {
          type: 'artifact.materializing',
          repositoryId: repository.id,
          workspaceId,
          path: destination,
          toolchain: toolchain.id,
        });
        await copyTree(source, destination, { clone: 'always' });
      }
      return true;
    } catch (error) {
      this.#logger.warn?.(
        { error, repositoryId: repository.id, toolchain: toolchain.id },
        'Copy-on-write artifact materialization unavailable; initializing the workspace directly',
      );
      for (const artifact of artifacts) {
        await rm(join(workspacePath, artifact), { recursive: true, force: true });
      }
      return false;
    }
  }

  async #readState(repositoryId: string, toolchainId: string): Promise<WarmToolchainState | null> {
    try {
      const value = JSON.parse(await readFile(this.#statePath(repositoryId, toolchainId), 'utf8')) as Partial<WarmToolchainState>;
      return typeof value.fingerprint === 'string' &&
        Array.isArray(value.artifacts) && value.artifacts.every((entry) => typeof entry === 'string') &&
        typeof value.preparedAt === 'string'
        ? value as WarmToolchainState
        : null;
    } catch {
      return null;
    }
  }

  async #writeState(repositoryId: string, toolchainId: string, state: WarmToolchainState): Promise<void> {
    const path = this.#statePath(repositoryId, toolchainId);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
  }

  #statePath(repositoryId: string, toolchainId: string): string {
    const repositoryKey = createHash('sha256').update(repositoryId).digest('hex');
    return join(this.#stateDirectory, validatePathSegment(toolchainId, 'toolchain id'), `${repositoryKey}.json`);
  }
}

function emit(listener: ((event: WorkspaceManagerEvent) => void) | undefined, event: WorkspaceManagerEvent): void {
  listener?.(event);
}
