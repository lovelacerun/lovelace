import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseState } from '../database.js';
import type { HerdrClient } from '../herdr/herdr-client.js';
import { CONNECTED_POLL_MS, DISCONNECTED_POLL_MS, startSessionSync } from './session-sync.js';

function fixture() {
  const sessions = [{ id: 'm1', workItemId: 'work', metaType: 'session', payloadJson: JSON.stringify({ agentName: 'll-1', status: 'running', terminalRef: { paneId: 'w1:p1' } }) }];
  const database = { listWorkItemMeta: () => sessions, updateWorkItemMetaPayload() {}, recordWorkActivity() {}, recordWorkActivityOnce() {} } as unknown as DatabaseState;
  let release: () => void = () => {};
  let listCalls = 0;
  const herdr = {
    listPanes: () => {
      listCalls++;
      return new Promise(resolve => { release = () => resolve([]); });
    },
  } as unknown as HerdrClient;
  let onChange: () => void = () => {};
  const watched: string[][] = [];
  const watcher = { connected: true, watchPanes: (panes: string[]) => watched.push(panes), close() {} };
  let clock = 0;
  const sync = startSessionSync({
    database, herdr, logger: { info() {}, warn() {} }, now: () => clock,
    watch: options => { onChange = options.onChange; return watcher; },
  });
  return { sync, watcher, watched, change: () => onChange(), release: () => release(), listCalls: () => listCalls, advance: (ms: number) => { clock += ms; } };
}

test('event bursts coalesce into one sync at a time plus one catch-up, then watch running panes', async t => {
  const { sync, watched, change, release, listCalls } = fixture();
  t.after(() => sync.stop());
  change();
  change();
  change();
  assert.equal(listCalls(), 1);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(listCalls(), 2, 'one catch-up sync for events during the first');
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(listCalls(), 2);
  assert.deepEqual(watched.at(-1), ['w1:p1']);
});

test('a slow poll backs up the subscription, a fast one replaces it while disconnected', async t => {
  const { sync, watcher, release, listCalls, advance } = fixture();
  t.after(() => sync.stop());
  advance(CONNECTED_POLL_MS);
  sync.tick();
  assert.equal(listCalls(), 1);
  release();
  await new Promise(resolve => setImmediate(resolve));
  advance(DISCONNECTED_POLL_MS);
  sync.tick();
  assert.equal(listCalls(), 1, 'connected: no sync before the slow interval');
  watcher.connected = false;
  sync.tick();
  assert.equal(listCalls(), 2);
});
