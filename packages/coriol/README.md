# Coriol

Coriol manages local seed clones and isolated, dependency-warm Git workspaces.
It has no knowledge of work trackers, application databases, or agent sessions.

## API

```ts
import { WorkspaceManager } from '@lovelace/coriol';

const manager = new WorkspaceManager({ root: '/path/to/coriol', concurrency: 3 });

const results = await Promise.allSettled(
  ['service-a', 'service-d'].map((name) =>
    manager.createWorkspace({
      workspaceId: 'my-task',
      repository: {
        id: `github/example/${name}`,
        cloneUrl: `https://github.com/example/${name}.git`,
        defaultBranch: 'main',
      },
      branchName: 'work/my-task',
    }),
  ),
);
```

`createWorkspace` prepares one repository worktree below
`workspaces/<workspaceId>/` and rejects on failure. Callers start several
repositories concurrently; the manager bounds clone, fetch, worktree and
toolchain work with one manager-wide limit (`concurrency`, default 3) and
serializes all work on the same seed clone.

The manager also exposes `refreshRepository`, `removeRepositoryWorkspace`,
`repositoryPath` and `capabilities`. `refreshRepository` fetches and resets the
managed seed checkout to the latest configured default branch.
`removeRepositoryWorkspace` refuses paths outside `workspaces/`.

## Storage

Coriol owns the following entries below its configured root:

```text
root/
  repos/        # managed seed clones
  workspaces/   # direct worktrees grouped by workspace id
  toolchains/   # warm-toolchain fingerprints
```

Coriol keeps no registry: paths derive from repository and workspace ids, and
callers record the workspaces they create. It never scans for or adopts
arbitrary checkouts outside that root.

## npm preparation

The default toolchain recognizes repositories containing both `package.json`
and `package-lock.json`.

1. The managed seed is fetched and reset to the latest configured default branch, independently of the workspace's base branch.
2. Coriol runs `npm ci` when the seed's npm fingerprint is not warm.
3. It creates a normal Git worktree directly at the public workspace path.
4. When the target branch has the same fingerprint, Coriol materializes the
   seed's `node_modules` with `@openclaw/fs-safe` copy-on-write cloning.
5. If cloning is unsupported or the fingerprints differ, it runs `npm ci` in
   the worktree.

Toolchain preparation is automatic for every workspace; callers cannot disable
it per workspace.

When `direnv` is available, Coriol runs toolchain commands with `direnv exec`
so credentials and other project environment variables apply to both managed
seeds and worktrees. Without `direnv`, it executes commands directly.

Additional ecosystems can implement `WorkspaceToolchain` and be supplied in the
manager options. User-owned ignored files such as `.env` should eventually be
handled by a separate explicit artifact policy rather than being inferred.
