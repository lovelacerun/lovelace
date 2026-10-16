import { Octokit } from 'octokit';
import type { GitHubPullRequestDetails, GitHubPullRequestStatus, GitHubReviewBuckets, GitHubReviewRequest, RepoRecord, PullRequestBuildStatus, PullRequestStatus, ReviewDecision } from './types.js';
export type * from './types.js';

export type GitHubTransport = Pick<Octokit, 'graphql' | 'request'>;

export interface GitHubClientOptions {
  org?: string;
  token?: string;
  host?: string;
  apiBaseUrl?: string;
  /** Per-request budget, including retries and body parsing (default 15000). */
  requestTimeoutMs?: number;
  now?: () => number;
  fetch?: typeof fetch;
  octokit?: GitHubTransport;
}
export interface RequestOptions { signal?: AbortSignal }
export interface GitHubClient {
  isConfigured(): boolean;
  fetchRepositories(options?: RequestOptions): Promise<RepoRecord[]>;
  fetchReviewRequests(options?: RequestOptions): Promise<GitHubReviewBuckets>;
  fetchPullRequestDetails(repoFullName: string, number: number, options?: RequestOptions): Promise<GitHubPullRequestDetails | null>;
  fetchPullRequestStatus(repoFullName: string, number: number, options?: RequestOptions): Promise<GitHubPullRequestStatus | null>;
}

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  options = { ...options };
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1) throw new Error('requestTimeoutMs must be a positive integer');
  const now = options.now ?? Date.now;
  const apiBaseUrl = options.apiBaseUrl ?? resolveApiBaseUrl(options.host);
  let transport: GitHubTransport | undefined = options.octokit;
  /** Each request gets its own timeout, combined with the caller's cancellation. */
  function client(signal?: AbortSignal): GitHubTransport {
    if (!options.token) throw new Error('GitHub token missing');
    const source = transport ??= new Octokit({
      auth: options.token, baseUrl: apiBaseUrl,
      request: options.fetch ? { fetch: options.fetch } : undefined,
    });
    return {
      graphql: ((query: string, variables: Record<string, unknown> = {}) => withTimeout(requestTimeoutMs, signal,
        (requestSignal) => source.graphql(query, { ...variables, request: { signal: requestSignal } }))) as GitHubTransport['graphql'],
      request: ((route: string, parameters: Record<string, unknown> = {}) => withTimeout(requestTimeoutMs, signal,
        (requestSignal) => source.request(route, { ...parameters, request: { signal: requestSignal } }))) as GitHubTransport['request'],
    };
  }
  const configured = () => Boolean(options.token);

  return {
    isConfigured: configured,
    async fetchRepositories(fetchOptions) {
      const octokit = client(fetchOptions?.signal);
      const repositories: RepoRecord[] = [];
      const seen = new Set<string>();
      let cursor: string | null = null;
      const fetchedAt = new Date(now()).toISOString();
      let pages = 0;
      do {
        if (++pages > 100) throw new Error('GitHub repository pagination limit exceeded');
        const response: GitHubRepositoryCatalogResponse = await octokit.graphql(GITHUB_REPOSITORY_CATALOG_QUERY, { cursor });
        const page = response.viewer?.repositories;
        if (!page || !Array.isArray(page.nodes) || typeof page.pageInfo?.hasNextPage !== 'boolean') throw new Error('Incomplete GitHub repository response');
        for (const repo of page.nodes) {
          if (!repo || !Number.isInteger(repo.databaseId) || !repo.name || !repo.nameWithOwner || !repo.url || !Array.isArray(repo.repositoryTopics?.nodes)) {
            throw new Error('Invalid GitHub repository response');
          }
          repositories.push({
            id: 'github:' + repo.databaseId, provider: 'github', externalId: String(repo.databaseId),
            name: repo.name, fullName: repo.nameWithOwner, cloneUrl: resolveGitHubCloneUrl(repo.url),
            defaultBranch: repo.defaultBranchRef?.name ?? null, isArchived: repo.isArchived,
            topics: repo.repositoryTopics.nodes.map((entry) => entry.topic.name.toLowerCase()), lastSyncedAt: fetchedAt,
          });
        }
        cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
        if (page.pageInfo.hasNextPage && (!cursor || seen.has(cursor))) throw new Error('Invalid GitHub repository pagination');
        if (cursor) seen.add(cursor);
      } while (cursor);
      return repositories;
    },
    async fetchReviewRequests(fetchOptions) {
      if (!configured() || !options.org) throw new Error('GitHub organization or token missing');
      const q = ['is:open', 'is:pr', 'org:' + options.org, 'archived:false', 'review-requested:@me'].join(' ');
      const all = await fetchAllReviewSearchResults(client(fetchOptions?.signal), q);
      const visible = all.filter((item) => !item.isDraft);
      return { human: visible.filter((item) => !isAutomatedAuthor(item.authorLogin)), automated: visible.filter((item) => isAutomatedAuthor(item.authorLogin)) };
    },
    async fetchPullRequestDetails(repoFullName, number, fetchOptions) {
      return fetchPullRequestDetailsInternal(client(fetchOptions?.signal), repoFullName, number);
    },
    async fetchPullRequestStatus(repoFullName, number, fetchOptions) {
      return fetchPullRequestStatusInternal(client(fetchOptions?.signal), repoFullName, number);
    },
  };
}

/** Abort one request after `timeoutMs` or when the caller cancels. */
async function withTimeout<T>(timeoutMs: number, parent: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`GitHub request timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await run(parent ? AbortSignal.any([controller.signal, parent]) : controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function resolveApiBaseUrl(host?: string): string {
  const normalized = host?.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  return !normalized || normalized === 'github.com' ? 'https://api.github.com' : 'https://' + normalized + '/api/v3';
}
function hasStrings(value: unknown, keys: string[]): boolean {
  return Boolean(value && typeof value === 'object' && keys.every((key) => typeof (value as Record<string, unknown>)[key] === 'string'));
}

async function fetchPullRequestDetailsInternal(octokit: GitHubTransport, repoFullName: string, number: number): Promise<GitHubPullRequestDetails | null> {
  const [owner, repo] = repoFullName.split('/');
  if (!owner || !repo || !Number.isInteger(number) || number <= 0) return null;
  try {
    const response = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner, repo, pull_number: number,
    });
    if (!response.data || !response.data.head || !response.data.base) throw new Error('Incomplete GitHub pull request response');
    return {
      repoFullName, number, headRefName: response.data.head.ref ?? null,
      baseRefName: response.data.base.ref ?? null, isDraft: response.data.draft ?? false,
    };
  } catch (error) {
    if (isGraphQLNotFoundError(error)) return null;
    throw error;
  }
}

async function fetchPullRequestStatusInternal(octokit: GitHubTransport, repoFullName: string, number: number): Promise<GitHubPullRequestStatus | null> {
  const [owner, repo] = repoFullName.split('/');
  if (!owner || !repo || !Number.isInteger(number) || number <= 0) return null;

  try {
    const response: GitHubPullRequestStatusResponse = await octokit.graphql(GITHUB_PULL_REQUEST_STATUS_QUERY, { owner, repo, number });
    if (!Object.hasOwn(response, 'repository') || (response.repository && !Object.hasOwn(response.repository, 'pullRequest'))) {
      throw new Error('Incomplete GitHub pull request status response');
    }
    const pullRequest = response.repository?.pullRequest;
    if (!pullRequest) return null;
    if (!['OPEN', 'MERGED', 'CLOSED'].includes(pullRequest.state) || typeof pullRequest.isDraft !== 'boolean') {
      throw new Error('Invalid GitHub pull request status response');
    }
    const buildStatus = mapStatusCheckRollupState(
      pullRequest.commits.nodes.at(0)?.commit.statusCheckRollup?.state ?? null,
    );
    const reviewDecision = pullRequest.reviewDecision ?? null;
    return {
      repoFullName,
      number: pullRequest.number,
      title: pullRequest.title,
      url: pullRequest.url,
      authorLogin: pullRequest.author?.login ?? null,
      headRefName: pullRequest.headRefName ?? null,
      baseRefName: pullRequest.baseRefName ?? null,
      status: derivePullRequestStatus({ state: pullRequest.state, isDraft: pullRequest.isDraft, reviewDecision }),
      reviewDecision,
      buildStatus,
      mergeCommitSha: pullRequest.mergeCommit?.oid ?? null,
    };
  } catch (error) {
    if (isGraphQLNotFoundError(error)) return null;
    throw error;
  }
}

async function fetchAllReviewSearchResults(octokit: GitHubTransport, q: string): Promise<GitHubReviewRequest[]> {
  const items: GitHubReviewRequest[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();

  for (let page = 0; page < 100; page++) {
    const response: GitHubReviewSearchResponse = await octokit.graphql(GITHUB_REVIEW_SEARCH_QUERY, {
      q,
      cursor,
    });

    if (!response.search || !Array.isArray(response.search.nodes) || typeof response.search.pageInfo?.hasNextPage !== 'boolean') throw new Error('Incomplete GitHub review response');
    for (const node of response.search.nodes) {
      if (!isPullRequestSearchNode(node)) continue;
      if (!['OPEN', 'MERGED', 'CLOSED'].includes(node.state) || typeof node.isDraft !== 'boolean'
        || !hasStrings(node, ['id', 'title', 'url', 'updatedAt']) || !hasStrings(node.repository, ['nameWithOwner'])) {
        throw new Error('Invalid GitHub review response');
      }
      const repoFullName = node.repository.nameWithOwner;
      const authorLogin = node.author?.login ?? null;
      const reviewDecision = node.reviewDecision ?? null;
      const buildStatus = mapStatusCheckRollupState(node.commits.nodes.at(0)?.commit.statusCheckRollup?.state ?? null);
      items.push({
        id: String(node.databaseId ?? node.id),
        number: node.number,
        title: node.title,
        url: node.url,
        repoFullName,
        project: repoFullName,
        type: detectChangeRequestType(node.title),
        authorLogin,
        author: authorLogin,
        descriptionText: null,
        isDraft: node.isDraft,
        headRefName: node.headRefName ?? null,
        baseRefName: node.baseRefName ?? null,
        status: derivePullRequestStatus({ state: node.state, isDraft: node.isDraft, reviewDecision }),
        reviewDecision,
        buildStatus,
        updatedAt: node.updatedAt,
      });
    }

    if (!response.search.pageInfo.hasNextPage) return items;
    cursor = response.search.pageInfo.endCursor;
    if (!cursor || seen.has(cursor)) throw new Error('Invalid GitHub review pagination');
    seen.add(cursor);
  }

  throw new Error('GitHub review pagination limit exceeded');
}

const GITHUB_REPOSITORY_CATALOG_QUERY = `
  query LovelaceRepositoryCatalog($cursor: String) {
    viewer {
      repositories(first: 100, after: $cursor, affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], orderBy: {field: NAME, direction: ASC}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          databaseId name nameWithOwner url isArchived
          defaultBranchRef { name }
          repositoryTopics(first: 100) { nodes { topic { name } } }
        }
      }
    }
  }
`;

const GITHUB_PULL_REQUEST_STATUS_QUERY = `
  query LovelacePullRequestStatus($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        number
        title
        url
        state
        isDraft
        reviewDecision
        headRefName
        baseRefName
        author { login }
        mergeCommit { oid }
        commits(last: 1) {
          nodes { commit { statusCheckRollup { state } } }
        }
      }
    }
  }
`;

const GITHUB_REVIEW_SEARCH_QUERY = `
  query LovelaceReviewRequests($q: String!, $cursor: String) {
    search(query: $q, type: ISSUE, first: 100, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        __typename
        ... on PullRequest {
          id
          databaseId
          number
          title
          url
          updatedAt
          state
          isDraft
          reviewDecision
          headRefName
          baseRefName
          commits(last: 1) {
            nodes { commit { statusCheckRollup { state } } }
          }
          repository {
            nameWithOwner
          }
          author {
            login
          }
        }
      }
    }
  }
`;

interface GitHubRepositoryCatalogResponse {
  viewer: {
    repositories: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{
        databaseId: number;
        name: string;
        nameWithOwner: string;
        url: string;
        isArchived: boolean;
        defaultBranchRef: { name: string } | null;
        repositoryTopics: { nodes: Array<{ topic: { name: string } }> };
      }>;
    };
  };
}

interface GitHubPullRequestStatusResponse {
  repository: {
    pullRequest: {
      number: number;
      title: string;
      url: string;
      state: 'OPEN' | 'MERGED' | 'CLOSED';
      isDraft: boolean;
      reviewDecision: ReviewDecision;
      headRefName: string | null;
      baseRefName: string | null;
      author: { login?: string | null } | null;
      mergeCommit: { oid: string } | null;
      commits: { nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } }> };
    } | null;
  } | null;
}

interface GitHubReviewSearchResponse {
  search: {
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
    nodes: Array<PullRequestSearchNode | { __typename: string } | null>;
  };
}

interface PullRequestSearchNode {
  __typename: 'PullRequest';
  id: string;
  databaseId: number | null;
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  isDraft: boolean;
  reviewDecision: ReviewDecision;
  headRefName: string | null;
  baseRefName: string | null;
  commits: { nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } }> };
  repository: { nameWithOwner: string };
  author: { login?: string | null } | null;
}

function isPullRequestSearchNode(node: PullRequestSearchNode | { __typename: string } | null): node is PullRequestSearchNode {
  return node?.__typename === 'PullRequest';
}

function mapStatusCheckRollupState(state: string | null): PullRequestBuildStatus | null {
  switch (state) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
    case 'ERROR':
      return 'failure';
    case 'PENDING':
    case 'EXPECTED':
      return 'pending';
    default:
      return null;
  }
}

function isGraphQLNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const maybe = error as { errors?: Array<{ type?: string; message?: string }>; status?: number };
  return maybe.status === 404 || Boolean(maybe.errors?.length && maybe.errors.every((entry) => entry.type === 'NOT_FOUND'));
}

export function resolveGitHubCloneUrl(repositoryUrl: string): string {
  const normalized = repositoryUrl.replace(/\/$/, '');
  return normalized.endsWith('.git') ? normalized : `${normalized}.git`;
}

function isAutomatedAuthor(login: string | null | undefined): boolean {
  if (!login) return false;
  return /renovate|dependabot|bot/i.test(login);
}

function detectChangeRequestType(title: string): string | null {
  const normalized = title.trim().toLowerCase();
  if (!normalized) return null;

  const conventionalType = normalized.match(/^([a-z]+)(?:\([^)]*\))?!?:\s+/)?.[1] ?? normalized.match(/^([a-z]+):\s+/)?.[1];
  switch (conventionalType) {
    case 'feat':
      return 'Feature';
    case 'fix':
      return 'Fix';
    case 'refactor':
      return 'Refactor';
    case 'perf':
      return 'Performance';
    case 'docs':
      return 'Documentation';
    case 'test':
      return 'Test';
    case 'build':
      return 'Build';
    case 'ci':
      return 'CI';
    case 'chore':
      return 'Chore';
    case 'style':
      return 'Style';
    case 'revert':
      return 'Revert';
    default:
      return 'Pull Request';
  }
}

function derivePullRequestStatus(input: {
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  isDraft: boolean;
  reviewDecision: ReviewDecision;
}): PullRequestStatus {
  if (input.state === 'MERGED') return 'merged';
  if (input.state === 'CLOSED') return 'closed';
  if (input.isDraft) return 'draft';
  if (input.reviewDecision === 'APPROVED') return 'approved';
  if (input.reviewDecision === 'CHANGES_REQUESTED') return 'changes-requested';
  return 'open';
}
