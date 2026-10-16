import assert from 'node:assert/strict';
import test from 'node:test';
import { createCacheStore, type CacheSnapshot, type CacheStorage } from './index.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const snapshot = (key = 'one', payloadJson = '[1]', fetchedAt = new Date(T0).toISOString()): CacheSnapshot => ({ key, fetchedAt, payloadJson });
const isNumbers = (value: unknown): value is number[] => Array.isArray(value) && value.every((entry) => typeof entry === 'number');

function memoryStorage(initial: CacheSnapshot[] = []) {
  const rows = new Map(initial.map((entry) => [entry.key, entry]));
  const storage: CacheStorage = {
    load: () => [...rows.values()],
    save: (entry) => { rows.set(entry.key, entry); },
    delete: (key) => { rows.delete(key); },
  };
  return { rows, storage };
}

test('cold read and concurrent refreshes coalesce; fresh reads respect the TTL', async () => {
  let calls = 0;
  const result = deferred<number[]>();
  const cache = createCacheStore({ now: () => T0 });
  const request = { key: 'one', fetch: () => { calls++; return result.promise; } };
  const cold = cache.read(request), first = cache.refresh(request), second = cache.refresh(request);
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  result.resolve([1]);
  assert.deepEqual(await Promise.all([cold, first, second]), [[1], [1], [1]]);
  assert.deepEqual(await cache.read(request), [1]);
  assert.equal(calls, 1);
  await cache.refresh({ ...request, fetch: async () => { calls++; return [2]; } });
  assert.equal(calls, 2);
  assert.deepEqual(await cache.read(request), [2]);
});

test('stale reads return last-good immediately and revalidate in the background once', async () => {
  let time = T0;
  const errors: unknown[] = [];
  const cache = createCacheStore({ now: () => time, storage: memoryStorage([snapshot()]).storage, onError: (error) => { errors.push(error); } });
  time += 300_000;
  const result = deferred<number[]>();
  let calls = 0;
  const request = { key: 'one', fetch: () => { calls++; return result.promise; } };
  assert.deepEqual(await cache.read(request), [1]);
  assert.deepEqual(await cache.read(request), [1]);
  assert.equal(calls, 1);
  result.resolve([2]);
  await result.promise; await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(cache.peek('one'), { value: [2], fetchedAt: new Date(time).toISOString() });
  assert.deepEqual(errors, []);
});

test('failures keep the last-good value and report background errors', async () => {
  let time = T0;
  const errors: unknown[] = [];
  const cache = createCacheStore({ now: () => time, storage: memoryStorage([snapshot()]).storage, onError: (error) => { errors.push(error); } });
  time += 600_000;
  const request = { key: 'one', fetch: async (): Promise<number[]> => { throw new Error('rate limited'); } };
  assert.deepEqual(await cache.read(request), [1]);
  await assert.rejects(cache.refresh(request), /rate limited/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(cache.peek('one'), { value: [1], fetchedAt: snapshot().fetchedAt });
  assert.equal(errors.length, 1);
  await assert.rejects(cache.read({ key: 'cold', fetch: async () => { throw new Error('offline'); } }), /offline/);
  assert.equal(cache.peek('cold'), undefined);
});

test('invalid fetched values never publish; invalid cached values count as missing', async () => {
  const cache = createCacheStore({ now: () => T0, storage: memoryStorage([snapshot('one', '{"old":true}')]).storage });
  assert.equal(cache.peek('one', isNumbers), undefined);
  assert.deepEqual(await cache.read({ key: 'one', validate: isNumbers, fetch: async () => [3] }), [3]);
  await assert.rejects(cache.refresh({ key: 'one', validate: isNumbers, fetch: async () => ['x'] as unknown as number[] }), /Invalid cache payload/);
  assert.deepEqual(cache.peek('one', isNumbers)?.value, [3]);
});

test('storage loads on start, saves fetched values, skips memory-only keys and ignores malformed rows', async () => {
  const { rows, storage } = memoryStorage([snapshot('one'), { key: 'broken', fetchedAt: 'never', payloadJson: '[]' }, snapshot('bad-json', '{')]);
  const cache = createCacheStore({ now: () => T0 + 1000, storage });
  assert.deepEqual(cache.list().map((entry) => entry.key), ['one']);
  await cache.refresh({ key: 'two', fetch: async () => ({ ok: true }) });
  await cache.refresh({ key: 'detail', persist: false, fetch: async () => null });
  assert.equal(rows.get('two')?.payloadJson, '{"ok":true}');
  assert.equal(rows.has('detail'), false);
  assert.deepEqual(cache.peek('detail'), { value: null, fetchedAt: new Date(T0 + 1000).toISOString() });
});

test('storage failures are reported but do not fail refreshes', async () => {
  const errors: unknown[] = [];
  const cache = createCacheStore({
    storage: { load: () => { throw new Error('locked'); }, save: () => { throw new Error('disk full'); }, delete: () => undefined },
    onError: (error) => { errors.push(error); },
  });
  assert.deepEqual(await cache.refresh({ key: 'one', fetch: async () => [1] }), [1]);
  assert.deepEqual(errors.map((error) => (error as Error).message), ['locked', 'disk full']);
});

test('entry and byte bounds evict least recently used entries from memory and storage', async () => {
  const { rows, storage } = memoryStorage([
    snapshot('old', '[0]', '2026-09-01T00:00:00.000Z'), snapshot('a', '[1]'), snapshot('b', '[2]', '2026-10-02T00:00:00.000Z'),
  ]);
  const cache = createCacheStore({ maxEntries: 2, storage });
  assert.deepEqual(cache.list().map((entry) => entry.key), ['a', 'b']);
  assert.equal(rows.has('old'), false);
  cache.peek('a');
  await cache.refresh({ key: 'c', fetch: async () => [3] });
  assert.deepEqual([...rows.keys()].sort(), ['a', 'c']);

  const small = createCacheStore({ maxBytes: 400 });
  await small.refresh({ key: 'one', fetch: async () => [1] });
  await assert.rejects(small.refresh({ key: 'one', fetch: async () => 'x'.repeat(500) }), /byte limit/);
  assert.deepEqual(small.peek('one')?.value, [1]);
});

test('a stalled fetch times out, aborts its signal and frees the key for retry', async () => {
  const cache = createCacheStore({ fetchTimeoutMs: 20 });
  let signal: AbortSignal | undefined;
  await assert.rejects(cache.refresh({ key: 'one', fetch: (received) => { signal = received; return new Promise<number[]>(() => {}); } }), /exceeded 20ms/);
  assert.equal(signal?.aborted, true);
  assert.deepEqual(await cache.refresh({ key: 'one', fetch: async () => [1] }), [1]);
});

test('returned values cannot mutate cached state; options are validated', async () => {
  const cache = createCacheStore();
  const value = await cache.refresh({ key: 'one', fetch: async () => [1] });
  value.push(2);
  cache.peek<number[]>('one')!.value.push(3);
  assert.deepEqual(cache.peek('one')?.value, [1]);
  await assert.rejects(cache.read({ key: 'one', ttlMs: -1, fetch: async () => [1] }), /ttlMs/);
  assert.throws(() => createCacheStore({ maxEntries: 0 }), /positive integers/);
});
