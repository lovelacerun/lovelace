import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LovelaceClient } from './client.js';

function withBody(status: number, body: unknown): typeof fetch {
  return async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('LovelaceClient abort / timeout', () => {
  it('aborts an in-flight request when the caller signal fires', async () => {
    const controller = new AbortController();
    const fetchFn: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(init.signal?.reason ?? new DOMException('aborted', 'AbortError'));
      });
    });
    const client = new LovelaceClient('http://localhost:27421', fetchFn);
    const promise = client.getDashboard({ signal: controller.signal });
    queueMicrotask(() => controller.abort(new DOMException('user cancelled', 'AbortError')));
    await assert.rejects(promise, (err: unknown) => {
      assert.ok(err instanceof DOMException);
      assert.equal((err as DOMException).name, 'AbortError');
      return true;
    });
  });

  it('rejects pre-aborted requests before issuing a fetch', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('already', 'AbortError'));
    let called = 0;
    const fetchFn: typeof fetch = async () => { called++; return new Response('{}'); };
    const client = new LovelaceClient('http://localhost:27421', fetchFn);
    await assert.rejects(() => client.getDashboard({ signal: controller.signal }), (err: unknown) => {
      assert.ok(err instanceof DOMException);
      return true;
    });
    assert.equal(called, 0, 'fetch must not run after pre-aborted signal');
  });

  it('times out when timeoutMs elapses', async () => {
    const fetchFn: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
    const client = new LovelaceClient('http://localhost:27421', fetchFn);
    await assert.rejects(() => client.getDashboard({ timeoutMs: 20 }), (err: unknown) => {
      assert.ok(err instanceof DOMException);
      assert.equal((err as DOMException).name, 'TimeoutError');
      return true;
    });
  });


  it('bounds an injected fetch even when it ignores AbortSignal', async () => {
    let calls = 0;
    const fetchFn: typeof fetch = () => { calls++; return new Promise(() => {}); };
    const client = new LovelaceClient('http://localhost:27421', fetchFn);
    await assert.rejects(client.quickStart('exact', undefined, undefined, undefined, undefined, { timeoutMs: 20 }),
      (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError');
    assert.equal(calls, 1, 'timed-out mutation is never automatically retried');
  });

  for (const status of [200, 400]) {
    it(`bounds response.json consumption for HTTP ${status} even when a custom body ignores abort`, async () => {
      const fetchFn: typeof fetch = async () => ({
        ok: status === 200, status, json: () => new Promise(() => {}),
      }) as Response;
      const client = new LovelaceClient('http://localhost:27421', fetchFn);
      await assert.rejects(client.getDashboard({ timeoutMs: 20 }),
        (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError');
    });
  }

  it('caller cancellation bounds a non-cooperative response body and preserves its reason', async () => {
    const controller = new AbortController();
    const reason = new Error('fixture cancellation');
    const fetchFn: typeof fetch = async () => ({
      ok: true, json: () => new Promise(() => {}),
    }) as Response;
    const client = new LovelaceClient('http://localhost:27421', fetchFn);
    const request = client.getDashboard({ signal: controller.signal });
    queueMicrotask(() => controller.abort(reason));
    await assert.rejects(request, error => error === reason);
  });

  it('does not retain caller signal listeners after repeated requests', async () => {
    const controller = new AbortController();
    let added = 0, removed = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = (...args: Parameters<AbortSignal['addEventListener']>) => { added++; add(...args); };
    controller.signal.removeEventListener = (...args: Parameters<AbortSignal['removeEventListener']>) => { removed++; remove(...args); };
    const client = new LovelaceClient('http://localhost:27421', withBody(200, {}));
    for (let i = 0; i < 30; i++) await client.getDashboard({ signal: controller.signal });
    assert.equal(added, removed);
    assert.equal(added, 30);
  });

  it('cleans up the abort listener after a successful request', async () => {
    const controller = new AbortController();
    const client = new LovelaceClient('http://localhost:27421', withBody(200, { ok: true }));
    await client.getDashboard({ signal: controller.signal }).catch(() => {});
    // Firing the signal after completion must not throw. Node emits a warning
    // for listeners leaked onto an AbortSignal, which would be observable here.
    controller.abort(new DOMException('late', 'AbortError'));
    assert.ok(true);
  });

  it('rejects non-positive timeoutMs with RangeError', async () => {
    const client = new LovelaceClient('http://localhost:27421', withBody(200, {}));
    await assert.rejects(() => client.getDashboard({ timeoutMs: 0 }), RangeError);
    await assert.rejects(() => client.getDashboard({ timeoutMs: -1 }), RangeError);
  });
});
