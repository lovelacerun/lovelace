# Decisions

Choices that shape the codebase, and why. Add an entry when a choice would
otherwise be re-litigated.

## Terminal first, no embedded terminal

Lovelace is a TUI and a CLI over a local server. An earlier native macOS app
with an embedded terminal was clumsy next to the terminal where agents,
editors and deploys already run. Sessions hand off to a real terminal.

## Herdr is the only terminal host

Supporting several multiplexers meant Lovelace ran its own agent hooks,
extensions and reconciliation. Herdr's agent integrations already report
agent state and conversation identity, so Lovelace drives Herdr and mirrors
what it reports. Running agents is not Lovelace's job; the less it changes
the agents, the better.

## pi-tui for the TUI

`@earendil-works/pi-tui` fits a Node/pnpm workspace, has no native renderer
and provides editing, width handling, fullscreen rendering and layout.
OpenTUI was the alternative but required Bun or Node with FFI.

## One local server owns all side effects

Clients never call providers, Coriol or Herdr. This keeps credentials, cache
and durable state in one process, lets agents use the same API as the TUI,
and leaves room for other clients later.

## tRPC between clients and the server

Hand-written client methods and response types drifted from the routes and
let tests fake the client through unchecked casts. A tRPC router gives every
procedure zod-validated input and inferred output, and test fakes are typed
per procedure. `fate` was considered but is a React data layer; the TUI is
not React and only the server caches. The server keeps a plain `GET /status`
so a newer CLI can find and restart an older server.

## A small cache package over `lru-cache`

Freshness, refresh coalescing, last-good retention and persistence were
implemented inconsistently across services. `@lovelace/cache` wraps
`lru-cache` with TTL, stale-while-revalidate and an injected storage adapter.
`async-cache-dedupe` and Keyv were considered; the server already owns
persistence in SQLite.

## Generated Jira client, Octokit for GitHub

`jira-platform-client` is generated from Atlassian's OpenAPI spec, limited to
the operations Lovelace uses; `jira-client` adds pagination, timeouts and ADF
conversion on top. GitHub uses Octokit.

## Coriol for worktrees

Agents need isolated, ready-to-run checkouts quickly. Coriol keeps seed
clones, creates worktrees on fresh branches and reuses `node_modules`
copy-on-write (`@openclaw/fs-safe`) when the lockfile matches. It knows
nothing about work items, so it can be published separately or replaced.
Environment policy (direnv, Volta and PATH) is injected by the server rather
than discovered inside Coriol; standalone callers choose their own policy.

## Plugins are executables with a JSON contract

Release semantics differ per company (tags, deploy tools, environments), so
they stay out of core code. A plugin is any executable that answers one JSON
request on stdout. It runs in its own process with a timeout, can be
written in any language, wraps existing tools such as a deploy CLI, and
imports nothing from Lovelace. In-process JavaScript modules were
considered; they would share the server's process and couple plugins to
Lovelace's types.

## Repositories are chosen explicitly

Lovelace never infers repositories from a prompt and never works in
checkouts it didn't create.
