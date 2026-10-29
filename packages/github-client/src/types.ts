export type PullRequestBuildStatus = 'pending' | 'success' | 'failure';
export type PullRequestStatus = 'draft' | 'open' | 'approved' | 'changes-requested' | 'merged' | 'closed';
export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;

export interface GitHubRepository {
  databaseId: number;
  name: string;
  nameWithOwner: string;
  cloneUrl: string;
  defaultBranch: string | null;
  isArchived: boolean;
  /** Lowercase topic names. */
  topics: string[];
}

export interface GitHubPullRequest {
  repoFullName: string;
  number: number;
  title: string;
  url: string;
  authorLogin: string | null;
  headRefName: string | null;
  baseRefName: string | null;
  isDraft: boolean;
  status: PullRequestStatus;
  reviewDecision: ReviewDecision;
  buildStatus: PullRequestBuildStatus | null;
  updatedAt: string;
}
