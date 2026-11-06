import type { HerdrConfig, HerdrPaneRef } from './herdr.js';
import type { SidebarSide } from './dashboard.js';
import type { CodingHarnessId, ToolLaunchOptions, ToolLaunchOptionsById } from './harnesses.js';
import type { LovelaceDirs } from './paths.js';

export const WORK_ITEM_STATES = ['active', 'done', 'cancelled'] as const;
export type WorkItemState = (typeof WORK_ITEM_STATES)[number];

export function isWorkItemState(value: string | undefined): value is WorkItemState {
  return Boolean(value && WORK_ITEM_STATES.includes(value as WorkItemState));
}

const WORKSPACE_MODES = ['fresh', 'change-request'] as const;
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

export function isWorkspaceMode(value: string | undefined): value is WorkspaceMode {
  return Boolean(value && WORKSPACE_MODES.includes(value as WorkspaceMode));
}

/** A repository in the code host's catalog. */
export interface Repository {
  /** `<provider>:<externalId>`. */
  id: string;
  provider: string;
  externalId: string;
  name: string;
  /** Owner and name, e.g. `org/service`. */
  fullName: string;
  cloneUrl: string;
  defaultBranch: string | null;
  isArchived: boolean;
  topics: string[];
  lastSyncedAt: string;
}

/** An issue in the issue tracker. */
export interface TrackerIssue {
  id: string;
  /** Human-readable key, e.g. `PROJ-123`. */
  key: string;
  title: string;
  url: string;
  project: string | null;
  status: string | null;
  /** The tracker considers the issue finished. */
  done: boolean;
  issueType: string | null;
  author: string | null;
  description: string | null;
  /** Upstream creation time, when available. */
  createdAt?: string | null;
  updatedAt: string;
}

export type ChangeRequestStatus = 'draft' | 'open' | 'approved' | 'changes-requested' | 'merged' | 'closed';
export type ChangeRequestReview = 'approved' | 'changes-requested' | 'required';
export type ChangeRequestBuild = 'pending' | 'success' | 'failure';

/** A pull or merge request on the code host. */
export interface ChangeRequest {
  /** `<repository>#<number>`. */
  id: string;
  /** Full name of the target repository. */
  repository: string;
  number: number;
  title: string;
  url: string;
  author: string | null;
  sourceBranch: string | null;
  targetBranch: string | null;
  status: ChangeRequestStatus;
  review: ChangeRequestReview | null;
  build: ChangeRequestBuild | null;
  /** Upstream creation time, when available. */
  createdAt?: string | null;
  updatedAt: string;
}

/** A change request attached to a work item; refreshed while open. */
export interface TrackedChangeRequest extends ChangeRequest {
  attachedAt: string;
  lastSyncedAt: string;
  /** Set by the release-checks plugin once the change request is merged. */
  releaseChecks?: ReleaseChecks;
}

export type ReleaseCheckState = 'done' | 'pending' | 'unknown';

/** One target a merged change request should reach, e.g. an environment. */
export interface ReleaseCheck {
  name: string;
  state: ReleaseCheckState;
  detail: string | null;
  url: string | null;
}

/** The plugin's last good answer; a failed run keeps it and only sets `error`. */
export interface ReleaseChecks {
  /** No further checks are needed. */
  complete: boolean;
  checks: ReleaseCheck[];
  checkedAt: string;
  error: string | null;
}

type InboxMetaState = 'dismissed';
export type InboxSourceType = 'tracker-item' | 'change-request';
type LovelaceLinkType = 'tracker-item';

export interface LovelaceLink {
  type: LovelaceLinkType;
  provider: string;
  externalId: string;
  key: string | null;
  url: string | null;
}

interface GitHubConfig {
  token?: string;
  org?: string;
  host?: string;
  apiBaseUrl?: string;
  /** GitHub CLI account whose login the server borrows when no token is configured. */
  account?: string;
  /** Initial editable Jira repository topic filter; [] means all topics. */
  repositoryTopics?: string[];
}

interface JiraConfig {
  baseUrl?: string;
  siteUrl?: string;
  email?: string;
  apiToken?: string;
}

/** A plugin is an executable that reads one JSON request on stdin and writes one JSON reply on stdout. */
export interface PluginCommand {
  /** Executable and its arguments; not run through a shell, but a leading `~/` is expanded. */
  command: string[];
  timeoutMs: number;
}

interface PluginsConfig {
  /** Reports how far merged change requests on active work items have been released. */
  releaseChecks?: PluginCommand;
}

export type TuiThemeMode = 'dark' | 'light';

/** The server's configuration; `loadServerConfig` fills every default. */
export interface ServerConfig extends LovelaceDirs {
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  syncIntervalMs: number;
  defaultAgent: CodingHarnessId;
  herdr?: HerdrConfig;
  github?: GitHubConfig;
  jira?: JiraConfig;
  plugins?: PluginsConfig;
  /** Set by the process that starts the server, never read from the file. */
  agentCli?: AgentCli;
  version?: string;
}

/** What clients read from the same file: the server's port and TUI appearance. */
export interface ClientSettings {
  port: number;
  /**
   * `icons`: Nerd Font glyphs, or plain Unicode for terminals without one.
   * `colors`: per-theme overrides of TUI colour tokens, `#rrggbb` or `none`.
   */
  tui: {
    sidebarSide: SidebarSide;
    icons: 'nerd' | 'unicode';
    theme: TuiThemeMode;
    colors: Partial<Record<TuiThemeMode, Record<string, string>>>;
  };
}

export interface AgentCli {
  /** Shell command prefix that runs the Lovelace CLI against this server. */
  command: string;
}

export interface WorkItem {
  id: string;
  title: string;
  state: WorkItemState;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface AttachmentOfType<Type extends string, Payload> {
  id: string;
  workItemId: string;
  type: Type;
  payload: Payload;
  createdAt: string;
  updatedAt: string;
}

/** Upstream records, identified by their provider's ID. */
export interface LinkAttachment<Type extends string, Payload> extends AttachmentOfType<Type, Payload> {
  provider: string;
  externalId: string;
}

/** Everything attached to a work item, discriminated by `type`. */
export type WorkItemAttachment =
  | LinkAttachment<'tracker-item', TrackerIssue>
  /** Review request the work item was started from. */
  | LinkAttachment<'change-request', ChangeRequest>
  | LinkAttachment<'pull-request', TrackedChangeRequest>
  | AttachmentOfType<'herdr-workspace', HerdrWorkspacePayload>
  | AttachmentOfType<'worktree', Worktree>
  | AttachmentOfType<'session', AgentSession>;

export type AttachmentType = WorkItemAttachment['type'];
export type Attachment<Type extends AttachmentType> = Extract<WorkItemAttachment, { type: Type }>;
export type LinkAttachmentType = Extract<WorkItemAttachment, { externalId: string }>['type'];

export interface InboxMeta {
  sourceType: InboxSourceType;
  provider: string | null;
  externalId: string;
  state: InboxMetaState;
  createdAt: string;
  updatedAt: string;
}

export interface CreateManualWorkItemInput {
  title: string;
  notes?: string;
}

export type LaunchState = 'accepted' | 'preparing' | 'starting' | 'started' | 'failed' | 'uncertain';

/** Launches the server is still working on. */
export function isLaunchInProgress(state: LaunchState): boolean {
  return state === 'accepted' || state === 'preparing' || state === 'starting';
}

/**
 * A launch request: the exact prompt and selections, identified by the
 * client's request ID. `failed` launches can be retried; `uncertain` ones were
 * interrupted by a restart and never are.
 */
export interface Launch {
  id: string;
  workItemId: string;
  state: LaunchState;
  error: string | null;
  harness: string;
  options?: ToolLaunchOptionsById;
  repoIds: string[];
  promptId: string | null;
  prompt: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkItemDetails {
  workItem: WorkItem;
  attachments: WorkItemAttachment[];
  /** Oldest first. */
  launches: Launch[];
}

export interface StartWorkSource {
  sourceType: InboxSourceType;
  provider: string;
  externalId: string;
  payload?: unknown;
}

export interface StartWorkRepositoryInput {
  repoId: string;
  role?: 'primary' | 'secondary';
  workspaceMode?: WorkspaceMode;
  sourceExternalId?: string | null;
  branchName?: string | null;
  /** Branch a fresh worktree starts from; defaults to the repository's default branch. */
  baseBranch?: string | null;
}

export interface StartWorkLaunchInput {
  toolIds: string[];
  toolOptions?: ToolLaunchOptionsById;
  repoIds?: string[] | null;
  promptId?: string | null;
  prompt?: string | null;
}

export interface Worktree {
  repoId: string;
  repoName: string;
  repoPath: string;
  role: 'primary' | 'secondary';
  workspaceMode: WorkspaceMode;
  /** Stable, task-scoped Coriol worktree path exposed to users and agents. */
  worktreePath: string;
  branchName: string | null;
  baseBranch: string | null;
  remoteBranch: string | null;
  sourceExternalId: string | null;
  installCommand: string | null;
  installedAt: string | null;
  dependenciesReused?: boolean;
  status: 'pending' | 'preparing' | 'ready' | 'failed' | 'cleaned';
  /** Latest Coriol phase, available while preparation is running. */
  preparationStep?: string;
  errorMessage?: string | null;
  cleanedAt: string | null;
  preparedAt: string;
}

export interface PromptTemplate {
  id: string;
  title: string;
  content: string;
  builtIn: boolean;
  overridden: boolean;
}

export interface RenderPromptInput {
  promptId: string;
  title: string;
  sources?: StartWorkSource[];
  workspacePaths?: string[];
}

export interface RenderedPrompt {
  promptId: string;
  content: string;
}

/** Herdr's agent lifecycle, plus Lovelace's launch and end states. */
export type AgentSessionState = 'starting' | 'working' | 'idle' | 'done' | 'blocked' | 'unknown' | 'ended';

/** Herdr workspace that hosts a work item's sessions. */
export interface HerdrWorkspacePayload {
  workspaceId: string;
}

export interface AgentSession {
  /** Pane that runs (or ran) the agent; null before the first launch. */
  terminalRef: HerdrPaneRef | null;
  /** Herdr agent name; unique among live Herdr agents. */
  agentName: string;
  /** Native conversation identity as reported by Herdr's agent integrations. */
  nativeSessionId: string | null;
  /** Native conversation file, when the harness reports one (Pi resumes from it). */
  nativeSessionPath: string | null;
  toolId: string;
  options?: ToolLaunchOptions;
  promptId?: string | null;
  prompt?: string | null;
  /** The agent opened blocked (e.g. a folder trust dialog); `prompt` is submitted once it is idle. */
  promptPending?: boolean;
  title: string | null;
  cwd: string | null;
  status: 'running' | 'ended';
  agentState: AgentSessionState;
  metadata?: unknown;
}
