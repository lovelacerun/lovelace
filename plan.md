# Plan

## Now

In order:

1. ~~Versioned schema migrations that upgrade existing databases on startup
   (`user_version`, backup before migrating, refuse newer databases).~~ Done.
2. ~~Removals: pull request release checks, `jira-software-client`, review
   request grouping and link inference; a review list in the TUI that starts
   review work in the pull request's branch.~~ Done.
3. Typed attachments: a discriminated union instead of `metaType` +
   `payloadJson`, parsed once at the database boundary and sent typed over
   HTTP; real tables for sessions and worktrees; unique indexes.
4. Lighter launches, in the same migration as 3: one `launches` table with a
   single state column and a boot ID, server-side retry, the TUI keeping only
   the prompt, selections and in-flight request ID. Keep the invariants in
   [agents.md](agents.md).
5. Typed API: every route has a typed client method; no untyped requests
   from the CLI.
6. Provider-neutral domain types (`Repository`, `TrackerIssue`,
   `ChangeRequest`) with tracker and code host interfaces in the server.
7. Validated config, split into server config and client settings; fewer
   environment overrides.
8. TUI: a route union for navigation, split `app.ts`, one launch dialog.
9. Coriol: inject environment policy (direnv, Volta, PATH); prepare it for
   publishing.

Naming throughout: Herdr workspace, worktree, task directory; one word for
harness/tool/agent.

## Next

- Tracker implementations beyond Jira (GitHub Issues, Linear) and code hosts
  beyond GitHub (GitLab, Bitbucket).
- Decide whether Coriol is published on its own or replaced by an existing
  tool.
- Release checks as a plugin.

## Not doing

- Platforms other than macOS.
- Terminal hosts other than Herdr.
- A desktop app.
