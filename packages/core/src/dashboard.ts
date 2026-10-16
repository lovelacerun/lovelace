import type { CodingHarnessId, ToolLaunchOptionsById } from './harnesses.js';
import type { LaunchPhase, WorkItemDetails, WorkItemState } from './types.js';

const SIDEBAR_SIDES = ['left', 'right'] as const;
export type SidebarSide = (typeof SIDEBAR_SIDES)[number];

export function isSidebarSide(value: unknown): value is SidebarSide {
  return value === 'left' || value === 'right';
}

export interface DashboardSettings {
  defaultAgent: CodingHarnessId;
  sidebarSide: SidebarSide;
  /** Initial editable Jira repository topic filter; empty means all topics. */
  repositoryTopics: string[];
}

export interface DashboardFreshness {
  jiraFetchedAt: string | null;
  githubFetchedAt: string | null;
  jiraStale: boolean;
  githubStale: boolean;
}

export interface WorkItemSummary {
  id: string;
  title: string;
  state: WorkItemState;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  sessionCount: number;
  repositoryCount: number;
  /** Latest active or unsuccessful launch; absent once the latest launch succeeds. */
  launchPhase?: LaunchPhase;
  trackerIssueKeys: string[];
  pullRequestRefs: Array<{ repoFullName: string; number: number }>;
}

export interface DashboardJiraIssue {
  id: string;
  key: string;
  title: string;
  url: string;
  status: string | null;
  issueType: string | null;
  updatedAt: string;
}

/** Recorded activity from the start of yesterday (server-local) until now. */
export interface DashboardRecent {
  /** ISO start of yesterday. */
  since: string;
  workItems: WorkItemSummary[];
  sessionCount: number;
  completedCount: number;
  cancelledCount?: number;
  activityCount: number;
}

export interface DashboardResponse {
  activeWorkItems: WorkItemSummary[];
  pendingJiraIssues: DashboardJiraIssue[];
  recent: DashboardRecent;
  settings: DashboardSettings;
  freshness: DashboardFreshness;
}

export interface QuickStartLaunchOutcome {
  /** Pending phases are not failures; `uncertain` requires inspecting Herdr. */
  phase?: LaunchPhase;
  ok: boolean;
  error: string | null;
}

export interface QuickStartResponse {
  details: WorkItemDetails;
  launch: QuickStartLaunchOutcome;
  operation?: { requestId: string; status: 'pending' | 'completed' | 'uncertain' };
}

export interface LaunchSelection {
  /** Explicit catalog IDs to prepare/select; empty/omitted prepares none. */
  repoIds?: string[];
  /** Template provenance only; prompt is the exact edited final text. */
  promptId?: string;
}

export interface QuickStartRequest extends LaunchSelection {
  /** false returns durable acceptance without waiting for preparation/agent startup. */
  wait?: boolean;
  requestId?: string;
  prompt: string;
  jiraIssueId?: string | null;
  agentId?: CodingHarnessId;
  options?: ToolLaunchOptionsById;
}

export interface NewSessionRequest extends LaunchSelection {
  wait?: boolean;
  requestId?: string;
  prompt: string;
  agentId?: CodingHarnessId;
  options?: ToolLaunchOptionsById;
}

/**
 * Opening a session focuses its live Herdr pane, or continues its exact native
 * conversation when the agent has ended.
 */
export interface SessionOpenResponse {
  action: 'focused' | 'continued';
  details: WorkItemDetails;
}

// Jira status categories considered terminal. Dashboard filtering removes
// matching issues from pendingJiraIssues (local work-item state is independent).
const JIRA_TERMINAL_STATUS_TEXTS = new Set<string>(['done', 'closed', 'resolved', 'cancelled', 'canceled']);

export function isJiraStatusTerminal(status: string | null | undefined): boolean {
  if (!status) return false;
  return JIRA_TERMINAL_STATUS_TEXTS.has(status.trim().toLowerCase());
}
