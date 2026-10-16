import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkspaceManager } from '@lovelace/coriol';
import type { RepoRecord } from '@lovelace/core';
import type { DatabaseState } from '../database.js';
import type { GitHubPullRequestStatus } from '@lovelace/github-client';
import { createPullRequestReleaseChecker } from './pull-request-release-service.js';

const pullRequest: GitHubPullRequestStatus = {
  repoFullName: 'example/service',
  number: 42,
  title: 'Ship it',
  url: 'https://github.com/example/service/pull/42',
  authorLogin: 'ada',
  headRefName: 'feature',
  baseRefName: 'main',
  status: 'merged',
  reviewDecision: 'APPROVED',
  buildStatus: 'success',
  mergeCommitSha: 'merge-sha',
};

const repository: RepoRecord = {
  id: 'github:1',
  provider: 'github',
  externalId: '1',
  name: 'service',
  fullName: 'example/service',
  cloneUrl: 'https://github.com/example/service.git',
  defaultBranch: 'main',
  isArchived: false,
  topics: [],
  lastSyncedAt: new Date().toISOString(),
};

const database = { listRepos: () => [repository] } as DatabaseState;
const logger = { warn() {} };

test('does not apply a built-in release convention when no script is configured', async () => {
  let refreshCount = 0;
  const workspaceManager = {
    refreshRepository: async () => {
      refreshCount += 1;
      return { id: 'github/example/service', cloneUrl: repository.cloneUrl, defaultBranch: 'main', path: '/managed/service' };
    },
  } as unknown as WorkspaceManager;
  const checker = createPullRequestReleaseChecker({
    config: undefined,
    lovelaceDir: process.cwd(),
    database,
    workspaceManager,
    logger,
  });

  assert.equal(checker.isComplete(pullRequest.repoFullName, []), true);
  assert.equal(checker.isComplete(pullRequest.repoFullName, undefined), false);
  assert.deepEqual(await checker.check(pullRequest), []);
  assert.equal(refreshCount, 0);
});

test('refreshes the managed checkout and passes its path to the configured script', async () => {
  const checkoutPath = '/managed/service';
  const descriptors: unknown[] = [];
  const workspaceManager = {
    refreshRepository: async (descriptor: unknown) => {
      descriptors.push(descriptor);
      return { id: 'github/example/service', cloneUrl: repository.cloneUrl, defaultBranch: 'main', path: checkoutPath };
    },
  } as unknown as WorkspaceManager;
  const script = `
    let input = '';
    process.stdin.on('data', chunk => input += chunk);
    process.stdin.on('end', () => {
      const request = JSON.parse(input);
      process.stdout.write(JSON.stringify({
        environments: {
          canary: { released: true, description: request.checkoutPath },
          live: false
        }
      }));
    });
  `;
  const checker = createPullRequestReleaseChecker({
    config: {
      environments: ['canary', 'live'],
      script: [process.execPath, '-e', script],
    },
    lovelaceDir: process.cwd(),
    database,
    workspaceManager,
    logger,
  });

  const releases = await checker.check(pullRequest);

  assert.equal(checker.isComplete(pullRequest.repoFullName, releases), false);
  assert.deepEqual(descriptors, [{
    id: 'github/example/service',
    cloneUrl: repository.cloneUrl,
    defaultBranch: 'main',
  }]);
  assert.deepEqual(releases.map(({ environment, released, description }) => ({ environment, released, description })), [
    { environment: 'canary', released: true, description: checkoutPath },
    { environment: 'live', released: false, description: null },
  ]);
});

test('accepts script-defined environments when none are configured', async () => {
  const workspaceManager = {
    refreshRepository: async () => ({
      id: 'github/example/service',
      cloneUrl: repository.cloneUrl,
      defaultBranch: 'main',
      path: '/managed/service',
    }),
  } as unknown as WorkspaceManager;
  const script = `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ environments: { live: true } })));`;
  const checker = createPullRequestReleaseChecker({
    config: { scripts: { 'example/service': [process.execPath, '-e', script] } },
    lovelaceDir: process.cwd(),
    database,
    workspaceManager,
    logger,
  });

  const releases = await checker.check(pullRequest);

  assert.deepEqual(releases.map(({ environment, released }) => ({ environment, released })), [
    { environment: 'live', released: true },
  ]);
});

test('does not run release scripts before a pull request is merged', async () => {
  const checker = createPullRequestReleaseChecker({
    config: { script: '/unused' },
    lovelaceDir: process.cwd(),
    database,
    workspaceManager: {} as WorkspaceManager,
    logger,
  });

  assert.deepEqual(await checker.check({ ...pullRequest, status: 'open', mergeCommitSha: null }), []);
});
