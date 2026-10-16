export interface RepositoryDescriptor {
  /** Stable identifier used for the managed clone path. */
  id: string;
  cloneUrl: string;
  defaultBranch?: string | null;
}

export interface ManagedRepository extends RepositoryDescriptor {
  path: string;
}

export type WorkspaceMode = 'fresh' | 'existing';

export interface CreateWorkspaceRequest {
  /** Workspace directory below `workspaces/`. It must be one safe path segment. */
  workspaceId: string;
  repository: RepositoryDescriptor;
  /** Directory name below the workspace. Defaults to the repository id's final segment. */
  directoryName?: string;
  branchName: string;
  mode?: WorkspaceMode;
  baseBranch?: string | null;
  remoteBranch?: string | null;
  onEvent?: (event: WorkspaceManagerEvent) => void;
}

export interface ToolchainPreparation {
  toolchain: string;
  command: string;
  strategy: 'reflink' | 'install';
  preparedAt: string;
}

export interface PreparedRepositoryWorkspace {
  repository: ManagedRepository;
  workspaceId: string;
  path: string;
  branchName: string;
  baseBranch: string;
  remoteBranch: string | null;
  preparations: ToolchainPreparation[];
}

export interface RemoveRepositoryWorkspaceRequest {
  repositoryId: string;
  workspacePath: string;
}

export interface WorkspaceManagerCapabilities {
  copyOnWrite: {
    available: boolean;
    backend: string | null;
  };
}

export interface WorkspaceManagerEvent {
  type:
    | 'repository.cloning'
    | 'repository.fetching'
    | 'seed.preparing'
    | 'workspace.creating'
    | 'artifact.materializing'
    | 'workspace.preparing';
  repositoryId: string;
  workspaceId?: string;
  path: string;
  toolchain?: string;
  command?: string;
}

export interface WorkspaceManagerLogger {
  debug?(...args: unknown[]): void;
  info?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
}

export interface WorkspaceToolchain {
  readonly id: string;
  readonly command: string;
  detect(path: string): Promise<boolean>;
  fingerprint(path: string): Promise<string | null>;
  prepare(path: string): Promise<void>;
  artifacts(path: string): Promise<string[]>;
}

export interface WorkspaceManagerOptions {
  root: string;
  logger?: WorkspaceManagerLogger;
  toolchains?: WorkspaceToolchain[];
  /** Manager-wide limit for concurrent repository preparation. Defaults to 3. */
  concurrency?: number;
}
