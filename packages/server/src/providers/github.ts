import {
  createGitHubClient,
  type GitHubClient,
  type GitHubClientOptions,
  type GitHubPullRequest,
  type GitHubRepository,
  type ReviewDecision,
} from '@lovelace/github-client';
import type { ChangeRequest, ChangeRequestReview, LovelaceConfig, Repository } from '@lovelace/core';
import { changeRequestId, type ChangeRequestRef, type CodeHost } from './types.js';

type GitHubCodeHostOptions = Pick<GitHubClientOptions, 'fetch' | 'octokit' | 'requestTimeoutMs'>;

const REVIEWS: Record<Exclude<ReviewDecision, null>, ChangeRequestReview> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes-requested',
  REVIEW_REQUIRED: 'required',
};

/** Application authentication belongs here, not in the reusable client package. */
export function createGitHubCodeHost(config: LovelaceConfig, options: GitHubCodeHostOptions = {}): CodeHost {
  let current: GitHubClient | undefined;
  let identity: string | undefined;
  // The auth routes update the token in place; rebuild the client when the identity changes.
  function client() {
    const github = config.github;
    const nextIdentity = JSON.stringify([github?.org, github?.apiBaseUrl, github?.host, github?.token]);
    if (!current || identity !== nextIdentity) {
      identity = nextIdentity;
      current = createGitHubClient({ org: github?.org, apiBaseUrl: github?.apiBaseUrl, host: github?.host, token: github?.token, ...options });
    }
    return current;
  }
  return {
    provider: 'github',
    name: 'GitHub',
    isConfigured: () => client().isConfigured(),
    async fetchRepositories(requestOptions) {
      const syncedAt = new Date().toISOString();
      return (await client().fetchRepositories(requestOptions)).map((repository) => toRepository(repository, syncedAt));
    },
    fetchReviewRequests: async (requestOptions) => (await client().fetchReviewRequests(requestOptions)).map(toChangeRequest),
    async fetchChangeRequest(ref, requestOptions) {
      const pullRequest = await client().fetchPullRequest(ref.repository, ref.number, requestOptions);
      return pullRequest && toChangeRequest(pullRequest);
    },
    parseChangeRequestUrl,
  };
}

function toRepository(repository: GitHubRepository, lastSyncedAt: string): Repository {
  return {
    id: `github:${repository.databaseId}`,
    provider: 'github',
    externalId: String(repository.databaseId),
    name: repository.name,
    fullName: repository.nameWithOwner,
    cloneUrl: repository.cloneUrl,
    defaultBranch: repository.defaultBranch,
    isArchived: repository.isArchived,
    topics: repository.topics,
    lastSyncedAt,
  };
}

function toChangeRequest(pullRequest: GitHubPullRequest): ChangeRequest {
  const ref = { repository: pullRequest.repoFullName, number: pullRequest.number };
  return {
    id: changeRequestId(ref),
    ...ref,
    title: pullRequest.title,
    url: pullRequest.url,
    author: pullRequest.authorLogin,
    sourceBranch: pullRequest.headRefName,
    targetBranch: pullRequest.baseRefName,
    status: pullRequest.status,
    review: pullRequest.reviewDecision ? REVIEWS[pullRequest.reviewDecision] : null,
    build: pullRequest.buildStatus,
    updatedAt: pullRequest.updatedAt,
  };
}

/** `https://<host>/<owner>/<repo>/pull/<number>`. */
function parseChangeRequestUrl(value: string): ChangeRequestRef | null {
  try {
    const parts = new URL(value).pathname.split('/').filter(Boolean);
    const number = Number(parts[3]);
    if (parts[2] !== 'pull' || !parts[0] || !parts[1] || !Number.isInteger(number) || number <= 0) return null;
    return { repository: `${parts[0]}/${parts[1]}`, number };
  } catch {
    return null;
  }
}
