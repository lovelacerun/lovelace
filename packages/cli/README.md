# @lovelace/cli

Thin local-server CLI. No arguments prints help. TUI entry is explicit:
`lovelace tui` or the root `pnpm tui` script. Work-item/agent commands are
noninteractive JSON; errors are JSON on stderr with a nonzero exit code.
Providers and SDKs are accessed only by the local server.

The same executable sets Lovelace up and runs it: `lovelace init` (interactive),
`lovelace server` (foreground) and `lovelace server start|stop|restart|status`.
Commands that need the server start it on demand (`LOVELACE_NO_AUTOSTART=1`
disables that, e.g. in tests): a detached `lovelace server supervise` process
holds `<lovelaceDir>/server.pid`, runs `lovelace server` with the macOS system
proxy and restarts it when that proxy changes or the server exits. It inherits
an allowlisted environment only. A background server reporting another version
is replaced. Homebrew's wrapper exports its stable `opt` path as
`LOVELACE_EXECUTABLE`, which agent callbacks use.

```sh
lovelace work-items launch <id> <pi|codex|claude> (--prompt <text> | --prompt-file <path>)
lovelace work-items open <id> <session-meta-id>
```

Launch requires exactly one of `--prompt`/`--prompt-file` (optional `--model`,
`--thinking`), preserves prompt whitespace and asks the server to start the
session in the work item's Herdr workspace through the durable
`POST /work-items/:id/new-session` endpoint. It never focuses the new tab.
Inspect existing work/sessions after an uncertain reply instead of blindly
repeating a launch.

`open` focuses a running session's Herdr tab, or continues an ended session's
exact recorded native conversation (never latest or initial-prompt replay);
without a recorded native conversation it fails. Inactive work requires
explicit `work-items start` first; `work-items start` only changes local work
state and does not launch.

```sh
lovelace work-items update <id> [--title <text>] [--notes <text> | --notes-file <path> | --clear-notes]
```

`update` edits the local title and notes through `PATCH /work-items/:id`;
omitted fields keep their current values.

Workspace creation (`work-items add-worktree <id> <repo> [--branch <name>] [--base <branch>]`)
submits preparation then polls durable state.
Slow fetches/installs do not consume one long HTTP deadline. Interactive progress
goes to TTY stderr only; stdout remains the final `{workItem,repositories}` JSON.
Partial failures remain data, with `status:failed` and `errorMessage`.
`work-items workspaces <id>` exposes pending/preparing/ready/failed state and progress.
Ctrl-C stops waiting without cancelling preparation and returns a JSON error
with that inspection command. A deliberate retry joins in-flight preparation,
reuses ready workspaces and retries failures at their existing paths.

Use `lovelace help` for the full command list and [SKILL.md](./SKILL.md) for
agent callback/work-item guidance.

```sh
pnpm --filter @lovelace/cli build
pnpm --filter @lovelace/cli test
```

Tests use injected API/host functions, fake HTTP and temporary config; no live
providers, models, services or operator panes.
