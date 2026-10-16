import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import type { LovelaceConfig } from '@lovelace/core';
import { openDatabase } from '../database.js';
import { createActiveWorkItemFromMetas } from '../repositories/work-item-repository.js';
import { saveToolLaunchDraft } from './tool-launch-draft-service.js';
import { performLaunchOperation } from './launch-operation-service.js';

test('pending launch intent survives a real DB reopen and is never replayed automatically', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-operation-reopen-'));
  const config: LovelaceConfig = { domainRoot: root, lovelaceDir: join(root, '.lovelace'), port: 27421, logLevel: 'info', syncIntervalMs: 300_000, defaultAgent: 'pi', tui: { sidebarSide: 'right' } };
  let database = openDatabase(config);
  t.after(async () => { database.db.close(); await rm(root, { recursive: true, force: true }); });
  const requestId = randomUUID();
  const work = createActiveWorkItemFromMetas(database, { title: 'Uncertain', metas: [] });
  const prompt = '  Exact interrupted text\n  ';
  const draft = saveToolLaunchDraft(database, work.id, { toolIds: ['pi'], prompt }, requestId);
  database.createLaunchOperation({ requestId, kind: 'quick-start', inputJson: JSON.stringify({ prompt }), workItemId: work.id, draftMetaId: draft.id });
  database.db.close();
  database = openDatabase(config);
  const response = await performLaunchOperation(database, { requestId, kind: 'quick-start', input: { prompt }, prepare: () => assert.fail('restart must not recreate item'), launch: async () => assert.fail('restart must not launch') });
  assert.equal(response.operation!.status, 'uncertain');
  assert.equal(response.launch.ok, false);
  assert.equal(response.details.workItem.id, work.id);
  assert.equal(JSON.parse(response.details.metas.find((meta) => meta.id === draft.id)!.payloadJson!).prompt, prompt);
  assert.equal(database.getWorkItemCount(), 1);
  database.finishLaunchOperation(requestId, 'completed', { ok: true, error: null });
  database.db.close();
  database = openDatabase(config);
  const replay = await performLaunchOperation(database, { requestId, kind: 'quick-start', input: { prompt }, prepare: () => assert.fail('completed intent must not create another item'), launch: async () => assert.fail('completed intent must never relaunch') });
  assert.equal(replay.operation!.status, 'completed');
  assert.equal(replay.launch.ok, true);
  assert.equal(replay.details.workItem.id, work.id);
});

test('preparation and operation row are one transaction; failed preparation leaves no work/draft/activity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-operation-transaction-'));
  const database = openDatabase({ domainRoot: root, lovelaceDir: join(root, '.lovelace'), port: 27421, logLevel: 'info', syncIntervalMs: 300_000, defaultAgent: 'pi', tui: { sidebarSide: 'right' } });
  t.after(async () => { database.db.close(); await rm(root, { recursive: true, force: true }); });
  assert.throws(() => performLaunchOperation(database, { requestId: randomUUID(), kind: 'quick-start', input: { prompt: 'Text' }, prepare: (id) => {
    const work = createActiveWorkItemFromMetas(database, { title: 'Should roll back', metas: [] });
    saveToolLaunchDraft(database, work.id, { toolIds: ['pi'], prompt: 'Text' }, id);
    throw new Error('fixture transaction interrupted');
  }, launch: async () => assert.fail('must not launch') }), /interrupted/);
  assert.equal(database.getWorkItemCount(), 0);
  assert.deepEqual(database.listWorkItemMeta(), []);
  assert.deepEqual(database.listWorkActivity(), []);
});
