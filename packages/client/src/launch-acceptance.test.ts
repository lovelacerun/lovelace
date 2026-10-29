import assert from 'node:assert/strict';
import test from 'node:test';
import { createLovelaceClient, isTimeout } from './client.js';

const SERVER = 'http://localhost:27421';
const accepted = { details: { workItem: { id: 'work' }, attachments: [], launches: [] }, launch: { id: 'id', state: 'accepted', error: null } };

test('launch wait:false submits once and returns acceptance; lookup reads and retry posts by the exact UUID', async () => {
  const requests: Array<{ path: string; input: unknown }> = [];
  const client = createLovelaceClient(SERVER, async (input, init) => {
    const url = new URL(String(input));
    requests.push({ path: url.pathname, input: JSON.parse(String(init?.body ?? url.searchParams.get('input'))) });
    return Response.json({ result: { data: accepted } });
  });
  assert.deepEqual(await client.launches.quickStart.mutate({ prompt: '  Exact\n', trackerIssueId: '42', agentId: 'claude', requestId: 'id', repoIds: ['repo'], promptId: 'refine', wait: false }), accepted);
  assert.deepEqual(await client.launches.newSession.mutate({ workItemId: 'work/1', prompt: 'Retry\n', agentId: 'pi', options: { pi: { thinkingLevel: 'high' } }, requestId: 'id2', wait: false }), accepted);
  assert.deepEqual(await client.launches.get.query({ id: 'id/2' }), accepted);
  assert.deepEqual(await client.launches.retry.mutate({ id: 'id/3' }), accepted);
  assert.deepEqual(requests, [
    { path: '/trpc/launches.quickStart', input: { prompt: '  Exact\n', trackerIssueId: '42', agentId: 'claude', requestId: 'id', repoIds: ['repo'], promptId: 'refine', wait: false } },
    { path: '/trpc/launches.newSession', input: { workItemId: 'work/1', prompt: 'Retry\n', agentId: 'pi', options: { pi: { thinkingLevel: 'high' } }, requestId: 'id2', wait: false } },
    { path: '/trpc/launches.get', input: { id: 'id/2' } },
    { path: '/trpc/launches.retry', input: { id: 'id/3' } },
  ]);
});

test('async acceptance uses the ordinary bounded deadline, never the provisioning/startup deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const client = createLovelaceClient(SERVER, async () => { calls++; return new Promise(() => {}); });
  const request = assert.rejects(client.launches.quickStart.mutate({ prompt: 'Task', requestId: 'id', wait: false }), isTimeout);
  t.mock.timers.tick(15_000);
  await request;
  assert.equal(calls, 1);
});

test('waiting launches get the startup deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const client = createLovelaceClient(SERVER, async () => new Promise(() => {}));
  const request = assert.rejects(client.launches.quickStart.mutate({ prompt: 'Task' }), isTimeout).finally(() => { settled = true; });
  t.mock.timers.tick(15_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  t.mock.timers.tick(45_000);
  await request;
});
