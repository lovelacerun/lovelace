import { existsSync } from 'node:fs';
import { mkdir, realpath, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { run } from './process.js';

interface GitRepository {
  path: string;
  defaultBranch: string | null;
  remoteUrl: string | null;
}

export async function inspectRepository(path: string): Promise<GitRepository | null> {
  const topLevel = await git(path, ['rev-parse', '--show-toplevel']);
  if (!topLevel) return null;
  const [defaultBranch, remoteUrl] = await Promise.all([
    git(topLevel, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']),
    git(topLevel, ['config', '--get', 'remote.origin.url']),
  ]);
  return {
    path: topLevel,
    defaultBranch: defaultBranch?.replace(/^origin\//, '') ?? null,
    remoteUrl,
  };
}

export async function ensureClone(cloneUrl: string, path: string): Promise<GitRepository> {
  if (existsSync(path)) {
    const repository = await inspectRepository(path);
    if (!repository) {
      // The manager owns this path, so an interrupted clone can be discarded safely.
      await rm(path, { recursive: true, force: true });
    } else {
      if (repository.remoteUrl === null) {
        await gitOrThrow(path, ['remote', 'add', 'origin', cloneUrl]);
      } else if (repository.remoteUrl !== cloneUrl) {
        await gitOrThrow(path, ['remote', 'set-url', 'origin', cloneUrl]);
      }
      return { ...repository, remoteUrl: cloneUrl };
    }
  }

  await mkdir(dirname(path), { recursive: true });
  await executeGit(['clone', '--origin', 'origin', cloneUrl, path]);
  const repository = await inspectRepository(path);
  if (!repository) throw new Error(`Git clone did not create a repository at ${path}`);
  return repository;
}

export async function refreshSeed(path: string, baseBranch: string): Promise<string> {
  await git(path, ['worktree', 'prune']);
  await gitOrThrow(path, ['fetch', '--prune', 'origin']);
  await gitOrThrow(path, ['checkout', '--detach', '--force', `origin/${baseBranch}`]);
  return await gitOrThrow(path, ['rev-parse', 'HEAD']);
}

/**
 * Stacked bases are usually unpushed branches of sibling worktrees, so a local
 * branch wins. The default branch always comes from origin: its local copy is stale.
 */
export async function resolveBaseRef(repositoryPath: string, baseBranch: string, defaultBranch: string): Promise<string> {
  if (baseBranch !== defaultBranch && await gitSucceeds(repositoryPath, ['show-ref', '--verify', '--quiet', `refs/heads/${baseBranch}`])) {
    return `refs/heads/${baseBranch}`;
  }
  if (await gitSucceeds(repositoryPath, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${baseBranch}`])) return `origin/${baseBranch}`;
  throw new Error(`Base branch not found locally or on origin: ${baseBranch}`);
}

export async function createWorktree(input: {
  repositoryPath: string;
  workspacePath: string;
  branchName: string;
  targetRef: string;
}): Promise<'created' | 'adopted'> {
  await gitOrThrow(input.repositoryPath, ['check-ref-format', '--branch', input.branchName]);
  const adoption = await inspectWorktree(input.repositoryPath, input.workspacePath);
  if (adoption) {
    if (adoption.branchName === input.branchName) return 'adopted';
    throw new Error(`Workspace path already contains branch ${adoption.branchName ?? '(detached)'}: ${input.workspacePath}`);
  }
  if (existsSync(input.workspacePath)) {
    throw new Error(`Workspace path already exists and is not a worktree of the managed repository: ${input.workspacePath}`);
  }

  await mkdir(dirname(input.workspacePath), { recursive: true });
  const branchExists = await gitSucceeds(input.repositoryPath, ['show-ref', '--verify', '--quiet', `refs/heads/${input.branchName}`]);
  if (branchExists) {
    await gitOrThrow(input.repositoryPath, ['worktree', 'add', input.workspacePath, input.branchName]);
  } else {
    await gitOrThrow(input.repositoryPath, ['worktree', 'add', '-b', input.branchName, input.workspacePath, input.targetRef]);
  }
  return 'created';
}

export async function removeWorktree(repositoryPath: string, workspacePath: string): Promise<void> {
  const topLevel = await git(workspacePath, ['rev-parse', '--show-toplevel']);
  const target = topLevel ?? workspacePath;
  await gitOrThrow(repositoryPath, ['worktree', 'remove', '--force', target]);
  await git(repositoryPath, ['worktree', 'prune']);
  if (target !== workspacePath && existsSync(workspacePath)) {
    await rm(workspacePath, { force: true });
  }
}

async function inspectWorktree(repositoryPath: string, workspacePath: string): Promise<{ branchName: string | null } | null> {
  if (!existsSync(workspacePath)) return null;
  const [topLevel, candidateCommonDir, repositoryCommonDir] = await Promise.all([
    git(workspacePath, ['rev-parse', '--show-toplevel']),
    git(workspacePath, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    git(repositoryPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
  ]);
  if (!topLevel || !candidateCommonDir || !repositoryCommonDir) return null;
  if (!samePath(topLevel, workspacePath) || !samePath(candidateCommonDir, repositoryCommonDir)) return null;
  return { branchName: await git(workspacePath, ['symbolic-ref', '--quiet', '--short', 'HEAD']) };
}

async function samePath(left: string, right: string): Promise<boolean> {
  return (await safeRealpath(left)) === (await safeRealpath(right));
}

async function safeRealpath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function git(path: string, args: string[]): Promise<string | null> {
  try { return (await run('git', ['-C', path, ...args], path, undefined, false)) || null; }
  catch { return null; }
}

async function gitSucceeds(path: string, args: string[]): Promise<boolean> {
  try { await run('git', ['-C', path, ...args], path, undefined, false); return true; }
  catch { return false; }
}

async function gitOrThrow(path: string, args: string[]): Promise<string> {
  return run('git', ['-C', path, ...args], path, undefined, false);
}

async function executeGit(args: string[]): Promise<void> {
  await run('git', args, process.cwd(), undefined, false);
}
