#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const request = JSON.parse(await readStdin());
const releaseStatuses = request.environments.map((environment) => checkTag({
  checkoutPath: request.checkoutPath,
  mergeCommitSha: request.pullRequest.mergeCommitSha,
  environment,
}));
process.stdout.write(JSON.stringify({ releaseStatuses }));

function checkTag({ checkoutPath, mergeCommitSha, environment }) {
  const ref = `refs/tags/${environment}`;
  const fetched = git(checkoutPath, ['fetch', '--force', 'origin', `${ref}:${ref}`]);
  if (!fetched.ok) {
    return {
      environment,
      released: null,
      description: fetched.stderr || `Could not fetch ${ref}`,
    };
  }

  const revision = git(checkoutPath, ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (!revision.ok) {
    return {
      environment,
      released: null,
      description: revision.stderr || `${ref} does not point to a commit`,
    };
  }

  const ancestry = git(checkoutPath, ['merge-base', '--is-ancestor', mergeCommitSha, revision.stdout]);
  if (ancestry.status !== 0 && ancestry.status !== 1) {
    return {
      environment,
      released: null,
      revision: revision.stdout,
      description: ancestry.stderr || `Could not compare the pull request commit with ${ref}`,
    };
  }

  return {
    environment,
    released: ancestry.status === 0,
    revision: revision.stdout,
  };
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
