import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TRPCClientError } from '@trpc/client';
import { createLovelaceClient, isAborted, isTimeout, isUnreachable } from './client.js';

const SERVER = 'http://localhost:27421';

function withData(data: unknown): typeof fetch {
  return async () => Response.json({ result: { data } });
}

/** A fetch that only settles when its signal aborts, rejecting with the signal's reason. */
const untilAborted: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
  init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
});

const timedOut = (error: unknown) => error instanceof TRPCClientError && isTimeout(error) && isUnreachable(error);

describe('LovelaceClient abort / timeout', () => {
  it('aborts an in-flight request when the caller signal fires and keeps its reason as cause', async () => {
    const controller = new AbortController();
    const reason = new DOMException('user cancelled', 'AbortError');
    const client = createLovelaceClient(SERVER, untilAborted);
    const promise = client.dashboard.get.query(undefined, { signal: controller.signal });
    queueMicrotask(() => controller.abort(reason));
    await assert.rejects(promise, (error: unknown) => {
      assert.ok(error instanceof TRPCClientError);
      assert.equal(error.cause, reason);
      assert.equal(isAborted(error), true);
      assert.equal(isUnreachable(error), false);
      return true;
    });
  });

  it('rejects pre-aborted requests before issuing a fetch', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('already', 'AbortError'));
    let called = 0;
    const client = createLovelaceClient(SERVER, async () => { called++; return Response.json({ result: { data: {} } }); });
    await assert.rejects(client.dashboard.get.query(undefined, { signal: controller.signal }), isAborted);
    assert.equal(called, 0, 'fetch must not run after pre-aborted signal');
  });

  it('times out when timeoutMs elapses', async () => {
    const client = createLovelaceClient(SERVER, untilAborted);
    await assert.rejects(client.dashboard.get.query(undefined, { context: { timeoutMs: 20 } }), timedOut);
  });

  it('bounds an injected fetch even when it ignores AbortSignal and never retries the mutation', async () => {
    let calls = 0;
    const client = createLovelaceClient(SERVER, () => { calls++; return new Promise(() => {}); });
    await assert.rejects(client.launches.quickStart.mutate({ prompt: 'exact' }, { context: { timeoutMs: 20 } }), timedOut);
    assert.equal(calls, 1, 'timed-out mutation is never automatically retried');
  });

  for (const status of [200, 400]) {
    it(`bounds response.json consumption for HTTP ${status} even when a custom body ignores abort`, async () => {
      const client = createLovelaceClient(SERVER, async () => ({
        ok: status === 200, status, json: () => new Promise(() => {}),
      }) as Response);
      await assert.rejects(client.dashboard.get.query(undefined, { context: { timeoutMs: 20 } }), timedOut);
    });
  }

  it('caller cancellation bounds a non-cooperative response body and preserves its reason', async () => {
    const controller = new AbortController();
    const reason = new Error('fixture cancellation');
    const client = createLovelaceClient(SERVER, async () => ({
      ok: true, status: 200, json: () => new Promise(() => {}),
    }) as Response);
    const request = client.dashboard.get.query(undefined, { signal: controller.signal });
    queueMicrotask(() => controller.abort(reason));
    await assert.rejects(request, error => error instanceof TRPCClientError && error.cause === reason);
  });

  it('does not retain caller signal listeners after repeated requests', async () => {
    const controller = new AbortController();
    let added = 0, removed = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = (...args: Parameters<AbortSignal['addEventListener']>) => { added++; add(...args); };
    controller.signal.removeEventListener = (...args: Parameters<AbortSignal['removeEventListener']>) => { removed++; remove(...args); };
    const client = createLovelaceClient(SERVER, withData({}));
    for (let i = 0; i < 30; i++) await client.dashboard.get.query(undefined, { signal: controller.signal });
    assert.equal(added, removed);
    assert.ok(added >= 30);
  });

  it('cleans up the abort listener after a successful request', async () => {
    const controller = new AbortController();
    const client = createLovelaceClient(SERVER, withData({ ok: true }));
    await client.dashboard.get.query(undefined, { signal: controller.signal });
    // Firing the signal after completion must not throw. Node emits a warning
    // for listeners leaked onto an AbortSignal, which would be observable here.
    controller.abort(new DOMException('late', 'AbortError'));
  });

  it('rejects non-positive timeoutMs with RangeError', async () => {
    let calls = 0;
    const client = createLovelaceClient(SERVER, async () => { calls++; return Response.json({ result: { data: {} } }); });
    for (const timeoutMs of [0, -1, Number.NaN]) {
      await assert.rejects(client.dashboard.get.query(undefined, { context: { timeoutMs } }),
        error => error instanceof TRPCClientError && error.cause instanceof RangeError);
    }
    assert.equal(calls, 0);
  });
});
