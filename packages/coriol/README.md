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
  toolchains/   # warm-toolchain fingerprints, unless `toolchainsDirectory` moves them
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

## Environment policy

By default, Coriol executes Git and npm directly with the inherited environment.
It does not discover direnv or Volta, read application configuration, or rewrite
PATH. Callers can inject a per-manager `environmentPolicy`:

```ts
const manager = new WorkspaceManager({
  root: '/path/to/coriol',
  environmentPolicy: (request) => ({
    ...request,
    ...(request.kind === 'toolchain' ? {
      command: '/usr/local/bin/direnv',
      args: ['exec', request.cwd, request.command, ...request.args],
    } : {}),
    env: { ...process.env, PATH: '/custom/bin:/usr/bin:/bin' },
  }),
});
```

The policy receives `{ command, args, cwd, kind }` (`git` or `toolchain`) and
returns the command to execute, synchronously or asynchronously. An explicit
`env` replaces the inherited environment; omitting it inherits normally.
Policies cover the manager's built-in Git and npm commands, including seed
preparation, and stay isolated across concurrent managers without changing
`process.env`. Custom toolchains own their own command execution.

Additional ecosystems can implement `WorkspaceToolchain` and be supplied in the
manager options. User-owned ignored files such as `.env` should eventually be
handled by a separate explicit artifact policy rather than being inferred.

## Package

ESM on Node 24 or newer. The public entry point exports `WorkspaceManager`,
`npmToolchain` and their types, including `CommandEnvironmentPolicy` and
`WorkspaceCommand`. There are no Lovelace workspace dependencies.

Build and pack from the repository root:

```sh
pnpm --filter @lovelace/coriol build
pnpm --filter @lovelace/coriol pack --pack-destination /tmp/coriol-pack
```

The clean tarball contains JavaScript, declarations, source maps, sources,
README and MIT license; tests are excluded. Packing does not publish it.
Whether Coriol is released separately remains a product decision.
