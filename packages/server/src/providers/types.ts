import type { ChangeRequest, Repository, TrackerIssue } from '@lovelace/core';

export interface RequestOptions { signal?: AbortSignal }

/** An issue tracker, such as Jira. */
export interface Tracker {
  /** Stored with attachments and inbox entries, e.g. `jira`. */
  readonly provider: string;
  /** Shown in messages, e.g. `Jira`. */
  readonly name: string;
  isConfigured(): boolean;
  /** Unfinished issues assigned to the user. */
  fetchAssignedIssues(options?: RequestOptions): Promise<TrackerIssue[]>;
  /** Null when the issue does not exist. */
  fetchIssue(idOrKey: string, options?: RequestOptions): Promise<TrackerIssue | null>;
  /** The issue ID or key named by a key or an issue URL; null when neither names one. */
  parseIssueRef(input: { key?: string; url?: string }): string | null;
}

export type ChangeRequestRef = Pick<ChangeRequest, 'repository' | 'number'>;

/** A code host, such as GitHub. */
export interface CodeHost {
  /** Stored with repositories, attachments and inbox entries, e.g. `github`. */
  readonly provider: string;
  /** Shown in messages, e.g. `GitHub`. */
  readonly name: string;
  isConfigured(): boolean;
  /** Every repository the user can access. */
  fetchRepositories(options?: RequestOptions): Promise<Repository[]>;
  /** Open change requests awaiting the user's review. */
  fetchReviewRequests(options?: RequestOptions): Promise<ChangeRequest[]>;
  /** Null when the change request does not exist. */
  fetchChangeRequest(ref: ChangeRequestRef, options?: RequestOptions): Promise<ChangeRequest | null>;
  /** Null when `url` is not one of this host's change request URLs. */
  parseChangeRequestUrl(url: string): ChangeRequestRef | null;
}

export function changeRequestId(ref: ChangeRequestRef): string {
  return `${ref.repository}#${ref.number}`;
}
