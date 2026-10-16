import assert from 'node:assert/strict';
import test from 'node:test';
import { Octokit } from 'octokit';

import { createGitHubClient, type GitHubTransport } from './index.js';

const repo = (id: number) => ({ databaseId: id, name: `repo-${id}`, nameWithOwner: `org/repo-${id}`, url: `https://github.test/org/repo-${id}`, isArchived: false, defaultBranchRef: { name: 'main' }, repositoryTopics: { nodes: [{ topic: { name: 'INFRA' } }] } });
const catalog = (nodes = [repo(1)], endCursor: string | null = null) => ({ viewer: { repositories: { nodes, pageInfo: { hasNextPage: Boolean(endCursor), endCursor } } } });
const pr = (id: number, author: string, isDraft = false) => ({ __typename: 'PullRequest', id: String(id), databaseId: id, number: id, title: 'fix: Example', url: `https://github.test/org/repo/pull/${id}`, updatedAt: '2026-10-01T00:00:00Z', state: 'OPEN', isDraft, reviewDecision: 'APPROVED', headRefName: 'fix', baseRefName: 'main', commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] }, repository: { nameWithOwner: 'org/repo' }, author: { login: author } });
function transport(graphql: (query: string, variables: Record<string, unknown>) => Promise<unknown>, request = async (_route: string, _variables: Record<string, unknown>): Promise<unknown> => { throw new Error('Unexpected REST request'); }): GitHubTransport {
  return { graphql, request } as unknown as GitHubTransport;
}
const credentials = { org: 'org', token: 'fixture-only-token' };

test('accessible catalog paginates, preserves topics, branch and enterprise clone URL', async () => {
  const variables: Record<string, unknown>[] = [];
  const github = createGitHubClient({ ...credentials, octokit: transport(async (_, args) => {
    variables.push(args);
    return args.cursor ? catalog([repo(2)]) : catalog([repo(1)], 'next');
  }) });
  const repositories = await github.fetchRepositories();
  assert.equal(repositories.length, 2);
  assert.deepEqual(variables.map((args) => args.cursor), [null, 'next']);
  assert.equal(repositories[0]?.cloneUrl, 'https://github.test/org/repo-1.git');
  assert.deepEqual(repositories[0]?.topics, ['infra']);
  assert.equal(repositories[0]?.defaultBranch, 'main');
});

test('catalog uses all viewer affiliations, including repositories outside the configured organization', async () => {
  const outside = { ...repo(2), nameWithOwner: 'other/repo-2', url: 'https://github.test/other/repo-2', repositoryTopics: { nodes: [] } };
  const github = createGitHubClient({ token: credentials.token, octokit: transport(async (query, args) => {
    assert.match(query, /viewer\s*\{/);
    assert.match(query, /affiliations: \[OWNER, COLLABORATOR, ORGANIZATION_MEMBER\]/);
    // GitHub defaults ownerAffiliations to OWNER even when affiliations is broad.
    assert.match(query, /ownerAffiliations: \[OWNER, COLLABORATOR, ORGANIZATION_MEMBER\]/);
    assert.equal(args.org, undefined);
    return catalog([repo(1), outside]);
  }) });
  assert.equal(github.isConfigured(), true, 'repository discovery only requires authentication');
  assert.deepEqual((await github.fetchRepositories()).map(repo => repo.fullName), ['org/repo-1', 'other/repo-2']);
  await assert.rejects(github.fetchReviewRequests(), /organization or token missing/);
});

test('real Octokit request injection honors enterprise host and token without external requests', async () => {
  let url = '', headers: Headers | undefined;
  const github = createGitHubClient({ ...credentials, host: 'https://github.enterprise.test/', fetch: async (input, init) => {
    url = String(input); headers = new Headers(init?.headers);
    return Response.json({ data: catalog() });
  } });
  await github.fetchRepositories();
  assert.equal(url, 'https://github.enterprise.test/api/graphql');
  assert.equal(headers?.get('authorization'), 'token fixture-only-token');
});

test('human and automated review searches paginate atomically and omit drafts', async () => {
  const github = createGitHubClient({ ...credentials, octokit: transport(async (_, args) => {
    assert.match(String(args.q), /org:org.*review-requested:@me/);
    return { search: { nodes: args.cursor ? [pr(3, 'dependabot[bot]')] : [pr(1, 'human'), pr(2, 'renovate', true), null, { __typename: 'Issue' }], pageInfo: { hasNextPage: !args.cursor, endCursor: args.cursor ? null : 'next' } } };
  }) });
  const result = await github.fetchReviewRequests();
  assert.deepEqual(result.human.map((item) => item.number), [1]);
  assert.deepEqual(result.automated.map((item) => item.number), [3]);
  assert.equal(result.human[0]?.status, 'approved');
  assert.equal(result.human[0]?.buildStatus, 'success');
  assert.equal(result.human[0]?.type, 'Fix');
});

test('failure on a later page or an incomplete response rejects instead of returning a partial catalog', async () => {
  let mode = 'partial';
  const github = createGitHubClient({ ...credentials, octokit: transport(async (_, args) => {
    if (mode === 'missing') return { viewer: null };
    if (args.cursor) throw new Error('second page failed');
    return catalog([repo(2)], 'next');
  }) });
  await assert.rejects(github.fetchRepositories(), /second page/);
  mode = 'missing';
  await assert.rejects(github.fetchRepositories(), /Incomplete/);
});

test('repeated review cursors reject', async () => {
  const github = createGitHubClient({ ...credentials, octokit: transport(async () => ({ search: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'same' } } })) });
  await assert.rejects(github.fetchReviewRequests(), /pagination/);
});

test('missing auth rejects without calling the transport', async () => {
  const github = createGitHubClient({ org: 'org', octokit: transport(async () => { throw new Error('unexpected'); }) });
  assert.equal(github.isConfigured(), false);
  await assert.rejects(github.fetchRepositories(), /token missing/);
  await assert.rejects(github.fetchReviewRequests(), /token missing/);
  await assert.rejects(github.fetchPullRequestStatus('org/repo', 1), /token missing/);
});

test('PR branch/status operations retain merge, approval and build metadata; not found is null', async () => {
  let missing = false;
  const github = createGitHubClient({ ...credentials, octokit: transport(async () => {
    if (missing) throw { errors: [{ type: 'NOT_FOUND' }] };
    return { repository: { pullRequest: { ...pr(1, 'human'), state: 'MERGED', mergeCommit: { oid: 'merge-sha' } } } };
  }, async () => ({ data: { head: { ref: 'feature' }, base: { ref: 'main' }, draft: true } })) });
  assert.deepEqual(await github.fetchPullRequestDetails('org/repo', 1), { repoFullName: 'org/repo', number: 1, headRefName: 'feature', baseRefName: 'main', isDraft: true });
  const status = await github.fetchPullRequestStatus('org/repo', 1);
  assert.equal(status?.status, 'merged');
  assert.equal(status?.mergeCommitSha, 'merge-sha');
  assert.equal(status?.buildStatus, 'success');
  missing = true;
  assert.equal(await github.fetchPullRequestStatus('org/repo', 1), null);
  assert.equal(await github.fetchPullRequestStatus('bad', -1), null);
});

test('each request times out through its abort signal and a later request can succeed', async () => {
  let stalled = true;
  const fetch: typeof globalThis.fetch = async (_, init) => {
    if (!stalled) return Response.json({ data: catalog() });
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
  };
  const octokit = new Octokit({ auth: credentials.token, request: { fetch }, throttle: { enabled: false }, retry: { enabled: false } });
  const github = createGitHubClient({ ...credentials, octokit, requestTimeoutMs: 20 });
  await assert.rejects(github.fetchRepositories(), /GitHub request timed out after 20ms/);
  stalled = false;
  assert.equal((await github.fetchRepositories()).length, 1);
});

test('caller cancellation reaches GraphQL and REST requests', async () => {
  const signals: AbortSignal[] = [];
  const github = createGitHubClient({ ...credentials, requestTimeoutMs: 1000, octokit: transport(async (_, args) => {
    signals.push((args.request as { signal: AbortSignal }).signal);
    return catalog();
  }, async (_, args) => {
    signals.push((args.request as { signal: AbortSignal }).signal);
    return { data: { head: { ref: 'feature' }, base: { ref: 'main' }, draft: false } };
  }) });
  const controller = new AbortController();
  await github.fetchRepositories({ signal: controller.signal });
  await github.fetchPullRequestDetails('org/repo', 1, { signal: controller.signal });
  controller.abort();
  assert.deepEqual(signals.map((signal) => signal.aborted), [true, true]);
});

test('GitHub validates the request timeout before starting any transport', () => {
  for (const value of [0, -1, NaN, Infinity, 0.5]) {
    assert.throws(() => createGitHubClient({ ...credentials, requestTimeoutMs: value }), /requestTimeoutMs/);
  }
});
