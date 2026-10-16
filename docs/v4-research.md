# v4 reuse and framework decisions

Research checked against package manifests, npm metadata and public upstream
source on 2026-10-07.

## TUI

Use `@earendil-works/pi-tui@1.0.4`. It fits the Node/pnpm workspace, has no
native renderer dependency, and supplies editing, terminal-width handling,
fullscreen rendering and layout primitives. Keep application navigation in
the client; delegate terminal handoff to a separate host adapter.

`@opentui/core@0.5.15` is a viable future alternative, but its current runtime
requires Bun 1.3+ or Node 26.4+ with FFI. v4 does not need that runtime change.

Sources:
- [pi TUI](https://github.com/earendil-works/pi/tree/main/packages/tui)
- [pi-tui npm metadata](https://www.npmjs.com/package/@earendil-works/pi-tui)
- [OpenTUI](https://github.com/anomalyco/opentui)
- [OpenTUI npm metadata](https://www.npmjs.com/package/@opentui/core)

Herdr is the only terminal host; Lovelace supports no other multiplexer. The
user runs Herdr and its agent integrations. The server drives that running
session through the Herdr CLI (one workspace per work item, one tab per
session) and never inherits a caller's pane context or starts a Herdr server.
Clients never talk to Herdr.

## Cache and service-provider clients

The old server cache was a small memory Map backed by SQLite snapshots.
Freshness and coalescing were application-service concerns, implemented
inconsistently. Extract those mechanics without importing work items, config,
Fastify or SQLite into the cache.

Use maintained `lru-cache@11.5.3` for bounded retention. The small Lovelace
wrapper owns JSON snapshots, TTL/SWR, per-key refresh coalescing, validation,
an injected clock and optional persist-before-publish hooks. Memory eviction
does not delete durable state, and failed refreshes keep the last-good value
and timestamp.

`async-cache-dedupe` is another high-quality candidate, but a dynamic
snapshot/key API fits this application better. Keyv's additional storage
abstraction is unnecessary while the server already owns SQLite persistence.

Sources:
- [lru-cache](https://github.com/isaacs/node-lru-cache)
- [async-cache-dedupe](https://github.com/mcollina/async-cache-dedupe)
- [Keyv](https://github.com/jaredwray/keyv)

GitHub and Jira service-provider clients accept provider-specific primitive
configuration and injected transport/cache. Server adapters retain application
authentication and snapshot bucket conventions. Cache identity includes
host/account/credential scope without persisting plaintext credentials.

Manual and scheduled refreshes force a real provider fetch; normal reusable
client reads can use TTL/SWR. This avoids presenting stale cached values as a
new successful sync.

Keep trusted existing Octokit for GitHub. For the small Jira API surface,
`jira-client` calls the generated Jira Platform client (limited to the
operations it uses) plus ADF conversion. Preserve generated Jira
Platform/Software clients independently rather than folding hundreds of
generated endpoints into work orchestration.

## Hermes and OpenClaw

### Hermes

The relevant candidate is [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent),
a Python assistant application, not a TypeScript Jira/GitHub/cache library.

Its [pyproject.toml](https://github.com/NousResearch/hermes-agent/blob/main/pyproject.toml)
declares the Python application and CLI/Gateway/ACP entry points.
[`hermes_state.py`](https://github.com/NousResearch/hermes-agent/blob/main/hermes_state.py)
depends on Hermes home/config/session/schema conventions. Those internals do
not fit an independent Node cache package.

This is a conclusion about the inspected candidates, not a claim that no
reusable Hermes library can exist.

### OpenClaw

OpenClaw has useful independently published packages, but distinguish them
from private extensions and assistant-specific SDKs.

- [`@openclaw/fs-safe`](https://github.com/openclaw/fs-safe) is already used by
  Coriol for safe filesystem operations and copy-on-write artifacts.
- [`@openclaw/ai`](https://github.com/openclaw/openclaw/blob/main/packages/ai/package.json)
  is a model-provider/streaming library, not a Jira/GitHub service client.
- [`@openclaw/gateway-client`](https://github.com/openclaw/openclaw/blob/main/packages/gateway-client/package.json)
  speaks OpenClaw's Gateway protocol; it does not replace Lovelace's HTTP API.
- The inspected [GitHub extension](https://github.com/openclaw/openclaw/blob/main/extensions/github/package.json)
  and [retry workspace](https://github.com/openclaw/openclaw/blob/main/packages/retry/package.json)
  are private application packages.
- The inspected [LRU helper](https://github.com/openclaw/openclaw/blob/main/src/infra/lru-cache.ts)
  leaves freshness/lifecycle to callers; it does not supply durable
  hydration/SWR/persist-before-publish behavior.

Use published utilities where their contracts fit. Keep architectural
inspiration separate from copying another assistant's application internals.

## Verification boundary

Provider/cache tests use fake transports and temporary persistence. Session
tests use a fake Herdr client. No
installed agent process or live provider is required for these tests.
See individual package READMEs for their reuse APIs and guarantees.
