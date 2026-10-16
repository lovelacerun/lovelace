import assert from 'node:assert/strict';
import test from 'node:test';
import type { LovelaceConfig } from '@lovelace/core';
import { resolveGitHubCloneUrl } from '@lovelace/github-client';
import { createGitHubClient } from '../github.js';

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
  const github = createGitHubClient(configuration, { fetch: async (_, init) => {
    tokens.push(new Headers(init?.headers).get('authorization') ?? '');
    return Response.json({ data: { viewer: { repositories: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } });
  } });
  assert.equal(github.isConfigured(), true);
  await github.fetchRepositories();
  configuration.github!.token = 'rotated';
  await github.fetchRepositories();
  assert.deepEqual(tokens, ['token fixture-only', 'token rotated']);
});

function config(): LovelaceConfig {
  return {
    domainRoot: '/tmp/lovelace-provider-fixture-no-user-state',
    lovelaceDir: '/tmp/lovelace-provider-fixture-no-user-state/.lovelace',
    port: 27421, logLevel: 'info', syncIntervalMs: 300_000,
    defaultAgent: 'pi', tui: { sidebarSide: 'right' },
    github: { org: 'example', token: 'fixture-only' },
  };
}
