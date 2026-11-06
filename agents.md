# Working on Lovelace

Read [readme.md](readme.md) for what Lovelace is. This file covers the rules
for changing it; [docs/architecture.md](docs/architecture.md) explains how the
pieces fit together and [docs/decisions.md](docs/decisions.md) why.

## Commands

```sh
pnpm build
pnpm test
pnpm --filter @lovelace/<package> test
pnpm dev:server              # server from the checkout, in the foreground
pnpm tui
pnpm restart:server          # pick up a new build in the background server
```

Builds never install or restart anything; restart the server explicitly
instead of starting a second one.

A change is done only after `pnpm build && pnpm restart:server` has run and
the behaviour has been checked in the running server, TUI or CLI. Stop any dev
servers you started. For manual Herdr checks use a separate named
session (`herdr --session <name> server`), never the user's own.

Releases: push a `v<version>` tag matching `packages/cli/package.json`; CI
attaches the tarball to a GitHub release. Then update the formula in
[lovelacerun/homebrew-tap](https://github.com/lovelacerun/homebrew-tap).

## Boundaries

- **The server owns all side effects.** Only `server` calls Jira, GitHub,
  Herdr and Coriol. `tui` and `cli` go through `client` and never import
  provider clients. `client` imports only the `AppRouter` type from
  `server`; new procedures need no client code.
- **Standalone packages stay standalone.** `coriol`, `cache`, `secrets`,
  `jira-client`, `github-client`, `model-catalog`, `tui-components` and
  `adf-converter` import no Lovelace types, configuration, database or
  environment variables. Callers inject credentials, transports and storage.
- **Coriol knows nothing about work.** It manages clones, worktrees and
  toolchains by repository and workspace ID. Work items, sessions and
  trackers stay in the server. The server injects command environment policy
  (direnv, Volta, PATH); Coriol defaults to direct, inherited execution.
- **Lovelace is a guest in Herdr.** It never starts the Herdr server, never
  inherits a caller's pane, and never closes workspaces, tabs or panes.
- **Leave the agents alone.** Lovelace adds no hooks or extensions to the
  harnesses. Agent state and conversation identity come from Herdr's
  integrations; prefer Herdr features over reimplementing them.

## Invariants

- **Never lose user input.** A prompt and its selections (template,
  repositories, agent, options) are persisted before any slow or fallible
  step (cloning, installing, starting an agent). A failure leaves them
  available for retry on the same work item; it never requires deleting the
  work item or its directories by hand.
- **Never launch twice by accident.** A lost reply or server restart must not
  silently start another agent. Ask the user to inspect instead.
- **Open never starts fresh.** Opening a session focuses its live pane or
  resumes its exact recorded conversation; without a recorded conversation it
  fails.
- **Launches never steal focus.** Background completion never changes the
  user's selection or focuses Herdr.
- **Repositories are chosen explicitly.** No inferring repositories from a
  prompt. Lovelace works only in its own clones and worktrees, never in
  checkouts it didn't create. Every worktree gets its own branch.
- **Local state is separate from upstream state.** Work-item state, title and
  notes never change the Jira issue or pull request.
- **Provider failures keep last-good data.** Reads never return partial lists
  or empty lists for errors.

## Data

SQLite at `<dataDir>/state.db`, defined in
`packages/server/src/database.ts`. Other people run Lovelace, so schema and
stored-data changes must upgrade existing databases in place without losing
data: add a new migration to `packages/server/src/migrations.ts`, never edit a
released one. Never ask users to edit or reset their database. Never delete user-local
state (config, data, state and cache directories, worktrees, logs) while changing code.

## Tests

Tests never touch live providers, agents, models, secrets, browsers or the
user's Herdr panes. Use temporary SQLite, the fake Herdr in
`packages/server/src/test-support/`, injected transports and temporary config.

## Conventions

- TypeScript, ESM, Node 24. Pin exact dependency versions.
- Small focused modules. Extract repetition, not speculative frameworks.
- Replacing something means deleting the old version in the same change: no
  compatibility shims, adapters or fallbacks unless asked.
- Company- or team-specific behaviour (release tags, topics, hosts) lives in
  config or `examples/`, never in core code or defaults. Only the server
  caches; clients never keep their own cache.
- Prefer `@nkzw/core` helpers and generated provider clients over hand-written
  ones; import types instead of copying them.
- Detail/start pages show creation and last-change timestamps using native
  `Intl`: relative through seven days, then local date and time. Keep them
  out of lists and the sidebar; upstream times are not cache-refresh times.
- Conventional Commits in English.
- Keep package READMEs in sync with behaviour; they are the reference for
  their package. Product or architecture changes also update `readme.md`,
  this file and `plan.md`.
