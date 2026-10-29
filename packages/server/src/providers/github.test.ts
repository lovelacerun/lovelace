import assert from 'node:assert/strict';
import test from 'node:test';
import type { ServerConfig } from '@lovelace/core';
import { resolveGitHubCloneUrl } from '@lovelace/github-client';
import { createGitHubCodeHost } from './github.js';

test('uses the provider HTTPS URL for cloning', () => {
  assert.equal(
    resolveGitHubCloneUrl('https://github.com/example/service'),
    'https://github.com/example/service.git',
  );
});

test('does not duplicate an existing git suffix', () => {
  assert.equal(
    resolveGitHubCloneUrl('https://github.example.com/example/service.git'),
    'https://github.example.com/example/service.git',
  );
});

test('server facade follows token changes made by the auth routes', async () => {
  const configuration = config();
  const tokens: string[] = [];
  const github = createGitHubCodeHost(configuration, { fetch: async (_, init) => {
    tokens.push(new Headers(init?.headers).get('authorization') ?? '');
    return Response.json({ data: { viewer: { repositories: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } });
  } });
  assert.equal(github.isConfigured(), true);
  await github.fetchRepositories();
  configuration.github!.token = 'rotated';
  await github.fetchRepositories();
  assert.deepEqual(tokens, ['token fixture-only', 'token rotated']);
});

test('pull requests become change requests keyed by repository and number', async () => {
  const github = createGitHubCodeHost(config(), { octokit: { graphql: async () => ({ repository: { pullRequest: {
    number: 7, title: 'Fix', url: 'https://github.com/example/service/pull/7', updatedAt: '2026-10-01T00:00:00Z', state: 'OPEN', isDraft: false,
    reviewDecision: 'CHANGES_REQUESTED', headRefName: 'fix', baseRefName: 'main', author: { login: 'ann' },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] },
  } } }) } as never });
  assert.deepEqual(await github.fetchChangeRequest({ repository: 'example/service', number: 7 }), {
    id: 'example/service#7', repository: 'example/service', number: 7, title: 'Fix', url: 'https://github.com/example/service/pull/7',
    author: 'ann', sourceBranch: 'fix', targetBranch: 'main', status: 'changes-requested', review: 'changes-requested', build: 'pending',
    updatedAt: '2026-10-01T00:00:00Z',
  });
});

test('only pull request URLs name change requests', () => {
  const github = createGitHubCodeHost(config());
  assert.deepEqual(github.parseChangeRequestUrl('https://github.com/example/service/pull/7/files'), { repository: 'example/service', number: 7 });
  assert.equal(github.parseChangeRequestUrl('https://github.com/example/service/issues/7'), null);
  assert.equal(github.parseChangeRequestUrl('not a url'), null);
});

function config(): ServerConfig {
  return {
    domainRoot: '/tmp/lovelace-provider-fixture-no-user-state',
    lovelaceDir: '/tmp/lovelace-provider-fixture-no-user-state/.lovelace',
    port: 27421, logLevel: 'info', syncIntervalMs: 300_000,
    defaultAgent: 'pi',
    github: { org: 'example', token: 'fixture-only' },
  };
}
