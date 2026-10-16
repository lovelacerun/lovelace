import { LRUCache } from 'lru-cache';

/** Serialized form handed to storage adapters. */
export interface CacheSnapshot {
  key: string;
  fetchedAt: string;
  payloadJson: string;
}

/** Durable backend for quick starts. All methods may throw; failures go to `onError`. */
export interface CacheStorage {
  load(): CacheSnapshot[];
  save(snapshot: CacheSnapshot): void | Promise<void>;
  delete(key: string): void | Promise<void>;
}

export interface CacheRequest<T> {
  key: string;
  fetch(signal: AbortSignal): Promise<T>;
  /** Age after which `read` revalidates in the background. Defaults to five minutes. */
  ttlMs?: number;
  /** Cached values failing this check count as missing (e.g. older persisted shapes). */
  validate?(value: unknown): value is T;
  /** Write successful fetches to storage. Defaults to true. */
  persist?: boolean;
}

export interface Cached<T> {
  value: T;
  fetchedAt: string;
}

export interface CacheStore {
  /** Last-good value without fetching. */
  peek<T>(key: string, validate?: (value: unknown) => value is T): Cached<T> | undefined;
  /** Fresh hit returns; stale hit returns and revalidates in the background; miss fetches. */
  read<T>(request: CacheRequest<T>): Promise<T>;
  /** Always fetches, coalesced per key. Failures reject and keep the last-good value. */
  refresh<T>(request: CacheRequest<T>): Promise<T>;
  list(): CacheSnapshot[];
}

export interface CacheStoreOptions {
  storage?: CacheStorage;
  maxEntries?: number;
  /** Approximate retained bytes (UTF-16 strings plus per-entry overhead). */
  maxBytes?: number;
  /** Bound for one fetch, even when the fetcher ignores its abort signal. */
  fetchTimeoutMs?: number;
  now?: () => number;
  /** Background revalidation and storage failures. */
  onError?: (error: unknown, key: string) => void;
}

export const DEFAULT_TTL_MS = 300_000;

export function createCacheStore(options: CacheStoreOptions = {}): CacheStore {
  const { storage, maxEntries = 500, maxBytes = 64 * 1024 * 1024, fetchTimeoutMs = 60_000, now = Date.now } = options;
  for (const value of [maxEntries, maxBytes, fetchTimeoutMs]) {
    if (!Number.isInteger(value) || value < 1) throw new Error('Cache bounds must be positive integers');
  }
  const report = (error: unknown, key: string) => {
    try { options.onError?.(error, key); } catch { /* observer only */ }
  };
  const background = (key: string, work: () => void | Promise<void>) => {
    try { void Promise.resolve(work()).catch((error: unknown) => report(error, key)); } catch (error) { report(error, key); }
  };
  const entries = new LRUCache<string, CacheSnapshot>({
    max: maxEntries,
    maxSize: maxBytes,
    sizeCalculation: snapshotBytes,
    // Evicted entries leave storage too, so the durable copy stays bounded.
    dispose: (_, key, reason) => { if (reason === 'evict' && storage) background(key, () => storage.delete(key)); },
  });
  const inFlight = new Map<string, Promise<unknown>>();

  if (storage) {
    let loaded: CacheSnapshot[] = [];
    try { loaded = storage.load(); } catch (error) { report(error, '*'); }
    // Oldest first, so the LRU keeps the most recent entries when storage exceeds the bounds.
    for (const snapshot of loaded.filter(isValidSnapshot).sort((a, b) => Date.parse(a.fetchedAt) - Date.parse(b.fetchedAt))) {
      if (snapshotBytes(snapshot) <= maxBytes) entries.set(snapshot.key, { key: snapshot.key, fetchedAt: snapshot.fetchedAt, payloadJson: snapshot.payloadJson });
    }
  }

  function peek<T>(key: string, validate?: (value: unknown) => value is T): Cached<T> | undefined {
    const entry = entries.get(key);
    if (!entry) return undefined;
    const value = JSON.parse(entry.payloadJson) as unknown;
    return !validate || validate(value) ? { value: value as T, fetchedAt: entry.fetchedAt } : undefined;
  }

  function refresh<T>(request: CacheRequest<T>): Promise<T> {
    const existing = inFlight.get(request.key);
    if (existing) return existing as Promise<T>;
    const task = (async () => {
      const value = await withTimeout(request, fetchTimeoutMs);
      if (value === undefined || (request.validate && !request.validate(value))) throw new Error('Invalid cache payload for ' + request.key);
      const snapshot: CacheSnapshot = { key: request.key, fetchedAt: new Date(now()).toISOString(), payloadJson: JSON.stringify(value) };
      if (snapshotBytes(snapshot) > maxBytes) throw new Error('Cache payload exceeds byte limit for ' + request.key);
      entries.set(request.key, snapshot);
      if (storage && request.persist !== false) background(request.key, () => storage.save({ ...snapshot }));
      return JSON.parse(snapshot.payloadJson) as T;
    })().finally(() => inFlight.delete(request.key));
    inFlight.set(request.key, task);
    return task;
  }

  return {
    peek,
    async read(request) {
      const ttlMs = request.ttlMs ?? DEFAULT_TTL_MS;
      if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new Error('ttlMs must be non-negative and finite');
      const hit = peek(request.key, request.validate);
      if (!hit) return refresh(request);
      if (now() - Date.parse(hit.fetchedAt) >= ttlMs) background(request.key, () => refresh(request).then(() => undefined));
      return hit.value;
    },
    refresh,
    list: () => [...entries.values()].map((entry) => ({ ...entry })).sort((a, b) => a.key.localeCompare(b.key)),
  };
}

/** Race the fetch against a deadline so a stalled fetcher cannot wedge a key's refresh. */
async function withTimeout<T>(request: CacheRequest<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Cache fetch for ${request.key} exceeded ${timeoutMs}ms`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([request.fetch(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function snapshotBytes(entry: CacheSnapshot): number {
  return 256 + 2 * (entry.key.length + entry.fetchedAt.length + entry.payloadJson.length);
}

function isValidSnapshot(value: unknown): value is CacheSnapshot {
  const entry = value as Partial<CacheSnapshot> | null;
  if (!entry || typeof entry.key !== 'string' || !entry.key || typeof entry.fetchedAt !== 'string'
    || !Number.isFinite(Date.parse(entry.fetchedAt)) || typeof entry.payloadJson !== 'string') return false;
  try { JSON.parse(entry.payloadJson); return true; } catch { return false; }
}
