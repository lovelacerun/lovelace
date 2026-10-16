import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { execa } from 'execa';
import type { WorkspaceToolchain } from './types.js';
import { WorkspaceManager } from './workspace-manager.js';

const repository = {
  id: 'github/example/repository',
  cloneUrl: '',
  defaultBranch: 'main',
};

test('creates direct npm-warm worktrees and removes them', async () => {
  const fixture = await createRemoteFixture();
  const manager = new WorkspaceManager({ root: fixture.managerRoot });

  try {
    const workspace = await manager.createWorkspace({
      workspaceId: 'task-1234',
      repository: { ...repository, cloneUrl: fixture.originPath },
      directoryName: 'repository',
      branchName: 'work/task-1234',
    });

    assert.equal((await lstat(workspace.path)).isSymbolicLink(), false);
    assert.equal(await git(workspace.path, ['branch', '--show-current']), 'work/task-1234');
    assert.equal(await readFile(join(workspace.path, 'node_modules', 'local', 'package.json'), 'utf8'), '{"name":"local","version":"1.0.0"}\n');
    assert.equal(workspace.preparations[0]?.toolchain, 'npm');
    assert.equal(
      workspace.preparations[0]?.strategy,
      manager.capabilities().copyOnWrite.available ? 'reflink' : 'install',
    );

    const second = await manager.createWorkspace({
      workspaceId: 'task-1234',
      repository: { ...repository, cloneUrl: fixture.originPath },
      directoryName: 'repository-review',
      branchName: 'review/task-1234',
    });
    assert.equal(second.preparations[0]?.toolchain, 'npm');
    assert.equal(await readFile(join(second.path, 'node_modules', 'local', 'package.json'), 'utf8'), '{"name":"local","version":"1.0.0"}\n');

    for (const entry of [workspace, second]) {
      await manager.removeRepositoryWorkspace({ repositoryId: repository.id, workspacePath: entry.path });
      assert.equal(existsSync(entry.path), false);
    }
    assert.equal(await git(workspace.repository.path, ['branch', '--list', 'work/task-1234']), 'work/task-1234');
    await assert.rejects(
      manager.removeRepositoryWorkspace({ repositoryId: repository.id, workspacePath: fixture.authorPath }),
      /must be below/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('keeps the warm seed on the latest default branch when a workspace uses another base', async () => {
  const fixture = await createRemoteFixture();
  const manager = new WorkspaceManager({ root: fixture.managerRoot });

  try {
    await git(fixture.authorPath, ['switch', '-c', 'release/next']);
    await writeFile(join(fixture.authorPath, 'release-only.txt'), 'release\n');
    await git(fixture.authorPath, ['add', 'release-only.txt']);
    await git(fixture.authorPath, ['commit', '-m', 'add release branch file']);
    await git(fixture.authorPath, ['push', 'origin', 'release/next']);

    await git(fixture.authorPath, ['switch', '-c', 'feature/dependencies']);
    await writeFile(join(fixture.authorPath, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
    await run('npm', ['install', '--package-lock-only', '--ignore-scripts'], fixture.authorPath);
    await git(fixture.authorPath, ['add', 'package.json', 'package-lock.json']);
    await git(fixture.authorPath, ['commit', '-m', 'change npm inputs']);
    await git(fixture.authorPath, ['push', 'origin', 'feature/dependencies']);

    await git(fixture.authorPath, ['switch', 'main']);
    await writeFile(join(fixture.authorPath, 'main-latest.txt'), 'main\n');
    await git(fixture.authorPath, ['add', 'main-latest.txt']);
    await git(fixture.authorPath, ['commit', '-m', 'advance main']);
    await git(fixture.authorPath, ['push', 'origin', 'main']);

    const workspace = await manager.createWorkspace({
      workspaceId: 'review-1234',
      repository: { ...repository, cloneUrl: fixture.originPath },
      branchName: 'review/dependencies-1234',
      mode: 'existing',
      baseBranch: 'release/next',
      remoteBranch: 'feature/dependencies',
    });

    assert.equal(workspace.baseBranch, 'release/next');
    assert.equal(workspace.preparations[0]?.strategy, 'install');
    assert.equal(await git(workspace.path, ['branch', '--show-current']), 'review/dependencies-1234');
    assert.equal(await readFile(join(workspace.path, 'release-only.txt'), 'utf8'), 'release\n');
    assert.equal(existsSync(join(workspace.path, 'main-latest.txt')), false);

    const seedPath = workspace.repository.path;
    assert.equal(await git(seedPath, ['rev-parse', 'HEAD']), await git(seedPath, ['rev-parse', 'origin/main']));
    assert.equal(await readFile(join(seedPath, 'main-latest.txt'), 'utf8'), 'main\n');
    assert.equal(existsSync(join(seedPath, 'release-only.txt')), false);
    assert.equal(await readFile(join(seedPath, 'node_modules', 'local', 'package.json'), 'utf8'), '{"name":"local","version":"1.0.0"}\n');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('stacks a fresh worktree on an unpushed sibling branch', async () => {
  const fixture = await createRemoteFixture();
  const manager = new WorkspaceManager({ root: fixture.managerRoot });

  try {
    const parent = await manager.createWorkspace({
      workspaceId: 'stack-1234',
      repository: { ...repository, cloneUrl: fixture.originPath },
      directoryName: 'repository-parent',
      branchName: 'work/parent',
    });
    await writeFile(join(parent.path, 'parent-only.txt'), 'parent\n');
    await git(parent.path, ['add', 'parent-only.txt']);
    await git(parent.path, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'unpushed parent change']);

    const child = await manager.createWorkspace({
      workspaceId: 'stack-1234',
      repository: { ...repository, cloneUrl: fixture.originPath },
      directoryName: 'repository-child',
      branchName: 'work/child',
      baseBranch: 'work/parent',
    });
    assert.equal(child.baseBranch, 'work/parent');
    assert.equal(await readFile(join(child.path, 'parent-only.txt'), 'utf8'), 'parent\n');

    await assert.rejects(manager.createWorkspace({
      workspaceId: 'stack-1234',
      repository: { ...repository, cloneUrl: fixture.originPath },
      directoryName: 'repository-missing',
      branchName: 'work/missing',
      baseBranch: 'does-not-exist',
    }), /Base branch not found/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('bounds concurrent preparation manager-wide and serializes work per seed clone', async () => {
  const fixture = await createRemoteFixture();
  const probe = concurrencyProbe();
  const manager = new WorkspaceManager({ root: fixture.managerRoot, toolchains: [probe.toolchain], concurrency: 2 });
  const create = (id: string, directoryName: string) => manager.createWorkspace({
    workspaceId: 'multi-repo',
    repository: { ...repository, id, cloneUrl: fixture.originPath },
    directoryName,
    branchName: `work/${directoryName}`,
  });

  try {
    await Promise.all([create('github/example/a', 'a'), create('github/example/b', 'b'), create('github/example/c', 'c')]);
    assert.equal(probe.maximum, 2);

    probe.maximum = 0;
    await Promise.all([create(repository.id, 'one'), create(repository.id, 'two'), create(repository.id, 'three')]);
    assert.equal(probe.maximum, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('fails one repository without affecting concurrent workspaces', async () => {
  const fixture = await createRemoteFixture();
  const manager = new WorkspaceManager({ root: fixture.managerRoot, toolchains: [] });

  try {
    const [available, missing] = await Promise.allSettled([
      manager.createWorkspace({
        workspaceId: 'multi-repo',
        repository: { ...repository, cloneUrl: fixture.originPath },
        directoryName: 'available',
        branchName: 'work/available',
      }),
      manager.createWorkspace({
        workspaceId: 'multi-repo',
        repository: { id: 'github/example/missing', cloneUrl: join(fixture.root, 'missing.git'), defaultBranch: 'main' },
        directoryName: 'missing',
        branchName: 'work/missing',
      }),
    ]);

    assert.equal(available.status, 'fulfilled');
    assert.equal(missing.status, 'rejected');
    assert.equal(existsSync(join(fixture.managerRoot, 'workspaces', 'multi-repo', 'available')), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('refreshes a managed repository to the latest default branch commit', async () => {
  const fixture = await createRemoteFixture();
  const manager = new WorkspaceManager({ root: fixture.managerRoot, toolchains: [] });

  try {
    const managed = await manager.refreshRepository({ ...repository, cloneUrl: fixture.originPath });
    const initialHead = await git(managed.path, ['rev-parse', 'HEAD']);

    await writeFile(join(fixture.authorPath, 'new-file.txt'), 'new\n');
    await git(fixture.authorPath, ['add', 'new-file.txt']);
    await git(fixture.authorPath, ['commit', '-m', 'new commit']);
    await git(fixture.authorPath, ['push', 'origin', 'main']);

    await manager.refreshRepository({ ...repository, cloneUrl: fixture.originPath });

    assert.notEqual(await git(managed.path, ['rev-parse', 'HEAD']), initialHead);
    assert.equal(await readFile(join(managed.path, 'new-file.txt'), 'utf8'), 'new\n');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('repairs the origin URL of an existing managed clone', async () => {
  const fixture = await createRemoteFixture();
  const manager = new WorkspaceManager({ root: fixture.managerRoot, toolchains: [] });

  try {
    const path = manager.repositoryPath(repository.id);
    await mkdir(join(path, '..'), { recursive: true });
    await git(fixture.root, ['clone', fixture.originPath, path]);
    await git(path, ['remote', 'set-url', 'origin', 'https://invalid.example/repository.git']);

    await manager.refreshRepository({ ...repository, cloneUrl: fixture.originPath });

    assert.equal(await git(path, ['remote', 'get-url', 'origin']), fixture.originPath);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

function concurrencyProbe() {
  let active = 0;
  const probe = {
    maximum: 0,
    toolchain: {
      id: 'probe',
      command: 'probe',
      detect: async () => true,
      fingerprint: async () => null,
      artifacts: async () => [],
      async prepare() {
        active += 1;
        probe.maximum = Math.max(probe.maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 200));
        active -= 1;
      },
    } satisfies WorkspaceToolchain,
  };
  return probe;
}

async function createRemoteFixture() {
  const root = await mkdtemp(join(tmpdir(), 'coriol-'));
  const originPath = join(root, 'origin.git');
  const authorPath = join(root, 'author');
  const managerRoot = join(root, 'manager');

  await git(root, ['init', '--bare', originPath]);
  await git(root, ['clone', originPath, authorPath]);
  await git(authorPath, ['config', 'user.email', 'test@example.com']);
  await git(authorPath, ['config', 'user.name', 'Test']);
  await git(authorPath, ['config', 'commit.gpgsign', 'false']);
  await git(authorPath, ['switch', '-c', 'main']);
  await mkdir(join(authorPath, 'vendor', 'local'), { recursive: true });
  await writeFile(join(authorPath, '.gitignore'), 'node_modules/\n');
  await writeFile(join(authorPath, 'package.json'), '{"name":"fixture","version":"1.0.0","dependencies":{"local":"file:vendor/local"}}\n');
  await writeFile(join(authorPath, 'vendor', 'local', 'package.json'), '{"name":"local","version":"1.0.0"}\n');
  await run('npm', ['install', '--package-lock-only', '--ignore-scripts'], authorPath);
  await git(authorPath, ['add', '.']);
  await git(authorPath, ['commit', '-m', 'initial']);
  await git(authorPath, ['push', '-u', 'origin', 'main']);
  await git(root, ['--git-dir', originPath, 'symbolic-ref', 'HEAD', 'refs/heads/main']);

  return { root, originPath, authorPath, managerRoot };
}

async function git(path: string, args: string[]): Promise<string> {
  return await run('git', ['-C', path, ...args], path);
}

async function run(command: string, args: string[], cwd: string): Promise<string> {
  const result = await execa(command, args, { cwd });
  return result.stdout.trim();
}
