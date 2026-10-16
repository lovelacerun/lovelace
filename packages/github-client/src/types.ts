export type PullRequestBuildStatus = 'pending' | 'success' | 'failure';
export type PullRequestStatus = 'draft' | 'open' | 'approved' | 'changes-requested' | 'merged' | 'closed';
export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;

export interface RepoRecord {
  id: string;
  provider: string;
  externalId: string;
  name: string;
  fullName: string;
  cloneUrl: string;
  defaultBranch: string | null;
  isArchived: boolean;
  topics: string[];
  lastSyncedAt: string;
}

export interface GitHubReviewRequest {
  id: string;
  number: number;
  title: string;
  url: string;
  repoFullName: string;
  project: string;
  type: string | null;
  authorLogin: string | null;
  author: string | null;
  descriptionText: string | null;
  isDraft?: boolean;
  headRefName?: string | null;
  baseRefName?: string | null;
  status?: PullRequestStatus | null;
  reviewDecision?: ReviewDecision;
  buildStatus?: PullRequestBuildStatus | null;
  updatedAt: string;
}


export interface GitHubPullRequestDetails {
  repoFullName: string;
  number: number;
  headRefName: string | null;
  baseRefName: string | null;
  isDraft: boolean;
}

export interface GitHubPullRequestStatus extends Omit<GitHubPullRequestDetails, 'isDraft'> {
  title: string;
  url: string;
  authorLogin: string | null;
  status: PullRequestStatus;
  reviewDecision: ReviewDecision;
  buildStatus: PullRequestBuildStatus | null;
  mergeCommitSha: string | null;
}

export interface GitHubReviewBuckets {
  human: GitHubReviewRequest[];
  automated: GitHubReviewRequest[];
}
