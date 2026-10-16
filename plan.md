# Lovelace v4

## Direction

Lovelace is a local-first work orchestrator with a terminal dashboard, not an
agent terminal emulator. One local server remains the integration hub, so future
VS Code or native clients can use the same state and API.

The v4 product surface starts fresh. Preserve the tested Coriol worktree manager,
ADF converter, generated Jira APIs, local state, prompts and detached session
engine rather than rewriting reliable infrastructure.

## Main flows

### Dashboard

- Default view: recent (yesterday and today) recorded local work and pending assigned Jira issues
  in two columns.
- An editable prompt below creates an active work item without repositories and
  starts the configured default agent.
- Right sidebar: active work, then pending Jira. Sidebar side is configurable.
- Do not infer repositories from the prompt. Agents attach Jira issues, PRs and
  managed worktrees as the task develops.
- Treat offline/stale provider data as useful state with visible freshness.

### Start Jira work

- Keep repository-free quick-start on Home only, bottom-docked with three
  visible input lines. Jira details have no separate prompt editor.
- Open one native pi-tui overlay without navigating away from Jira details.
- Left: repository multi-select with separate name/topic filters. Right: inline
  built-in/user/manual template select, a large editable prompt preview and
  agent/thinking/model select fields below it.
- Catalog discovery includes both viewer and owner affiliations across organizations;
  do not accept GitHub's owner-only default as the accessible repository catalog.
- Name terms intersect; comma-separated topics are alternatives. Filtering
  never clears hidden selections. Archived repositories can explicitly be included.
- Enter edits newlines in the prompt. Start/Cancel stay in the same modal;
  closing it retains the draft and underlying page. No sequential wizard.
- Keep the final rendered prompt editable. Persist its exact text, template ID
  and repository IDs before preparing isolated worktrees and launching.
- Close the start-work overlay on durable acceptance, not after preparation or
  agent startup. Progress/failures appear on the saved work item; another task
  can start immediately and background completion never moves focus.
- A preparation failure retains the work/draft; retry on the same work item,
  reusing ready worktrees and preparing failed ones again.
- Home quick-start remains repository-free. No repository inference.

### Work item

- Agent sessions come first. Work-item details have no prompt input; the
  quick-start dock appears only on Home.
- Below: attached Jira issues and status alongside GitHub PRs and review/build
  status.
- Local active/done/cancelled state is independent of upstream state.
- Session selection hands off to its real terminal. Never embed a terminal in
  the dashboard.
- Herdr is the only terminal host. Each work item gets a Herdr workspace and
  each session a tab in it; the user runs Herdr, the server drives it.
- Selecting a session focuses its live pane. Selecting an ended session
  continues its exact conversation (the selection is the explicit action).
- Never launch another agent just to attach a terminal.

### Launch and retry

- Keep the final prompt editable before launch.
- Persist work and the exact prompt before fallible agent startup.
- TUI launch requests return acceptance immediately; the server owns background
  completion and exposes per-operation progress. Default synchronous API replies
  remain available. Retry a failed saved prompt on its original work item;
  uncertain operations never automatically replay after restart.
- An unavailable agent must leave a visible, retryable work item rather than
  lose the prompt or create duplicates.
- Harness options and exact native continuation are supported. Sessions without
  a recorded native identity cannot be continued; nothing guesses the latest
  conversation.
- The server starts agents through Herdr (`agent start`, then `agent prompt`)
  and records a session once Herdr detects its agent. A failed start keeps the
  exact prompt draft pending for an explicit retry; request IDs make lost
  replies safe to resend without a second launch.
- Herdr's agent integrations report agent state and native conversation
  identity; the server mirrors them instead of running its own hooks.
- Every prepared repository workspace gets its own isolated branch.
- Workspace creation records pending/preparing state before completion,
  coalesces overlapping requests and saves each result independently. The CLI
  polls short HTTP requests, preserves final JSON and provides an inspection
  command when waiting is interrupted; dependency cache reuse stays in Coriol.

## Package boundaries

- `cache`: independent bounded cache with TTL/stale-while-revalidate, refresh
  coalescing, last-good retention and an injected storage adapter.
- `github-client`, `jira-client`: plain provider API clients without caching or
  work-item/session/SQLite logic; the server composes them with `cache`.
- `jira-platform-client`, `jira-software-client`: retain generated API clients;
  `jira-client` builds on the platform client.
- `adf-converter`: retain independent document conversion.
- `coriol`: retain independent managed clones/worktrees/toolchain preparation.
- `model-catalog`: lists a harness's models from its own CLI; the server caches it.
- `core`: application contracts, configuration, paths and harness settings.
- `server`: local state, background sync, prompts, orchestration and HTTP API.
- `client`: typed server API for terminal and future GUI/editor clients.
- `tui-components`: generic pi-tui components, independent of Lovelace.
- `tui`: standalone pi-tui application.
- `cli`: noninteractive scripting and agent callbacks; no command prints help.
  The TUI is launched explicitly.

## Explicit removals

The macOS/libghostty client, Kizzy automation, repository dashboard, security
dashboard and repository-insight UI are out of v4. Repository catalog discovery
still exists because attaching managed worktrees needs it. Attached PR tracking
and optional user-owned release checks remain.

Do not delete installed applications, running services or user-local
`.lovelace` data as part of removing repository code. External automation can
later dispatch work through the server API.

## State and refresh

- SQLite under `<domainRoot>/.lovelace` is durable state; config lives in
  `~/.config/lovelace/config.jsonc`.
- Load persisted provider lists before background refresh, roughly every five minutes.
- Coalesce provider refreshes and keep last-good data on failures.
- Record meaningful local work/session activity durably for the recent-work summary.
  Do not infer elapsed work time from timestamps or pretend v3 history was
  recorded.
- Preserve existing work items and sessions. Additive schema changes only; no
  elaborate migrations or orphan-branch data reset needed.

## Terminal framework and integration

Use `@earendil-works/pi-tui` for a Node/pnpm application. OpenTUI is a possible
future alternative, but its current native runtime requirements would introduce
an unnecessary runtime change.

Herdr is the terminal host, not the integration hub. The user runs Herdr and
installs its agent integrations; Lovelace's server drives the running session
through the Herdr CLI and never starts a Herdr server itself. The TUI can browse
work without Herdr, but launching and opening sessions requires it. The server
stores session records and native identity, not interactive processes.

## Delivery milestones

- [x] Safe package-only build and preservation of the v3 worktree change.
- [x] Extract and test cache/provider packages.
- [x] Prune unused product code and add dashboard/quick-start/session APIs.
- [x] Build the thin client, responsive dashboard and terminal handoff.
- [x] Restore Jira prompt-template selection and name/topic-filtered repository
  multi-selection, backed by the authenticated GitHub catalog.
- [x] Integrate CLI entry points and update setup documentation.
- [x] Verify the initial terminal-first implementation with fixture tests.
- [x] Move terminal process ownership to user-provided hosts and restore a
  noninteractive CLI default.
- [x] Remove pre-v4 compatibility code (legacy references, Pi user storage,
  history picker, migrations).
- [x] Improve TUI spacing, hierarchy, colors and actionable connection states.
- [x] Reverify builds, unit/API tests and isolated host/PTY flows.
- [x] Make Herdr the only terminal host: per-work-item workspaces, server-side
  launch/focus/continuation, Herdr-reported agent state and native identity.
  Drop tmux/command adapters, dispatch reconciliation, agent hooks and the Pi
  extension.

The authenticated GitHub catalog and native-modal repository filtering and
selection were verified read-only against the local server. Live Herdr,
Jira provider behavior and native harness continuation still require operator
verification; fixture tests do not exercise those integrations.

## Later, not v4 blockers

- Security, PR review and other dashboard sections.
- External service dispatch protocols beyond the existing HTTP API.
- Richer Herdr integration: workspace metadata (Jira/PR status), Herdr
  notifications, status subscriptions instead of polling.
- VS Code or another native client.
- Time tracking and generated standup prose beyond recorded local activity.
