# @lovelace/server

Local HTTP server: SQLite state, provider sync, prompts, Coriol workspaces and
agent sessions in Herdr. The SQLite schema lives in the create statements; there
are no migrations. Harnesses are detected by executable only; Lovelace does not
probe their model catalogs.

## Herdr

`src/herdr/herdr-client.ts` runs the `herdr` CLI against the user's running
session (`herdr.executable`/`herdr.socketPath` override the binary and socket).
It never inherits a caller's pane context, starts a Herdr server or closes
workspaces, tabs or panes.

`src/services/session-service.ts` owns sessions:

- Launch: open a shell in the work item's workspace (created on first use,
  recorded as a `herdr-workspace` meta, tagged `lovelace=<workItemId>`), run
  `herdr agent start` with native flags only, then `herdr agent prompt`. A new
  shell that is not ready yet is retried briefly. An agent that opens blocked
  keeps its prompt pending until Herdr reports it idle.
- Sync: every three seconds, mirror `herdr pane list` into running sessions:
  agent state, native identity reported by Herdr's agent integrations, and the
  end of the agent.
- Open: focus a running session's tab, or continue an ended session's exact
  native conversation (`claude --resume`, `codex resume`, `pi --session`) in
  the pane it left or a new tab. Never the latest conversation or the initial
  prompt; sessions without a recorded identity are refused.

Launch request IDs make lost replies safe to resend: a matching request joins
or replays its operation, and an operation interrupted by a restart is reported
uncertain instead of launching again. Exact drafts stay pending after failures.
Explicit `repoIds` are prepared with Coriol before launching; preparation
failures preserve the work, exact prompt and template/repository selection.
Retry on the same work item reuses ready worktrees and retries failed ones.
The GitHub catalog includes authenticated repositories across organizations.

Quick-start/new-session optionally accept `wait:false`: return 202 durable
acceptance, then finish repository preparation and Herdr startup in the
background. Default synchronous replies remain unchanged. Existing SQLite
launch rows record `preparing`/`starting` progress in their outcome JSON;
work details expose operation summaries and the dashboard a launch phase.
`GET /launch-operations/:requestId` inspects the exact saved operation
without launching it. Independent work items run concurrently; pane allocation
alone is serialized per item to keep one Herdr workspace with distinct tabs.
Server startup marks orphaned launches uncertain, never replays them.

Repository metas are persisted as `pending` before preparation starts. Coriol
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
