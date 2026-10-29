# @lovelace/client

Typed tRPC access to the local Lovelace server. No provider calls, no
automatic mutation retries and no batching. Launch identity semantics:
[architecture](../../docs/architecture.md#launching).

`createLovelaceClient(serverUrl, fetch?)` returns a `TRPCClient` for the
server's `AppRouter`; every procedure's input and output is inferred from the
router, so there are no hand-written methods:

```ts
const client = createLovelaceClient('http://127.0.0.1:27421');
const details = await client.workItems.get.query({ id });
await client.launches.quickStart.mutate({ prompt, requestId, wait: false }, { signal });
```

Calls accept `{ signal, context: { timeoutMs } }`. The default 15-second
deadline covers fetch **and response body consumption**; `launches.quickStart`,
`launches.newSession`, `sessions.open` and `repositories.sync` default to 60
seconds unless they pass `wait: false`, because the server answers once Herdr
reports the agent ready.

Every failure is a `TRPCClientError`. `errorStatus(error)` is the HTTP status
of a server rejection and 0 otherwise; `isUnreachable` covers transport
failures and expired deadlines, `isAborted` caller cancellation and
`isTimeout` expired deadlines. Caller cancellation and deadlines keep their
reason as the error's `cause`. Transport errors never include URLs or payloads.

Injected fetch implementations are deadline-bounded even if they ignore abort.
They must still honor `AbortSignal` to release their own sockets/body resources;
a deadline cannot forcibly dispose resources owned by a custom transport.

```sh
pnpm --filter @lovelace/client build
pnpm --filter @lovelace/client test
```

`launches.quickStart`/`launches.newSession` with `wait: false` return durable
acceptance immediately; the server owns completion and `launch.state` tells
callers to poll. `launches.get` reads a launch by request ID without starting
an agent; `launches.retry` runs a failed launch again with its saved prompt
and selections. The server persists the exact prompt and selections before
preparation; the same request UUID must retain the same selection. `wait` is
not part of the request identity.

`@lovelace/client/testing` provides `fakeClient(handlers)`, a client whose
calls run handlers keyed by procedure path (`'workItems.get'`) with inputs and
outputs typed from the router, and `serverError(status, message)` for server
rejections; any other thrown error behaves like an unreachable server. Tests
use injected transports or fakes; no providers or real agents are contacted.

`prepareRepositories(client, id, repositories, options)` submits once with
`wait: false` and polls workspace metadata until each selected workspace is
ready or failed. Every HTTP request keeps the ordinary deadline; preparation
has no overall deadline. `signal` stops waiting, not server preparation.
`onProgress` reports workspace state and `pollIntervalMs` defaults to 1000.
Partial failures remain in returned details. A lost reply or interrupted wait
raises `WorkspacePreparationWaitError` with last-observed state and an
inspection command; no mutation is automatically resubmitted.
