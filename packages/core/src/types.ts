import type { GitHubReviewRequest, PullRequestBuildStatus, PullRequestStatus, RepoRecord, ReviewDecision } from '@lovelace/github-client';
import type { JiraIssueSummary } from '@lovelace/jira-client';
import type { HerdrConfig, HerdrPaneRef } from './herdr.js';
import type { SidebarSide } from './dashboard.js';
import type { CodingHarnessId, ToolLaunchOptions, ToolLaunchOptionsById } from './harnesses.js';

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

type WorkItemMetaType = 'tracker-item' | 'change-request' | 'session' | 'repository' | 'pull-request' | 'prompt-draft' | 'herdr-workspace';

export type { GitHubReviewRequest, JiraIssueSummary, RepoRecord };

export interface PullRequestReleaseStatus {
  environment: string;
  released: boolean | null;
  checkedAt: string;
  releasedAt: string | null;
  revision: string | null;
  url: string | null;
  source: string;
  description: string | null;
}

export interface PullRequestMetaPayload {
  repoFullName: string;
  number: number;
  title: string;
  url: string;
  authorLogin: string | null;
  headRefName: string | null;
  baseRefName: string | null;
  status: PullRequestStatus;
  reviewDecision: ReviewDecision;
  buildStatus: PullRequestBuildStatus | null;
  mergeCommitSha: string | null;
  releaseStatuses: PullRequestReleaseStatus[];
  attachedAt: string;
  lastSyncedAt: string;
}

type InboxMetaState = 'dismissed';
export type InboxSourceType = 'tracker-item' | 'change-request';
type LovelaceLinkSource = 'manual' | 'inferred';
type LovelaceLinkType = 'tracker-item';

export interface LovelaceLink {
  type: LovelaceLinkType;
  provider: string;
  externalId: string;
  key: string | null;
  url: string | null;
  source: LovelaceLinkSource;
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

export interface PullRequestReleaseConfig {
  /** Environment names expected from release-check scripts. */
  environments?: string[];
  /** Default executable and optional arguments for configured repositories. */
  script?: string | string[];
  /** Exact repository full name to executable override and optional arguments. */
  scripts?: Record<string, string | string[]>;
  scriptTimeoutMs?: number;
}

export type TuiThemeMode = 'dark' | 'light';

export interface LovelaceConfig {
  domainRoot: string;
  lovelaceDir: string;
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  syncIntervalMs: number;
  defaultAgent: CodingHarnessId;
  herdr?: HerdrConfig;
  /**
   * `icons`: Nerd Font glyphs, or plain Unicode for terminals without one.
   * `colors`: per-theme overrides of TUI colour tokens, `#rrggbb` or `none`.
   */
  tui: {
    sidebarSide: SidebarSide;
    icons?: 'nerd' | 'unicode';
    theme?: TuiThemeMode;
    colors?: Partial<Record<TuiThemeMode, Record<string, string>>>;
  };
  pullRequestReleases?: PullRequestReleaseConfig;
  github?: GitHubConfig;
  jira?: JiraConfig;
  /** Set by the process that starts the server, never read from the file. */
  agentCli?: AgentCli;
  version?: string;
}

export interface AgentCli {
  /** Shell command prefix that runs the Lovelace CLI against this server. */
  command: string;
  skillPath: string;
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

export interface WorkItemMeta {
  id: string;
  workItemId: string;
  metaType: WorkItemMetaType;
  provider: string | null;
  externalId: string | null;
  payloadJson: string | null;
  createdAt: string;
  updatedAt: string;
}

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

export type LaunchPhase = 'accepted' | 'preparing' | 'starting' | 'started' | 'failed' | 'uncertain';

export interface LaunchOperationSummary {
  requestId: string;
  draftMetaId: string;
  status: 'pending' | 'completed' | 'uncertain';
  launch: { ok: boolean; error: string | null; phase?: LaunchPhase };
}

export interface WorkItemDetails {
  workItem: WorkItem;
  metas: WorkItemMeta[];
  /** Server-owned launch progress, including drafts available for explicit retry. */
  launchOperations?: LaunchOperationSummary[];
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

export interface ToolLaunchDraftPayload {
  revision: string;
  requestId?: string;
  toolIds: string[];
  toolOptions?: ToolLaunchOptionsById;
  repoIds: string[] | null;
  promptId: string | null;
  prompt: string | null;
  status: 'pending' | 'launched';
  createdAt: string;
  updatedAt: string;
}

export interface StartWorkLaunchInput {
  toolIds: string[];
  toolOptions?: ToolLaunchOptionsById;
  repoIds?: string[] | null;
  promptId?: string | null;
  prompt?: string | null;
}

export interface RepositoryWorkspaceMetaPayload {
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
  context?: string;
}

export interface RenderedPrompt {
  promptId: string;
  content: string;
}

/** Herdr's agent lifecycle, plus Lovelace's launch and end states. */
export type AgentSessionState = 'starting' | 'working' | 'idle' | 'done' | 'blocked' | 'unknown' | 'ended';

/** Herdr workspace that hosts a work item's sessions. */
export interface HerdrWorkspaceMetaPayload {
  workspaceId: string;
  createdAt: string;
}

export interface ToolSessionMetaPayload {
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
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
}
