# Lovelace v4

Local-first work orchestration for developers who live in a terminal.

Lovelace combines a **terminal dashboard**, a **noninteractive agent CLI** and
one **local server**. The server owns Jira/GitHub access, durable work state,
managed worktrees, prompts and session records. [Herdr](https://herdr.dev) runs
the agents: every work item gets its own Herdr workspace. Future VS Code or GUI
clients can use the same API.

## Workflow

- See recent recorded work (yesterday and today) and pending assigned Jira.
- Enter an editable prompt to create work and start your default agent in the
  work item's Herdr workspace. No repositories need to be selected first.
- Quick-start is Home-only: a bottom-docked editor with three visible input lines
  above agent, thinking and model select fields (model names come from the harness).
- Starting a Jira issue opens one overlay: repository multi-select with name/topic
  filters on the left; templates and a large editable prompt preview on the right.
  The server prepares the selected worktrees before an explicit launch.
- Agents can also discover repositories and attach managed worktrees, Jira issues and PRs.
- The right sidebar lists active work and waiting Jira; its side is configurable.
- Work details show sessions first, then attached Jira and PR/review/build status.
- Selecting a live session focuses its Herdr tab; selecting an ended one
  continues its exact conversation. No embedded emulator or replacement agent.
- Mark work done locally, independently of whether its Jira issue or PR is closed.

## Install

```sh
brew install lovelacerun/tap/lovelace
lovelace init
```

Homebrew brings Node 24 and [Herdr](https://herdr.dev). Install an agent CLI
(`pi`, `claude` or `codex`) yourself, and optionally `gh` (to borrow its GitHub
login) and the 1Password CLI `op`. You run Herdr yourself; Lovelace never starts
it. Browsing work and using the scripting CLI work without Herdr.

`lovelace init` checks these tools and each agent's Herdr integration
(`herdr integration install <agent>`), writes `~/.config/lovelace/config.jsonc`
(keeping comments and settings it does not ask about), stores tokens in the login
Keychain (you type them into `security`, not into Lovelace) and finds your Jira
cloud ID. It then installs a LaunchAgent that keeps the server running, which
restarts the server when the macOS system proxy changes. Rerun it any time.

```sh
lovelace tui                     # open the dashboard, preferably inside Herdr
lovelace service status          # restart | install | uninstall
lovelace server                  # run the server in the foreground instead
```

After `brew upgrade lovelace`, run `lovelace service restart`.

## Develop

Requirements: **Node 24+** and **pnpm 10.12.2** (the repository pins Node
24.21.0 for Volta users). State uses Node's built-in `node:sqlite`; there are no
native dependencies to rebuild.

```sh
pnpm install
pnpm build
pnpm dev:server
# In another terminal, preferably inside Herdr:
pnpm tui
```

`pnpm install:macos-service` points the LaunchAgent at the checkout instead.
After a build, explicitly run `pnpm restart:macos-service` rather than starting
a second server. Builds never install applications or restart services.

```sh
pnpm cli                         # help, never an interactive UI
pnpm cli -- status               # JSON
pnpm cli -- dashboard            # JSON dashboard API
pnpm cli -- work-items list
pnpm cli -- tui --sidebar left   # explicit interactive UI
pnpm dev:tui                     # TUI development
pnpm test
pnpm test:tui-pty                 # optional Python 3 PTY fixture smoke
```

`lovelace` without a command prints help. Agent callbacks always use explicit
CLI commands; only `lovelace tui` or `pnpm tui` opens the dashboard.

Pushing a `v<version>` tag that matches `packages/cli/package.json` builds the
release tarball (`pnpm deploy` of the CLI with its production dependencies)
and attaches it to a GitHub release; then update the formula in
[lovelacerun/homebrew-tap](https://github.com/lovelacerun/homebrew-tap).

## Configuration

`lovelace init` writes the essentials. For everything else, see
`examples/dot-lovelace/config.jsonc.example`. The file lives at
`~/.config/lovelace/config.jsonc` (`$XDG_CONFIG_HOME/lovelace/config.jsonc`
when set; `LOVELACE_CONFIG` selects another file). Its `domainRoot` chooses
where clones and state live (`~` is expanded); `LOVELACE_ROOT` overrides it, and
both default to `~/projects`.

```jsonc
{
  "defaultAgent": "pi",
  "tui": { "sidebarSide": "right" },
  "syncIntervalMs": 300000,
  "github": {
    "host": "github.com", "org": "your-org", "account": "your-login",
    "repositoryTopics": ["infra", "examplecom"]
  },
  "jira": {
    "baseUrl": "https://your-company.atlassian.net",
    "email": "you@example.com"
  }
}
```

`github.repositoryTopics` prepopulates the editable Jira repository topic filter;
without configuration (or with `[]`) there is no initial filter.
`GITHUB_REPOSITORY_TOPICS` overrides it.
Select all adds filtered matches; Unselect all clears every selected repository.

The server finds `herdr` on its search path and uses Herdr's default session.
Optional `"herdr": { "executable": "/abs/path/herdr", "socketPath": "/abs/path/herdr.sock" }`
selects another binary or a named session's socket.

Keep credentials outside source control. Provider configuration accepts
`GITHUB_TOKEN`, `GITHUB_ORG`, `GITHUB_HOST`, `JIRA_BASE_URL`,
`JIRA_SITE_URL`, `JIRA_EMAIL` and `JIRA_API_TOKEN`.

### Provider tokens

Only the server reads tokens, once at startup, in this order:

1. macOS Keychain: generic password with service `lovelace` and account
   `github-token` or `jira-api-token`. Store one (you are prompted for the value):
   `security add-generic-password -s lovelace -a github-token -w`
2. 1Password: a `GITHUB_TOKEN`/`JIRA_API_TOKEN` (or `github.token`/`jira.apiToken`)
   value of the form `op://vault/item/field`, read with `op read`.
3. The plaintext value itself (fine for development, not for shared machines).
4. GitHub only: the GitHub CLI login of `github.account` (`gh auth login`,
   stored in the Keychain by `gh`). Set the account explicitly, e.g.
   `"account": "your-login"`; Lovelace never follows `gh auth switch`.

Lovelace only reads from the providers; clones use your own git credentials.

- GitHub: nothing beyond `gh auth login`; its token has `gh`'s broad scopes
  (`repo`, `read:org`, `gist`). For least privilege, configure a fine-grained
  personal access token for the organization instead, with read-only **Metadata**, **Pull requests**, **Commit statuses** and **Checks**.
  Fine-grained tokens cover one owner, so repository discovery stays within it.
- Jira: an Atlassian API token *with scopes*, scope `read:jira-work` only. Scoped
  tokens require `jira.baseUrl` = `https://api.atlassian.com/ex/jira/<cloudId>`
  (cloud ID from `https://<site>.atlassian.net/_edge/tenant_info`) and
  `jira.siteUrl` = `https://<site>.atlassian.net` for browser links.

Override launch/sidebar defaults with `LOVELACE_DEFAULT_AGENT` and
`LOVELACE_TUI_SIDEBAR`. The TUI draws Nerd Font icons; set `tui.icons` to
`unicode` (or `LOVELACE_TUI_ICONS=unicode`, or `--icons unicode`) for terminals
without one, e.g. a phone SSH client. Its Gruvbox theme defaults to dark;
`tui.theme`, `LOVELACE_TUI_THEME` or `--theme` select `light`, and
`tui.colors.dark`/`tui.colors.light` override individual colours (see
`packages/tui/README.md`). The local server listens on
`127.0.0.1:27421` by default; `LOVELACE_PORT` overrides it for clients and
callbacks too. A stale override can point the TUI at the wrong port. The header
shows the actual client address on wide terminals.

## Prompts and agent callbacks

Built-in prompt templates can be overridden or extended through
`.lovelace/prompts/*.md`. Final prompts remain editable. Failure retains the
work item and exact draft; an uncertain launch is never automatically replayed.

Agent launches include the work-item ID and noninteractive CLI invocation.
See [`packages/cli/SKILL.md`](packages/cli/SKILL.md).

```sh
lovelace repos
lovelace work-items show <id>
lovelace work-items add-worktree <id> <repo> [--branch <name>] [--base <branch>]
lovelace work-items attach-jira <id> PROJ-123
lovelace work-items attach-pr <id> https://github.com/owner/repo/pull/42
lovelace work-items done <id>
```

Work may span repositories. Every prepared workspace gets an isolated branch.
Coriol owns lazy warm seed clones and direct Git worktrees; it never scans or
reuses arbitrary local checkouts. npm dependencies are prepared automatically,
using `@openclaw/fs-safe` copy-on-write artifacts where possible.

## Sessions

The TUI closes Jira setup as soon as the server saves and accepts the launch.
Repository preparation and agent startup continue in the background; progress
and failed-prompt retry appear on the work item. Start another task without
waiting for earlier ones. Completion never changes the selected page or focuses
Herdr, and quitting the TUI does not cancel accepted work.

The server creates one Herdr workspace per work item and starts each agent in
its own tab with `herdr agent start`, then submits the prompt. Launches never
steal focus. An agent that opens blocked, for example on a folder trust dialog,
gets its prompt once Herdr reports it idle. Herdr owns the running processes;
Lovelace mirrors their state every few seconds. Done/cancelled work is not
automatically activated or launched.

Herdr's agent integrations report each agent's state and native conversation,
which the server records. Selecting an ended session continues exactly that
conversation, in the pane it left when that shell is still idle. A session
without a recorded native identity cannot be continued; Lovelace never guesses
the latest conversation or replays the initial prompt.

Model/thinking overrides remain with drafts and session records. See [API contracts](docs/v4-api.md) and
[TUI controls](packages/tui/README.md).

## State and reusable packages

Durable state lives under `<domainRoot>/.lovelace`: `state.db`, `logs/`,
`prompts/` and Coriol-managed `repos/`, `workspaces/` and `toolchains/`.

Persisted provider lists load on startup, then refresh roughly every five minutes.
Stale/last-good data remains useful during outages. Recent work covers the
server's previous and current local calendar day and recorded activity, not guessed elapsed time or
fabricated pre-v4 history. Workspace cleanup is explicit.

`lovelace work-items add-worktree <id> <repo>` polls preparation instead of waiting
on one long HTTP request. State appears immediately in
`lovelace work-items workspaces <id>`; concurrent retries share preparation.
Ctrl-C stops waiting, not provisioning. Final stdout stays JSON; failed
repositories report their errors alongside ready siblings.

| Package | Responsibility |
| --- | --- |
| `cache` | Bounded cache, TTL/stale-while-revalidate, refresh coalescing, storage adapter |
| `github-client`, `jira-client` | Independent service-provider API clients, no caching |
| `jira-platform-client`, `jira-software-client` | Generated Jira APIs (`jira-client` uses the platform client; the software client is kept for later and built only via `pnpm build:jira-software-client`) |
| `adf-converter` | ADF conversion |
| `coriol` | Managed clones, worktrees and warm toolchains |
| `model-catalog` | Models each harness accepts, from its own CLI, no caching |
| `core` | Application contracts, configuration and paths |
| `server` | SQLite, sync, prompts, durable work records and the Herdr client |
| `client` | Typed HTTP API for the TUI, CLI and future clients |
| `tui-components` | Generic pi-tui components and text helpers |
| `tui`, `cli` | Explicit interactive dashboard and noninteractive CLI |

Framework/reuse research is in [docs/v4-research.md](docs/v4-research.md).
The native macOS client, Kizzy and repository/security dashboards are retired.
Installed applications, running services and user-local data are not removed
as part of that repository cleanup.

## License

[MIT](LICENSE)
