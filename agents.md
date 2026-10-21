# Agents Guide

## Product

Lovelace v4 is a local-first developer work orchestrator with a standalone TUI
and thin CLI. One local server owns integrations, work state, workspaces,
prompts and session records. Herdr is the only terminal host: the user runs it,
and the server drives it. Future GUI/editor clients use the same work API.

Preserve these decisions:

1. Clients never call Jira or GitHub directly.
2. The default dashboard shows recent recorded work (yesterday and today) and pending Jira,
   with an editable repository-free quick-start prompt. Quick-start appears
   only on Home, docked at the bottom with three visible input lines (one
   collapsed row on short terminals until focused) above a row of agent,
   thinking and model select fields; Jira prompt editing belongs to the
   start-work overlay. Select fields expand into filterable lists and are
   reached with Tab in reading order, like every other field. Both hosts share
   one choice, remembered for the TUI session.
3. The sidebar defaults to the right (Herdr has its own left sidebar); its side
   is configurable. Active work comes before pending Jira. Narrow (phone)
   terminals hide it and Home lists active work instead.
4. Work-item details show agent sessions first, then Jira/status and PR/status.
5. Session selection hands off to a real terminal. No embedded terminal.
6. Each work item gets its own Herdr workspace and each session a tab in it.
   The server talks to Herdr directly; clients never touch the terminal host.
7. Prompts belong to the user: built-in defaults, overrides under
   `.lovelace/prompts/*.md`, and editable final prompts.
8. Local work state is independent from upstream state.
9. Repository selection is explicit. Jira start uses one native pi-tui overlay:
   name/topic-filtered repository multi-select on the left; template select,
   large editable prompt preview and the agent/thinking/model fields below it
   on the right. Never a sequential wizard.
   Include viewer and owner affiliations in GitHub discovery across organizations.
   Keep the underlying page stable, the prompt editable and Home repository-free.
   No hidden prompt-to-repository inference. Lovelace owns clones; never scan
   or reuse arbitrary local checkouts.
10. Every prepared workspace gets an isolated branch, including review/research.
    Work items can span multiple repositories and sessions; a repository can
    carry several worktrees on distinct branches (e.g. stacked diffs).
11. Human review and bot PR work remain distinct.
12. v4 excludes the macOS app, Kizzy, repository/security dashboards and
    repository-insight modules. Keep the repository catalog for worktree setup.
13. Minor local data loss is acceptable in an early single-user product, but
    never reset user data merely to simplify development. Fix the operator's
    data by hand instead of adding compatibility code.

## Boundaries

- `packages/cache`: generic cache (TTL/SWR, coalescing, injected storage); no
  application or SQLite dependency.
- `packages/github-client`, `packages/jira-client`: plain provider API clients;
  injected transport, no caching or work/session concepts.
- `packages/jira-platform-client`, `packages/jira-software-client`: generated APIs;
  `jira-client` calls the platform client.
- `packages/adf-converter`: independent ADF conversion.
- `packages/secrets`: ordered secret sources (Keychain, 1Password, plaintext,
  credential-helper commands); no application types or config.
- `packages/coriol`: independent managed clones/worktrees; no Jira, DB or sessions.
- `packages/model-catalog`: lists the models a harness accepts from its own CLI;
  no caching or application state (the server caches it with `cache`).
- `packages/core`: application types, config, paths and harness settings.
- `packages/server`: HTTP API, SQLite, sync, prompts, work/session orchestration,
  provider cache wiring (`src/cached-providers.ts`) and the Herdr client
  (`src/herdr`). A library: `startServer()` is started by the CLI.
- `packages/client`: typed HTTP client, reusable by future frontends.
- `packages/tui-components`: generic pi-tui components and text helpers;
  depends only on pi-tui, follows its `Component` and theme-function conventions.
- `packages/tui`: pi-tui dashboard; no provider or persistence logic.
- `packages/cli`: the single `lovelace` executable: noninteractive scripting and
  agent callbacks, plus `server` (foreground, or the on-demand background
  server with its system-proxy supervisor; no login service) and the
  interactive `init`. No-command invocation prints help; TUI launch must be
  explicit. Commands that need the server start it in the background. Homebrew installs its `pnpm deploy`
  tarball from `lovelacerun/homebrew-tap`.

Prefer small focused modules. Extract repetition, not speculative frameworks.
Use trusted dependencies only; pin exact versions in modified/new package
entries. Renovate owns updates.

## State and sync

- Configuration lives in `~/.config/lovelace/config.jsonc`; its `domainRoot`
  (or `LOVELACE_ROOT`) selects the state root. Durable state belongs under
  `<domainRoot>/.lovelace` in SQLite.
- Hydrate memory on startup, then refresh providers roughly every five minutes.
- Prefer stale-while-revalidate; failures retain last-good values.
- Coalesce concurrent refreshes and bound cache growth.
- Record work/session activity for the recent-work summary (yesterday and today,
  local calendar days).
  Never invent elapsed hours or reconstruct v3 history from `updatedAt`.
- No migration code: the schema lives in the `create table` statements.
  Single-user product; update the operator's database by hand when it changes.
- Log structured timestamped events to disk with pino.
- Launch/preparation failures preserve work, exact prompt drafts, template ID
  and selected repository IDs before retry. Ready worktrees are reused.
- Record pending repository metas before preparation, persist progress and each
  result independently, and coalesce in-flight requests per work item/repository
  (and review source). CLI workspace creation polls; stopping its wait never
  cancels server preparation.
- TUI launches return durable acceptance before repository preparation or agent
  startup completes. Close Jira setup on acceptance and show progress/retry on
  the work item. Different tasks can start independently; background completion
  never changes selection, focuses Herdr or mutates another task's draft.

## Repositories and workspaces

Use `@lovelace/coriol` for lazy seed clones under `.lovelace/repos` and direct
Git worktrees under `.lovelace/workspaces`. Fetch/reset the warm seed to the
latest configured default branch before workspace creation, independently of
the requested base branch. Coriol is stateless (the server database records
workspaces), bounds concurrent preparation manager-wide and serializes work on
each seed clone; the server starts all repositories at once.

For now detect npm projects using `package.json` plus `package-lock.json`.
Run `npm ci` when dependency inputs changed and use `@openclaw/fs-safe`
filesystem copy-on-write for warm artifacts where possible. Always prepare
detected toolchains; no per-workspace dependency opt-out. Bootstrap must be
idempotent. Preserve uncertain-write and cleanup protections.

## Sessions and Herdr

- The user installs and runs Herdr and its agent integrations
  (`herdr integration install <agent>`). Lovelace never starts a Herdr server
  or any other multiplexer, and adds no hooks or extensions of its own to the
  agents. The less Lovelace customizes the agents, the better.
- The server drives the running Herdr session through its CLI: one workspace
  per work item (ID recorded as a `herdr-workspace` meta and tagged with a
  `lovelace` token, which Herdr forgets on restart), one tab per session,
  `agent start` for the harness and `agent prompt` for the prompt.
- Herdr owns agent state and native conversation identity. The server mirrors
  `pane list` every few seconds; never reimplement agent hooks or attention
  reporting.
- Auto-detect Pi, Claude Code and Codex executables on the server to offer
  them. No custom tool modules or editors-as-harnesses.
- Keep per-harness model/thinking overrides with drafts and session metadata.
  Empty values preserve harness defaults.
- Do not auto-start/attach all sessions from a work-item snapshot. Launches
  never steal focus.
- Done/cancelled work keeps detached sessions inactive.
- Selecting a session focuses its live pane. Selecting an ended session
  continues its exact native conversation, preferably in the pane it left;
  selecting it is the explicit action, with no extra confirmation.
- Continue only the exact recorded native conversation. A session without a
  recorded native identity cannot be continued; never infer the latest
  conversation, open a picker or replay the initial prompt.
- An agent that opens blocked (e.g. a folder trust dialog) still counts as
  started; its prompt is held back and submitted once Herdr reports it idle.
- Never close Herdr workspaces, tabs or panes the user may still use.
- v4 started from a clean slate: no compatibility code for pre-v4 records,
  references or storage layouts.

## Development safety

Build with `pnpm build` (TypeScript packages only). Tests use temporary state
and a fake Herdr client, never live agent processes or operator panes. Manual
Herdr checks use a separate named session (`herdr --session <name> server`).
Do not restart/install running services during builds. Do not delete
user-local state, installed apps or private automation evidence during code
pruning. Never read secrets merely to run fixture tests.

## Commit and documentation discipline

Follow the `commit-work` skill. Commit meaningful milestones regularly; review
and stage intended paths only. Use concise English Conventional Commits.
When signing is unavailable while the operator is AFK, unsigned commits are
acceptable if explicitly authorized.

For major product/architecture changes update `plan.md`, `readme.md` and
this guide. Keep package READMEs and CLI callback guidance consistent with
implementation and distinguish tested capabilities from planned plugins.
