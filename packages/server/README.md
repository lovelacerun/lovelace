# @lovelace/server

Local HTTP server: SQLite state, provider sync, prompts, Coriol workspaces and
agent sessions in Herdr. The SQLite schema lives in the versioned migrations in
`src/migrations.ts`, tracked by `user_version`. On startup the server backs up an
outdated `state.db` to `backups/state-v<from>-<timestamp>.db` in the Lovelace
directory, applies each pending migration in its own transaction, and refuses a
database from a newer Lovelace. Migrations are append-only. Harnesses are detected by executable only; Lovelace does not
probe their model catalogs.

## Herdr

`src/herdr/herdr-client.ts` runs the `herdr` CLI against the user's running
session (`herdr.executable`/`herdr.socketPath` override the binary and socket).
It never inherits a caller's pane context, starts a Herdr server or closes
workspaces, tabs or panes.

`src/services/session-service.ts` owns sessions:

- Launch: open a shell in the work item's workspace (created on first use,
  recorded as a `herdr-workspace` attachment, tagged `lovelace=<workItemId>`), run
  `herdr agent start` with native flags only, then `herdr agent prompt`. A new
  shell that is not ready yet is retried briefly. An agent that opens blocked
  keeps its prompt pending until Herdr reports it idle.
- Sync: mirror `herdr pane list` into running sessions (agent state, native
  identity reported by Herdr's agent integrations, and the end of the agent)
  whenever Herdr's socket reports agent detection, a pane exit or a status
  change of a running session's pane, coalesced to one sync at a time. Herdr
  emits no event for a reported identity, so a 15 s poll remains, 3 s while the
  subscription is down. Herdr rejects a subscription naming a missing pane, so
  only panes listed at the last sync are subscribed.
- Open: focus a running session's tab, or continue an ended session's exact
  native conversation (`claude --resume`, `codex resume`, `pi --session`) in
  the pane it left or a new tab. Never the latest conversation or the initial
  prompt; sessions without a recorded identity are refused.

Each launch is one row in `launches`, keyed by the client's request ID, with
the exact prompt, selections and a single state (`accepted`, `preparing`,
`starting`, `started`, `failed`, `uncertain`). Resending a request ID joins or
reads that launch instead of launching again; a different request under the
same ID is rejected. Launches left in progress by an earlier server boot become
`uncertain` on startup and are never replayed; so does a launch whose error
came after Herdr may have started the agent.
Quick-start accepts `reviewRequestId` from the cached review requests: the
work item gets the pull request as its `change-request`, and the pull request's
repository, which must be among `repoIds`, is checked out at its branch.
Explicit `repoIds` are prepared with Coriol before launching; preparation
failures preserve the work, exact prompt and template/repository selection.
`POST /launches/:id/retry` runs a `failed` launch again in place: ready
worktrees are reused and failed ones prepared again.
The GitHub catalog includes authenticated repositories across organizations.

Quick-start/new-session optionally accept `wait:false`: return 202 durable
acceptance, then finish repository preparation and Herdr startup in the
background. Work details include their launches and the dashboard the latest
launch state. `GET /launches/:id` reads a launch without launching it.
Independent work items run concurrently; pane allocation alone is serialized
per item to keep one Herdr workspace with distinct tabs.

Worktrees are persisted as `pending` before preparation starts. Coriol
events expose `preparing` and the latest phase; each ready/failed result is
saved independently. Overlapping requests coalesce per work item/repository
(and review source). `POST /work-items/:id/repositories` retains its synchronous
details response by default; `wait:false` returns 202 with recorded details for
polling via `GET /work-items/:id`. Disconnects never cancel preparation.
Orphaned pending/preparing records become retryable failures on server startup;
worktrees and dependency caches are kept. Cleanup skips active preparations.

## Provider cache

`src/cached-providers.ts` wraps the plain GitHub/Jira clients with
`@lovelace/cache`; services and routes use only these accessors.

- Lists (`jira.assigned`, `jira.projects`, `github.reviewRequests`) persist to
  the `cache_snapshots` table and load on startup, so the dashboard renders
  before the first sync. `github.repoCatalog` stays in memory; its durable copy
  is the `repos` table.
- Per-PR/per-issue lookups are cached in memory for a minute to absorb bursts.
- The scheduled sync (`src/sync.ts`) calls `refresh*`, request-time reads use
  `fetch*` (TTL) or `peek*` (no network). Failures keep the last-good value;
  `GET /cache/snapshots` lists the in-memory entries.

Tests use temporary SQLite and an in-memory fake Herdr
(`src/test-support/fake-herdr.ts`). No live agents, models, providers, secrets
or user panes are used.
