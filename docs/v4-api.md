# v4 client/server contracts

The local server owns provider sync, work state, Coriol workspaces, prompts and
session records, and drives the user's running Herdr session. It does not own
running agents: Herdr does. Clients never talk to Herdr. Shared wire types live
in `packages/core/src/{dashboard,herdr,types}.ts`; `@lovelace/client` provides
typed HTTP access.

## Work endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /dashboard` | Recent recorded work, active work, pending Jira, settings/freshness |
| `GET /work-items` | Raw `WorkItem[]`, optionally filtered by local state |
| `GET /work-items/:id` | Work details and session records |
| `POST /work-items/quick-start` | Persist active work, prepare explicit repositories if selected, launch its first session |
| `POST /work-items/:id/new-session` | Launch another session on active work |
| `GET /launch-operations/:requestId` | Inspect the exact saved launch without executing it |
| `POST /work-items/:id/sessions/:metaId/open` | Focus the session in Herdr, or continue its ended conversation |

`GET /dashboard` includes `settings.repositoryTopics`, the server-resolved
`github.repositoryTopics` used to initialize the editable Jira topic filter.
An empty list means no initial filter; it does not restrict the repository catalog.

`GET /repos` returns the server-cached authenticated GitHub catalog, including
names and topics across organizations. `GET /prompts` lists built-in/user
prompt templates; `POST /prompts/render` renders a template for final editing.
`POST /repos/sync` explicitly refreshes that catalog through the server. The
TUI uses these routes in one Jira start-work overlay with repository selection
and editable prompt preview side by side. Repository/Jira/PR
attachment, work-state and agent callbacks also remain available through the CLI.
No-command `lovelace` prints help;
`lovelace tui` explicitly opens the dashboard. See
[`packages/cli/SKILL.md`](../packages/cli/SKILL.md).

## Workspace preparation

`POST /work-items/:id/repositories` accepts `{repositories,wait?}`.
Omitting `wait` (or `true`) preserves the synchronous 200 `WorkItemDetails`
response. `wait:false` returns 202 `WorkItemDetails` after recording all
selected repository metas, before provisioning completes. Poll
`GET /work-items/:id`; metas have stable IDs and paths, with
`pending | preparing | ready | failed | cleaned` status and optional
`preparationStep`/`errorMessage`. Each repository result commits independently.

Repeated/overlapping requests join active preparation for the same work
item/repository/review source. The initial selection owns an in-flight
workspace; ready workspaces are reused and explicit retries reprepare failed
ones at the same path. Disconnecting or cancelling a client wait does not cancel
preparation. Server startup marks orphaned preparations failed without removing
their worktrees or caches. The CLI polls with bounded short HTTP requests;
stdout remains `{workItem,repositories}` and partial failure remains data.
An interrupted wait directs the caller to `lovelace work-items workspaces <id>`.

## Launch

Quick-start accepts `{prompt,jiraIssueId?,agentId?,options?,repoIds?,promptId?,requestId?,wait?}`;
new-session accepts `{prompt,agentId?,options?,repoIds?,promptId?,requestId?,wait?}`.
`repoIds` are explicit catalog IDs (unique, at most 100); omitted/empty selects
no new repositories. `promptId` records template provenance; `prompt` remains
the exact edited text, not an instruction to re-render. Both answer
`{details,launch:{ok,error,phase?},operation?}`.

By default these calls wait and return the final 200 response. `wait:false`
returns 202 once work, its exact draft and request identity are durable; the
server continues preparation and startup independently of the client.
`wait` is transport behaviour, not part of the frozen launch identity. A
completed replay returns 200, even with `wait:false`.

Pending phases are `accepted`, `preparing` and `starting`, with
`operation.status:'pending'`, `launch.ok:false` and `error:null` (not a failure).
Final phases are `started`, `failed` or `uncertain`. Inspect by exact UUID via
`GET /launch-operations/:requestId`, or poll work details, which include optional
`launchOperations` summaries (`requestId`, `draftMetaId`, `status`, `launch`).
The dashboard adds `launchPhase` for active/unsuccessful launches. Orphaned
launches are marked uncertain on server startup; status lookup never starts an
agent.

The TUI requests acceptance, closes the Jira overlay and opens the saved work
item immediately. Preparation/startup progress and failed-draft retry belong
to that item. It can start another task while earlier launches remain pending;
completion never navigates or focuses Herdr. Failed retries use the saved
prompt, template, repositories and harness options on the same item. Quitting
or losing a progress read does not cancel accepted work.

1. Generate a UUID per deliberate intent; freeze its body/endpoint across an
   uncertain reply. A repeated matching intent joins or replays the durable
   operation without launching again. Conflicting UUID reuse returns 409.
2. The server persists work, intent and the exact operation-scoped draft before
   preparing repositories or touching Herdr. Blank validation must not trim the
   prompt. Selected repositories get isolated fresh branches through Coriol;
   ready worktrees are reused on retry, failed ones are prepared again. A
   preparation failure returns persisted work and its pending exact draft,
   without launching the agent. Repository/template selection belongs to the
   frozen request identity too.
3. The server opens a shell in the work item's Herdr workspace: the workspace
   is created on first use (recorded as a `herdr-workspace` meta and tagged
   with a `lovelace=<workItemId>` token) and later sessions get their own tab.
   A recorded workspace that is gone or tagged for another work item is
   replaced. Pane allocation is serialized per work item so concurrent launches
   share its workspace; agent startup and different work items remain concurrent.
   Nothing is focused.
4. `herdr agent start` runs the harness with native flags only (model/thinking
   overrides; Claude also gets a chosen `--session-id`), then `herdr agent
   prompt` submits the prompt with the Lovelace context block.
5. The session meta is recorded once Herdr detected the agent: `terminalRef`
   `{workspaceId,paneId}`, Herdr `agentName`, `status`/`agentState` and any
   native identity Herdr already reports. The draft is marked launched.

A failed start (`phase:'failed'`) keeps the work item and the exact pending
draft for an explicit retry with a new request UUID on the **same work item**;
the shell tab it may have opened stays for inspection. An agent that opens
blocked (Herdr's `agent_not_ready`, e.g. a folder trust dialog) counts as
started: its prompt is kept with `promptPending:true` and submitted by the
session sync once Herdr reports the agent idle. Operations still pending after
a server restart are reported `uncertain` and never replayed. Clients never
automatically retry mutation calls.

## Session state

Herdr's agent integrations (`herdr integration install <agent>`) report agent
state and the native conversation. Every three seconds the server reads
`herdr pane list` and mirrors it into running sessions:

- `agentState`: Herdr's `idle`, `working`, `blocked`, `done` or `unknown`,
  plus Lovelace's `starting` and `ended`.
- `nativeSessionId` (Claude, Codex) or `nativeSessionPath` (Pi) as reported.
- `status:'ended'` once the pane is gone or no longer runs this session's
  harness. Another agent in the same pane is not this session.

Working agents record one `session.worked` activity per session and local day;
state changes record `session.state-changed`.

## Opening and continuation

`POST .../open` → `{action:'focused'|'continued', details}`. Active work is
required (409 otherwise); done/cancelled work must be explicitly
reactivated first. The server re-reads Herdr first:

- A running session's tab is focused. No agent is started.
- An ended session continues its **exact** recorded conversation
  (`claude --resume <id>`, `codex resume <id>`, `pi --session <file>`), in the
  pane it left while that shell is idle, otherwise in a new tab of the work
  item's workspace, and that tab is focused. The initial prompt is never
  replayed.
- Without a recorded native identity the request returns 409 ("No native
  conversation was recorded for this session"). Lovelace never selects the
  latest conversation or uses `--continue`/`--last`.

Concurrent opens of one session are serialized. Herdr failures return 502 with
Herdr's message.

## Herdr access

The server runs the `herdr` CLI found on its search path, or
`herdr.executable`, against the default Herdr session or `herdr.socketPath`.
It never inherits a caller's Herdr pane context, never starts a Herdr server and
never closes workspaces, tabs or panes.

## Activity, models and safety

Recent work spans the previous and current server-local calendar day
(midnight yesterday until now, DST-aware), using only
durable recorded activity. Work/completion counts deduplicate; cancellation is
separate. No elapsed hours or pre-v4 history are inferred from timestamps.
Provider snapshots hydrate before background refresh; force sync contacts the
provider, failed/partial fetches retain last-good values and memory is bounded.
Cleanup is explicit, preserving retention and uncertain-write protections.

The server detects installed harness executables. `GET /tools` lists them with
each harness's model catalog (`@lovelace/model-catalog`: `pi --list-models`,
`codex debug models`, Claude Code's aliases), cached for an hour, persisted and
revalidated in the background; a catalog that cannot be listed is empty. The
catalog only suggests: model/thinking overrides stay opaque, so any other model
name is accepted.

The server is a trusted-local single-user loopback service, not a multi-user
security boundary. Tests use fake transports and a fake Herdr client; changes to
the Herdr integration need a manual check against a separate named Herdr
session.
