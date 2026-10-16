# @lovelace/client

Typed HTTP access to the local Lovelace server. No provider calls and no
automatic mutation retries. Launch identity semantics: [API contract](../../docs/v4-api.md).

Methods accept `{ signal, timeoutMs }`; the default 15-second deadline covers
fetch **and JSON body consumption**. Caller cancellation preserves its reason;
an expired deadline rejects with `TimeoutError`. Transport/read failures use
`ApiError` with status 0, while HTTP rejections retain their status.

Injected fetch implementations are deadline-bounded even if they ignore abort.
They must still honor `AbortSignal` to release their own sockets/body resources;
a deadline cannot forcibly dispose resources owned by a custom transport.

```sh
pnpm --filter @lovelace/client build
pnpm --filter @lovelace/client test
```

`serverUrl` exposes the actual configured address for client status displays.
`quickStart`, `newSession` and `openSession` wait up to 60 seconds by default,
because the server answers once Herdr reports the agent ready. The client has
no terminal dependency: the server drives Herdr.

`quickStart`/`newSession` accept `{wait:false}` in their final options to return
202 acceptance immediately, using the ordinary 15-second request deadline.
No client-side background launch is needed: the server owns completion.
`getLaunchOperation(requestId)` inspects that exact UUID without starting an
agent; `getWorkItem` includes launch summaries alongside saved drafts. Default
synchronous calls and JSON shapes remain available. `wait` is not frozen intent.

`getRepositories` and `getPromptTemplates` read server-owned launch catalogs;
`syncRepositories` explicitly refreshes the catalog through the local server;
`renderPrompt` renders a template before user editing. `quickStart` and
`newSession` accept `repoIds`/`promptId` alongside transport settings in their
final options argument. The server persists the exact prompt and selections
before preparation; the same request UUID must retain the same selection.

`requestJson` supports additional local server routes, rejecting provider URLs.
Jira/GitHub SDK access stays on the server.

Tests use injected transports; no providers or real agents are contacted.

`prepareRepositories(id, repositories, options)` submits once with `wait:false`
and polls workspace metadata until each selected workspace is ready or failed.
Every HTTP request keeps the ordinary deadline; preparation has no overall
deadline. `signal` stops waiting, not server preparation. `onProgress` reports
workspace state and `pollIntervalMs` defaults to 1000. Partial failures remain
in returned details. A lost reply or interrupted wait raises
`WorkspacePreparationWaitError` with last-observed state and an inspection
command; no mutation is automatically resubmitted.
