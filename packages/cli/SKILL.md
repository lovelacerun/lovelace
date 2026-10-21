---
name: lovelace
description: Control the local Lovelace work orchestrator from an agent session — inspect the current work item, attach additional repositories (worktrees), and mark work items done.
---

# Lovelace CLI for agents

Lovelace is the local work orchestrator that launched this session. It manages
*work items* (units of work), prepares git *worktrees* for the repositories a
work item touches, and tracks agent sessions. Your launch prompt contains a
"Lovelace context" section with the work item id and the exact command to
invoke this CLI. Use that command even if `lovelace` is on PATH: it targets the
server that launched you.

The CLI talks to the Lovelace daemon on `127.0.0.1` (default port 27421). All
agent/work-item commands print JSON without prompts or a TUI. No arguments
prints help. Only explicit `lovelace tui` opens the dashboard. If a command
fails with a connection error, the daemon is
not running — report that to the user instead of retrying.

Substitute `lovelace` below with the invocation command from your launch
prompt (for example `LOVELACE_PORT=27421 /opt/homebrew/opt/lovelace/bin/lovelace`).

## Inspect the current work item

```sh
lovelace work-items show <work-item-id>
```

Returns the work item plus its metas: attached repositories (with
`worktreePath`, `branchName`, `status`) and sessions.

## Add a worktree to the work item

Use this when the task turns out to need code from another repository, or a
second branch of one (e.g. a stacked diff). Lovelace prepares a dedicated
worktree next to your current one and installs dependencies automatically.

```sh
lovelace repos                                     # discover repo names known to Lovelace
lovelace work-items add-worktree <work-item-id> <repo-name> [--branch <name>] [--base <branch>]
lovelace doctor                                    # inspect Coriol/COW capabilities
```

- One repository per call; run it again for each further repository.
- Without `--branch`, an existing worktree of the repo is reused; otherwise a
  fresh branch is derived from the work item.
- `--branch <name>` selects the worktree on that branch: the same repo and
  branch reuse it, a new branch adds a sibling worktree.
- `--base <branch>` sets where a fresh branch starts (default: the repo's
  default branch). To stack, pass the parent worktree's branch; unpushed local
  branches work.
- Dependency preparation is automatic. Lovelace reuses the default branch's
  warm cache when possible and installs in the worktree when needed.

The output lists each prepared workspace with its stable `worktreePath` — work
on the new repo **inside that workspace**, not in the managed seed checkout.
The path is a direct Git worktree prepared by Coriol. The call is idempotent:
re-running it with the same repo and `--branch` reuses the existing workspace.
Slow preparation is polled; the final output stays JSON. Concurrent retries
join preparation rather than repeating it. Inspect state with
`lovelace work-items workspaces <work-item-id>` (`pending`, `preparing`, `ready` or
`failed`, with phase/error details). A timeout or interrupted wait does not
cancel server preparation; inspect before retrying. Use only `ready` workspaces.
A partial failure is returned as data; retrying keeps ready siblings.

If the repo name is unknown, run `lovelace repos sync` to refresh the provider
catalog, then retry.

## Attach Jira issues

```sh
lovelace work-items attach-jira <work-item-id> <issue-key-or-browse-url>
```

Jira links are optional and can be attached after an impromptu session starts.
The local work-item state is independent of the issue's upstream status.

## Attach pull requests

After pushing a branch and opening a GitHub pull request (for example with
`gh pr create`), attach it to the current work item so Lovelace can track the
PR status and CI/build status for the user.

```sh
lovelace work-items attach-pr <work-item-id> <pr-url>
lovelace work-items prs <work-item-id> --refresh
```

`attach-pr` also accepts `owner/repo#number` shorthand. Use `detach-pr` only if
a PR was attached to the wrong work item.

## Edit the work item title or notes

```sh
lovelace work-items update <work-item-id> --title <text>
lovelace work-items update <work-item-id> --notes-file <path>
```

Pass `--title`, and/or exactly one of `--notes <text>`, `--notes-file <path>`
or `--clear-notes`. Omitted fields keep their current values. Title and notes
are local only; they never change the Jira issue or pull request.

## Mark the work item done

```sh
lovelace work-items done <work-item-id>
```

Only do this when the work is actually complete or the user explicitly asks
for it. Marking done makes the work item's worktrees eligible for explicit
cleanup after a retention period, so never mark done while changes are
unpushed or uncommitted. Other states are available via `work-items start` (active); a
work item can also be created ad hoc with `work-items create <title>` (it starts active).

## Other useful commands

```sh
lovelace work-items            # list all work items
lovelace status                # daemon status
lovelace inbox                 # inbox of pending work (Jira issues, PR groups)
```

Run `lovelace help` (or no arguments) for the command list. Automation should
pass an explicit command. Errors are JSON on stderr with a nonzero exit code.

## Agent sessions

```sh
lovelace work-items launch <work-item-id> <pi|codex|claude> (--prompt <text> | --prompt-file <path>)
lovelace work-items open <work-item-id> <session-meta-id>
```

Launch starts a new agent session in the work item's Herdr workspace; pass
exactly one of `--prompt` or `--prompt-file`. It never focuses the new tab.
`open` focuses a running session in Herdr, or continues an ended session's
exact native conversation; it fails if none is recorded for the session.
Reactivate inactive work explicitly with `work-items start` first. Inspect
work/session state after uncertain replies; never blindly re-run a launch.
Use these only when the user asks.
