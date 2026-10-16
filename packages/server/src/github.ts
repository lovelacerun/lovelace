import { createGitHubClient as createProvider, type GitHubClient, type GitHubClientOptions } from '@lovelace/github-client';
import type { LovelaceConfig } from '@lovelace/core';

type GitHubAdapterOptions = Pick<GitHubClientOptions, 'fetch' | 'octokit' | 'now' | 'requestTimeoutMs'>;

/** Application authentication belongs here, not in the reusable provider package. */
export function createGitHubClient(config: LovelaceConfig, options: GitHubAdapterOptions = {}): GitHubClient {
  let current: GitHubClient | undefined;
  let identity: string | undefined;
  // The auth routes update the token in place; rebuild the provider when the identity changes.
  function provider() {
    const github = config.github;
    const nextIdentity = JSON.stringify([github?.org, github?.apiBaseUrl, github?.host, github?.token]);
    if (!current || identity !== nextIdentity) {
      identity = nextIdentity;
      current = createProvider({ org: github?.org, apiBaseUrl: github?.apiBaseUrl, host: github?.host, token: github?.token, ...options });
    }
    return current;
  }
  return {
    isConfigured: () => provider().isConfigured(),
    fetchRepositories: (...args) => provider().fetchRepositories(...args),
    fetchReviewRequests: (...args) => provider().fetchReviewRequests(...args),
    fetchPullRequestDetails: (...args) => provider().fetchPullRequestDetails(...args),
    fetchPullRequestStatus: (...args) => provider().fetchPullRequestStatus(...args),
  };
}
