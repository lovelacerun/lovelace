# Architecture

How Lovelace is put together and where the invariants in
[agents.md](../agents.md) are enforced. Package READMEs hold the details of
each package; this page connects them.

## Processes

```text
 lovelace tui ──┐                       ┌── Jira, GitHub (HTTP)
 lovelace work …┼─ @lovelace/client ──► server ──┼── Coriol (git, npm)
 (agents)       ┘   tRPC on 127.0.0.1   │  SQLite └── herdr CLI + socket events
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
  from the working directory (`workItems.current`).

The server is a trusted, single-user loopback service, not a security
boundary.

## Data model

`state.db` (`packages/server/src/database.ts`, schema in the versioned
`packages/server/src/migrations.ts`):

| Table | Holds |
| --- | --- |
| `work_items` | Title, notes, state (`active`, `done`, `cancelled`) and timestamps |
| `work_item_attachments` | Jira issues, pull requests, review requests and the Herdr workspace, by `type` (below) |
| `worktrees` | A work item's worktrees and their preparation status |
| `sessions` | Agents started in Herdr |
| `launches` | One row per launch request ID: the exact prompt, selections and state |
| `work_activity` | Activity events; feeds the "yesterday and today" view |
| `repos` | Repository catalog from the code host |
| `cache_snapshots` | Persisted provider lists, loaded before the first sync |
| `inbox_meta` | Dismissed inbox entries |

Attachments are one discriminated union, `WorkItemAttachment` in
`packages/core/src/types.ts`, keyed by `type`: `tracker-item` (tracker issue),
`pull-request` (tracked change request), `change-request` (review request a
work item was started from), `worktree`, `session` (an agent in Herdr) and
`herdr-workspace`.
`server/src/attachments.ts` is the only place that maps them to and from
rows; work item details carry them typed. Unique indexes allow one
attachment per upstream record and work item, one Herdr workspace per work
item, one live worktree per path and one session per Herdr agent name.

## Provider data

Services use one tracker and one code host (`server/src/providers/types.ts`),
implemented for Jira and GitHub. They return provider-neutral `TrackerIssue`,
`Repository` and `ChangeRequest` records (`packages/core/src/types.ts`);
change requests are keyed `<repository>#<number>`.
`server/src/cached-providers.ts` wraps both with `@lovelace/cache`. Lists (assigned issues, review requests without bots) persist and load
on startup, so the TUI has data before the first sync. A scheduled sync
(about every five minutes) refreshes them; request-time reads use the TTL or
peek without network. Failures keep the last good value.

## Plugins

Company-specific checks run as plugins: executables configured under
`plugins` that read one JSON request on stdin and write one JSON reply on
stdout. The only plugin today is `releaseChecks`
(`server/src/plugins/release-checks.ts`). After each change request sync it
is asked about every merged pull request on an active work item until it
reports the pull request `complete`; the reply is stored as the attachment's
`releaseChecks`, and a failed run keeps the last reply and records the error.

## Worktrees

A work item's worktrees live under `<dataDir>/workspaces/<task-dir>/`,
where the task directory is derived from the work item. Coriol keeps a seed
clone per repository under `repos/`, fetches it to the latest default branch,
adds a worktree on a fresh branch (or a review request's branch) and prepares
npm dependencies, copying the seed's root and nested workspace `node_modules`
copy-on-write when dependency manifests, effective runtime and npm install
configuration match. Installed package versions and workspace links are
validated before successful preparation is recorded. The server injects command environment policy: executable
search paths, Volta shim preference and direnv for npm. Coriol's standalone
default is direct execution with the inherited environment.

Before preparation starts, each selected repository is recorded as a
`worktree` attachment with status `pending`; it moves through `preparing`
to `ready` or `failed`, each result saved on its own. Overlapping requests for
the same work item and repository join the one in flight. Previously ready worktrees
are rechecked on explicit preparation, installing stale dependencies in place
without fetching or changing the checkout. Reading state does not reinstall.
Seed/worktree preparation markers live in Coriol's toolchain cache; old or
missing markers cause a fresh install on the next preparation. On startup,
preparations interrupted by a restart become `failed` and can be retried at
the same path. Worktrees of work done or cancelled for a week are removed
only by an explicit `lovelace cleanup`.

## Launching

A launch (`launches.quickStart` or `launches.newSession`)
carries a client-generated request ID.

1. The server records the work item (quick start) and a `launches` row with
   the exact prompt and selections, before anything slow or fallible. This
   is what keeps user input safe.
2. Selected repositories are prepared (see above); the launch is `preparing`.
3. The launch is `starting`: the server opens a tab in the work item's Herdr
   workspace (created on first use and tagged `lovelace=<workItemId>`), runs
   `herdr agent start` with native flags only, then `herdr agent prompt`.
   Nothing is focused.
4. Once Herdr detects the agent, a `session` attachment is recorded and the
   launch is `started`. An error before Herdr was asked to start the agent,
   or Herdr refusing it, makes it `failed`; any later error makes it
   `uncertain`, since the agent may be running without a session.

Repeating a request ID joins or reads that launch instead of launching again.
Each row records the boot ID of the server that ran it; on startup, launches
still in progress under an earlier boot become `uncertain` and are never
replayed. `launches.retry` runs a `failed` launch again in place
with its saved prompt and selections. The TUI keeps only the prompt,
selections and the request ID of a request that got no answer; before
resending it, it looks the ID up and takes the recorded launch if there is
one.

## Sessions

Herdr's agent integrations report each agent's state (`working`, `idle`,
`blocked`, `done`) and native conversation identity. The server mirrors
`herdr pane list` into session attachments whenever Herdr's event stream
reports a change, plus a 15 s poll (3 s while the subscription is down),
because Herdr emits no event for a newly reported identity. A session ends
when its pane is gone or runs something else.

An agent that opens blocked (e.g. a folder trust dialog) still counts as
started; its prompt is submitted once Herdr reports it idle.

**Open** (`sessions.open`) focuses a running
session's tab. For an ended session it resumes the exact recorded
conversation (`claude --resume <id>`, `codex resume <id>`,
`pi --session <file>`) in the pane it left, or a new tab. Without a recorded
identity it fails; it never picks the latest conversation or replays the
prompt.

## Prompts

Built-in templates (`default`, `implement`, `review`, `refine`) live in
`server/src/services/prompt-service.ts`; files in `<configDir>/prompts/`
override or add to them. `default` is empty, so a prompt starts blank unless
`default.md` overrides it. Templates render `{{title}}`, `{{tracker}}`,
`{{changeRequests}}` and `{{workspaces}}`. Every launch prompt gets the block
that tells the agent how to call back (overridable as `agent-context.md`)
appended.

## Where the invariants live

| Invariant | Enforced in |
| --- | --- |
| Never lose user input | Launch written before side effects (`routes/dashboard.ts`, `services/launch-service.ts`); preparation recovery (`services/work-start-service.ts`) |
| Never launch twice by accident | Request-ID replay (`services/launch-service.ts`) and boot-ID recovery (`database.ts`) |
| Open never starts fresh | `openSession` in `services/session-service.ts`, `tools/harness-arguments.ts` |
| Lovelace is a guest in Herdr | `herdr/herdr-client.ts`, `herdr/work-item-workspace.ts` |
| Only own clones and worktrees | Coriol (`packages/coriol`) |
| Provider failures keep last-good data | `packages/cache`, `server/src/cached-providers.ts` |
