# @lovelace/github-client

Independent authenticated GitHub repository catalog, organization review inbox and pull-request reads using Octokit 4.1.2. A plain API client: no caching, environment/auth-file reads, work/session state, SQLite or server dependencies. Callers that need caching wrap it (the server uses `@lovelace/cache`).

```ts
import { createGitHubClient } from '@lovelace/github-client';

const github = createGitHubClient({
  org: 'example',
  token: suppliedToken,
  host: 'github.example.test', // omitted = github.com
  requestTimeoutMs: 15_000,
  fetch: injectedFetch,       // optional; Octokit default transport otherwise
});
if (github.isConfigured()) {
  const repositories = await github.fetchRepositories({ signal });
  const { human, automated } = await github.fetchReviewRequests();
  const branches = await github.fetchPullRequestDetails('example/service', 42);
  const status = await github.fetchPullRequestStatus('example/service', 42);
}
```

`suppliedToken`, `injectedFetch` and `signal` are caller-owned. `apiBaseUrl` overrides host-derived URLs. Enterprise hosts default to `https://<host>/api/v3` (Octokit derives the GraphQL endpoint). An optional `octokit: Pick<Octokit,'graphql'|'request'>` seam supports fixture tests.

## Guarantees and limits

- Every GraphQL/REST request is aborted after `requestTimeoutMs` (positive integer, default 15000) or when the caller's optional `signal` aborts. The signal reaches Octokit's request options; custom transports must honour it.
- Request, rate-limit, pagination and malformed-response errors reject; methods never return partial catalog/review lists or empty lists for failures.
- Repository discovery explicitly sets both `affiliations` and
  `ownerAffiliations` to owner, collaborator and organization-member access.
  GitHub otherwise defaults owner affiliations to owner-only repositories,
  even when viewer affiliations are broad. Discovery spans organizations; it does not
  filter by configured topics. Authentication only is required for the
  catalog; organization configuration is still required for review search.
- Catalog and review pages are sequential, cursor-cycle checked and capped at 100 pages; exceeding the limit rejects instead of silently truncating. Native Octokit retry/throttling behavior is retained.
- Review search matches open non-archived org PRs requesting review from the authenticated user. Drafts are omitted; authors matching `renovate|dependabot|bot` are separated from human review. This classification is heuristic, not an upstream human identity guarantee.
- PR methods accept `repoFullName,number`; invalid references and upstream not-found return null. Status preserves review/build/merge and head/base branch data.

Data interfaces (`RepoRecord`, `GitHubReviewRequest`, `GitHubReviewBuckets`, `GitHubPullRequestDetails`, `GitHubPullRequestStatus`) are exported locally. There are no repository-dashboard/security scans or repository-insight file/tag APIs.
