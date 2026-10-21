import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { herdrSocketPath } from './herdr-client.js';
import { watchHerdrEvents } from './herdr-events.js';

const logger = { info() {}, warn() {} };

async function waitFor(condition: () => boolean) {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(condition(), 'condition not reached');
}

test('subscribes to agent and pane events, resyncs on each one and resubscribes when watched panes change', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'll-herdr-'));
  const path = join(dir, 'herdr.sock');
  const requests: Array<{ id: string; method: string; params: { subscriptions: Array<{ type: string; pane_id?: string }> } }> = [];
  const sockets: Socket[] = [];
  const server = createServer(socket => {
    sockets.push(socket);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      const request = JSON.parse(chunk.trim());
      requests.push(request);
      const missing = request.params.subscriptions.find((entry: { pane_id?: string }) => entry.pane_id === 'w9:p9');
      socket.write(`${JSON.stringify(missing
        ? { id: request.id, error: { code: 'pane_not_found', message: 'pane w9:p9 not found' } }
        : { id: request.id, result: { type: 'subscription_started' } })}\n`);
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  let changes = 0;
  const watcher = watchHerdrEvents({ socketPath: async () => path, onChange: () => { changes++; }, logger });
  t.after(async () => {
    watcher.close();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  await waitFor(() => watcher.connected);
  assert.equal(requests[0]!.method, 'events.subscribe');
  assert.deepEqual(requests[0]!.params.subscriptions, [{ type: 'pane.agent_detected' }, { type: 'pane.exited' }, { type: 'pane.closed' }]);
  assert.equal(changes, 1, 'a fresh subscription resyncs once');

  sockets[0]!.write(`${JSON.stringify({ event: 'pane_agent_detected', data: { pane_id: 'w1:p1', agent: 'codex' } })}\n`);
  await waitFor(() => changes === 2);

  watcher.watchPanes(['w1:p1']);
  await waitFor(() => requests.length === 2 && watcher.connected);
  assert.deepEqual(requests[1]!.params.subscriptions.at(-1), { type: 'pane.agent_status_changed', pane_id: 'w1:p1' });
  watcher.watchPanes(['w1:p1']);
  assert.equal(requests.length, 2, 'an unchanged pane set keeps the connection');

  // A pane that vanished before subscribing: Herdr rejects everything, the caller resyncs.
  const before = changes;
  watcher.watchPanes(['w1:p1', 'w9:p9']);
  await waitFor(() => changes > before && requests.length === 3);
  assert.equal(watcher.connected, false);
});

test('the socket path is the configured one, else the one Herdr reports', async () => {
  assert.equal(await herdrSocketPath({ socketPath: '/fixture/herdr.sock' }), '/fixture/herdr.sock');
  const calls: string[][] = [];
  const path = await herdrSocketPath({ executable: '/fixture/herdr' }, async (_file, args) => {
    calls.push(args);
    return { exitCode: 0, stdout: 'status: running\nversion: 0.9.5\nsocket: /Users/me/.config/herdr/herdr.sock\n', stderr: '' };
  });
  assert.equal(path, '/Users/me/.config/herdr/herdr.sock');
  assert.deepEqual(calls, [['status', 'server']]);
});
