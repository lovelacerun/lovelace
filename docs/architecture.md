# Architecture

How Lovelace is put together and where the invariants in
[agents.md](../agents.md) are enforced. Package READMEs hold the details of
each package; this page connects them.

## Processes

```text
 lovelace tui ──┐                       ┌── Jira, GitHub (HTTP)
 lovelace work …┼─ @lovelace/client ──► server ──┼── Coriol (git, npm)
 (agents)       ┘   HTTP on 127.0.0.1   │  SQLite └── herdr CLI + socket events
```

- **server** (`packages/server`) is the only process with side effects. It
  owns `state.db`, the provider cache, Coriol and the Herdr client.
- **TUI** and **CLI** are clients. The CLI starts the server on demand as a
  detached `lovelace server supervise` process, which restarts it when it
  exits or when the macOS system proxy changes, and replaces a server of
  another version.
- **Herdr** is run by the user. It owns the agent processes; Lovelace drives
  it through the `herdr` CLI and follows its socket events.
- **Agents** are ordinary clients: their prompt tells them to run
  `lovelace agent-guide`, and `lovelace work …` resolves their work item
  from the working directory (`GET /work-items/current?path=`).

The server is a trusted, single-user loopback service, not a security
boundary.

## Data model

`state.db` (`packages/server/src/database.ts`):

| Table | Holds |
| --- | --- |
| `work_items` | Title, notes, state (`active`, `done`, `cancelled`) and timestamps |
| `work_item_meta` | Everything attached to a work item, by `meta_type` (below) |
| `work_launch_operations` | One row per launch request ID |
| `work_activity` | Activity events; feeds the "yesterday and today" view |
| `repos` | Repository catalog from the code host |
| `cache_snapshots` | Persisted provider lists, loaded before the first sync |
| `inbox_meta` | Dismissed inbox entries |

Attachment types (`meta_type`): `tracker-item` (Jira issue), `pull-request`,
`change-request` (review request a work item was started from),
`repository` (a worktree and its preparation status), `prompt-draft` (the
exact prompt and selections of a launch), `session` (an agent in Herdr) and
`herdr-workspace`. Payloads are JSON; the types live in
`packages/core/src/types.ts`.

## Provider data

`server/src/cached-providers.ts` wraps the plain Jira and GitHub clients with
`@lovelace/cache`. Lists (assigned issues, review requests) persist and load
on startup, so the TUI has data before the first sync. A scheduled sync
(about every five minutes) refreshes them; request-time reads use the TTL or
peek without network. Failures keep the last good value.

## Worktrees

A work item's worktrees live under `<lovelaceDir>/workspaces/<task-dir>/`,
where the task directory is derived from the work item. Coriol keeps a seed
clone per repository under `repos/`, fetches it to the latest default branch,
adds a worktree on a fresh branch (or a review request's branch) and prepares
npm dependencies, copying the seed's `node_modules` copy-on-write when the
lockfile matches.

Before preparation starts, each selected repository is recorded as a
`repository` attachment with status `pending`; it moves through `preparing`
to `ready` or `failed`, each result saved on its own. Overlapping requests for
the same work item and repository join the one in flight. On startup,
preparations interrupted by a restart become `failed` and can be retried at
the same path. Worktrees of work done or cancelled for a week are removed
only by an explicit `lovelace cleanup`.

## Launching

A launch (`POST /work-items/quick-start` or `/work-items/:id/new-session`)
carries a client-generated request ID.

1. The server records the work item (quick start), the exact prompt and
   selections as a `prompt-draft`, and a launch operation, before anything
   slow or fallible. This is what keeps user input safe.
2. Selected repositories are prepared (see above).
3. The server opens a tab in the work item's Herdr workspace (created on
   first use and tagged `lovelace=<workItemId>`), runs `herdr agent start`
   with native flags only, then `herdr agent prompt`. Nothing is focused.
4. Once Herdr detects the agent, a `session` attachment is recorded and the
   draft marked launched.

Repeating a request ID joins or replays that operation instead of launching
again. Operations still pending when the server stops become `uncertain` and
are never replayed. A failure keeps the work item and the draft for an
explicit retry on the same work item.

This flow is due to be simplified; see [plan.md](../plan.md).

## Sessions

Herdr's agent integrations report each agent's state (`working`, `idle`,
`blocked`, `done`) and native conversation identity. The server mirrors
`herdr pane list` into session attachments whenever Herdr's event stream
reports a change, plus a 15 s poll (3 s while the subscription is down),
because Herdr emits no event for a newly reported identity. A session ends
when its pane is gone or runs something else.

An agent that opens blocked (e.g. a folder trust dialog) still counts as
started; its prompt is submitted once Herdr reports it idle.

**Open** (`POST /work-items/:id/sessions/:metaId/open`) focuses a running
session's tab. For an ended session it resumes the exact recorded
conversation (`claude --resume <id>`, `codex resume <id>`,
`pi --session <file>`) in the pane it left, or a new tab. Without a recorded
identity it fails; it never picks the latest conversation or replays the
prompt.

## Prompts

Built-in templates (`implement`, `review`, `refine`) live in
`server/src/services/prompt-service.ts`; files in `<lovelaceDir>/prompts/`
override or add to them. Templates render `{{title}}`, `{{tracker}}`,
`{{changeRequests}}`, `{{workspaces}}` and `{{lovelace}}`, the block that
tells the agent how to call back (overridable as `agent-context.md`).
Free-text prompts get that block appended at launch.

## Where the invariants live

| Invariant | Enforced in |
| --- | --- |
| Never lose user input | Draft and operation written before side effects (`routes/dashboard.ts`, `services/launch-operation-service.ts`); preparation recovery (`services/work-start-service.ts`) |
| Never launch twice by accident | Request-ID replay and startup recovery (`services/launch-operation-service.ts`) |
| Open never starts fresh | `openSession` in `services/session-service.ts`, `tools/harness-arguments.ts` |
| Lovelace is a guest in Herdr | `herdr/herdr-client.ts`, `herdr/work-item-workspace.ts` |
| Only own clones and worktrees | Coriol (`packages/coriol`) |
| Provider failures keep last-good data | `packages/cache`, `server/src/cached-providers.ts` |
