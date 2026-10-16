import assert from 'node:assert/strict';
import test from 'node:test';
import { LovelaceClient } from './client.js';

const accepted = { details: { workItem: { id: 'work' }, metas: [] }, launch: { ok: false, error: null, phase: 'accepted' }, operation: { requestId: 'id', status: 'pending' } };

test('launch wait:false submits once and returns acceptance; status lookup is a read using the exact UUID', async () => {
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  const client = new LovelaceClient('http://localhost:27421', async (input, init) => {
    requests.push({ path: new URL(String(input)).pathname, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
    return Response.json(accepted, { status: init?.method === 'POST' ? 202 : 200 });
  });
  assert.deepEqual(await client.quickStart('  Exact\n', '42', 'claude', undefined, 'id', { repoIds: ['repo'], promptId: 'refine', wait: false }), accepted);
  assert.deepEqual(await client.newSession('work/1', 'Retry\n', 'pi', { pi: { thinkingLevel: 'high' } }, 'id2', { wait: false }), accepted);
  assert.deepEqual(await client.getLaunchOperation('id/2'), accepted);
  assert.deepEqual(requests, [
    { path: '/work-items/quick-start', method: 'POST', body: { prompt: '  Exact\n', jiraIssueId: '42', agentId: 'claude', requestId: 'id', repoIds: ['repo'], promptId: 'refine', wait: false } },
    { path: '/work-items/work%2F1/new-session', method: 'POST', body: { prompt: 'Retry\n', agentId: 'pi', options: { pi: { thinkingLevel: 'high' } }, requestId: 'id2', wait: false } },
    { path: '/launch-operations/id%2F2', method: 'GET', body: null },
  ]);
});

test('async acceptance uses the ordinary bounded deadline, never the provisioning/startup deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const client = new LovelaceClient('http://localhost:27421', async () => { calls++; return new Promise(() => {}); });
  const request = assert.rejects(client.quickStart('Task', undefined, undefined, undefined, 'id', { wait: false }),
    error => error instanceof DOMException && error.name === 'TimeoutError');
  t.mock.timers.tick(15_000);
  await request;
  assert.equal(calls, 1);
});
