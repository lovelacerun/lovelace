# Lovelace

Lovelace is a local workbench for manually orchestrating work across coding
harnesses. It turns tickets and pull requests into **work items**, prepares
warm git worktrees for them, runs agents (Pi, Claude Code, Codex) on them in
Herdr, and keeps track of what happened: sessions, pull
requests and their build status.

You decide what to work on and which agent does it. Lovelace remembers the
context so you don't have to.

## Concepts

- **Work item**: a local unit of work with a title, notes and a state
  (`active`, `done`, `cancelled`). Its state is independent of any ticket.
  Everything else attaches to a work item.
- **Tracker issue**: a ticket attached to a work item (currently Jira).
  Assigned open issues show up as pending work.
- **Pull request**: a change attached to a work item (currently GitHub), with
  review, build and merge status. An optional release-checks plugin reports
  where merged ones have been released.
- **Review request**: an open pull request awaiting your review (bots
  excluded). Starting a review checks out its branch in a worktree and starts
  an agent with the `review` template.
- **Worktree**: a git worktree of a repository, prepared for one work item
  with dependencies installed. Lovelace keeps a seed clone per repository and
  reuses its `node_modules` when the lockfile matches.
- **Session**: an agent running in a tab of the work item's Herdr workspace.
  Lovelace records the agent's native conversation, so opening an ended
  session resumes exactly that conversation.
- **Prompt template**: a starting prompt (`implement`, `review`, `refine`, or
  your own) rendered with the work item's context.

Agents call back into Lovelace with `lovelace work …` from any of the work
item's worktrees, for example to attach a pull request they opened or to add
another repository.

## Requirements

- macOS
- Herdr, running, with the integrations for your agents
- At least one of `pi`, `claude`, `codex`
- Optional: Jira and GitHub accounts, `gh` (to borrow its login), `op` (to
  read tokens from 1Password)

## Install

```sh
brew install lovelacerun/tap/lovelace
lovelace init
```

Homebrew brings Node and Herdr. `lovelace init` checks dependencies and each
agent's Herdr integration, writes `~/.config/lovelace/config.jsonc` and stores
tokens in the macOS Keychain. Rerun it any time. See
[`examples/dot-lovelace`](examples/dot-lovelace) for a commented config.

### Credentials

Lovelace only reads from Jira and GitHub; clones use your own git
credentials. The server looks for each token in this order:

1. macOS Keychain, service `lovelace`, account `github-token` or
   `jira-api-token`
2. An `op://vault/item/field` reference in the config
3. A plaintext value in the config
4. GitHub only: the `gh` login of `github.account`

Least privilege: a fine-grained GitHub token with read-only Metadata, Pull
requests, Commit statuses and Checks; an Atlassian scoped token with
`read:jira-work` (scoped tokens need
`jira.baseUrl = https://api.atlassian.com/ex/jira/<cloudId>`).

## Use

```sh
lovelace tui          # the workbench
lovelace help         # all commands
```

Home shows what you worked on yesterday and today. From the TUI you can start
new work, work on a pending Jira issue or a review, or another session on a
work item, each from one dialog that picks repositories, a template and an
agent; open or continue sessions; and mark work done. Commands that need the server start it in the
background; `lovelace server start|stop|restart|status` manage it.

## Where things live

| Path | Contents |
| --- | --- |
| `~/.config/lovelace/config.jsonc` | Configuration (`LOVELACE_CONFIG` selects another file) |
| `~/projects/.lovelace/` | State root (`domainRoot` moves `~/projects`) |
| `…/.lovelace/state.db` | Work items, attachments, sessions |
| `…/.lovelace/repos/`, `workspaces/` | Seed clones and per-work-item worktrees |
| `…/.lovelace/prompts/` | Your prompt templates and overrides |
| `…/.lovelace/logs/server.log` | Server log |

## Packages

| Package | Purpose |
| --- | --- |
| `cli` | The `lovelace` executable: setup, server lifecycle, scripting commands |
| `server` | Local HTTP server; the only part that talks to providers and Herdr |
| `client` | tRPC client for the server, typed from its router |
| `tui` | Terminal workbench |
| `core` | Shared types and configuration |
| `coriol` | Seed clones and dependency-warm worktrees |
| `jira-client`, `github-client` | Provider API clients |
| `cache`, `secrets`, `model-catalog`, `tui-components`, `adf-converter` | Standalone helpers |

## License

MIT
