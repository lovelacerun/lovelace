# @lovelace/cache

A bounded JSON cache with stale-while-revalidate, coalesced refreshes and an injected storage adapter. It imports no application types, configuration, database or environment variables.

```ts
import { createCacheStore } from '@lovelace/cache';

const cache = createCacheStore({
  storage: { load: () => rows.all(), save: (snapshot) => rows.upsert(snapshot), delete: (key) => rows.delete(key) },
  maxEntries: 500,
  maxBytes: 64 * 1024 * 1024,
  fetchTimeoutMs: 60_000,
  onError: (error, key) => log.warn({ error, key }),
});

const request = {
  key: 'projects',
  ttlMs: 300_000,
  fetch: (signal: AbortSignal) => projectApi.list({ signal }),
  validate: (value: unknown): value is string[] => Array.isArray(value),
};
const projects = await cache.read(request);   // TTL + stale-while-revalidate
await cache.refresh(request);                 // bypass TTL, e.g. from a scheduler
cache.peek('projects', request.validate);     // { value, fetchedAt } without fetching
```

## Behaviour

- `read`: a fresh hit returns without fetching; a hit at or past `ttlMs` (default five minutes) returns immediately and revalidates in the background; a miss fetches and awaits.
- `refresh`: always fetches. Concurrent reads and refreshes of one key share one fetch.
- Failures (fetch errors, timeouts, `validate` rejections, oversized payloads) reject and keep the last-good value and its `fetchedAt`. Background failures go to `onError`. Stale values have no age cutoff; there is no timer, callers own periodic refresh.
- `fetchTimeoutMs` races every fetch, so a fetcher that ignores its abort signal cannot wedge the key.
- Cached values failing a request's `validate` count as missing, so persisted payloads from an older shape are refetched.
- Memory is bounded by entry count and approximate bytes (LRU). Returned values are copies.

## Storage

`storage.load()` runs once at construction so persisted values are available before the first refresh (newest kept when storage exceeds the bounds). Successful fetches are saved unless the request sets `persist: false`; LRU evictions delete the row so storage stays bounded. The cache is the only writer, so the adapter needs a plain upsert. Storage failures are reported through `onError` and never fail a refresh. `list()` returns the in-memory snapshots for diagnostics.
