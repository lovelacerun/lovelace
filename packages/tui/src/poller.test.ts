import assert from 'node:assert/strict';
import test from 'node:test';
import { RefreshPoller } from './poller.js';

test('progress polling speeds up only while work is pending and stops cleanly', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let pending = true;
  let calls = 0;
  const poller = new RefreshPoller(async () => { calls++; }, () => pending ? 1000 : 7000);
  poller.start();
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(999);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  pending = false;
  t.mock.timers.tick(1000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 3);
  t.mock.timers.tick(6999);
  assert.equal(calls, 3);
  t.mock.timers.tick(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 4);
  poller.stop();
  t.mock.timers.tick(10_000);
  assert.equal(calls, 4);
});
