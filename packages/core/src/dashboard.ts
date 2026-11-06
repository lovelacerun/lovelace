import type { CodingHarnessId, ToolLaunchOptionsById } from './harnesses.js';
import type { ChangeRequest, Launch, LaunchState, TrackerIssue, WorkItemDetails, WorkItemState } from './types.js';

export const SIDEBAR_SIDES = ['left', 'right'] as const;
export type SidebarSide = (typeof SIDEBAR_SIDES)[number];

export interface DashboardSettings {
  defaultAgent: CodingHarnessId;
  /** Initial editable Jira repository topic filter; empty means all topics. */
  repositoryTopics: string[];
}

export interface DashboardFreshness {
  trackerFetchedAt: string | null;
  codeHostFetchedAt: string | null;
  trackerStale: boolean;
  codeHostStale: boolean;
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
  launchState?: LaunchState;
  trackerIssueKeys: string[];
  changeRequestRefs: Array<Pick<ChangeRequest, 'repository' | 'number'>>;
}

export type DashboardIssue = Pick<TrackerIssue, 'id' | 'key' | 'title' | 'url' | 'status' | 'issueType' | 'createdAt' | 'updatedAt'>;

/** A change request awaiting the user's review, with its catalog repository when known. */
export interface DashboardReview extends Pick<ChangeRequest,
  'id' | 'number' | 'title' | 'url' | 'repository' | 'author' | 'sourceBranch' | 'targetBranch' | 'createdAt' | 'updatedAt'> {
  repoId: string | null;
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
  pendingIssues: DashboardIssue[];
  pendingReviews: DashboardReview[];
  recent: DashboardRecent;
  settings: DashboardSettings;
  freshness: DashboardFreshness;
}

export interface LaunchResponse {
  details: WorkItemDetails;
  launch: Launch;
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
  trackerIssueId?: string | null;
  /** Review request to attach; its repository must be among `repoIds` and is checked out at the pull request's branch. */
  reviewRequestId?: string | null;
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
