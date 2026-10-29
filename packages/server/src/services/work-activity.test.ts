import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { AgentSession, JiraIssueSummary, LovelaceConfig } from '@lovelace/core';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../database.js';
import { migrations } from '../migrations.js';
import { addAttachments, createManualWorkItem } from '../repositories/work-item-repository.js';
import { FakeHerdr } from '../test-support/fake-herdr.js';
import { syncSessions } from './session-service.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-work-activity-'));
  const config: LovelaceConfig = { domainRoot: root, lovelaceDir: join(root, '.lovelace'), port: 27421, logLevel: 'info', syncIntervalMs: 300_000, defaultAgent: 'pi', tui: { sidebarSide: 'right' } };
  const database = openDatabase(config);
  t.after(async () => { if (database.db.isOpen) database.db.close(); await rm(root, { recursive: true, force: true }); });
  return { config, database };
}

const logger = { info() {}, warn() {}, error() {} };

function jiraIssue(status: string): JiraIssueSummary {
  return { id: '1', key: 'PROJ-1', title: 'Issue', url: 'https://jira.example/browse/PROJ-1', status, statusCategory: null, issueType: null, updatedAt: 'now', descriptionText: null } as JiraIssueSummary;
}

test('activity records real DB mutations once and survives restart without backfill', async (t) => {
  const { database, config } = await fixture(t);
  const work = createManualWorkItem(database, { title: 'Work' });
  database.updateWorkItemState(work.id, 'active');
  database.updateWorkItemState(work.id, 'cancelled');
  database.updateWorkItemState(work.id, 'active');
  database.updateWorkItemState(work.id, 'done');
  const completedAt = database.getWorkItem(work.id)!.completedAt;
  database.updateWorkItemState(work.id, 'done');
  assert.equal(database.getWorkItem(work.id)!.completedAt, completedAt);
  database.updateWorkItem(work.id, { title: 'Edited', notes: 'Kept' });
  database.updateWorkItem(work.id, { title: 'Edited again' });
  assert.equal(database.getWorkItem(work.id)!.notes, 'Kept', 'omitted notes are kept');
  database.updateWorkItem(work.id, { notes: null });
  assert.equal(database.getWorkItem(work.id)!.title, 'Edited again', 'omitted title is kept');
  const beforeTouch = database.listWorkActivity();
  database.touchWorkItem(work.id);
  assert.deepEqual(database.listWorkActivity(), beforeTouch, 'timestamp-only touch is not invented activity');
  assert.deepEqual(beforeTouch.map((row) => row.kind), ['work-item.created', 'work-item.started', 'work-item.cancelled', 'work-item.started', 'work-item.completed', 'work-item.updated', 'work-item.updated', 'work-item.updated']);
  database.db.close();
  const reopened = openDatabase(config);
  try {
    assert.deepEqual(reopened.listWorkActivity(), beforeTouch);
    assert.equal(reopened.getWorkItem(work.id)!.title, 'Edited again');
  } finally { reopened.db.close(); }
});

test('additive activity schema preserves legacy work/metas and invents no v3 history', async (t) => {
  const { database, config } = await fixture(t);
  database.db.close();
  // Simulate an unversioned v3 database that had no activity table. This is temporary fixture state only.
  const legacy = new DatabaseSync(join(config.lovelaceDir, 'state.db'));
  legacy.exec('drop table work_activity; drop table launches; drop table work_item_attachments; drop table worktrees; drop table sessions');
  migrations[0]!(legacy);
  legacy.exec(`
    drop table work_activity;
    insert into work_items (id, title, state, created_at, updated_at) values ('w1', 'Legacy', 'active', 'now', 'now');
    insert into work_item_meta (id, work_item_id, meta_type, provider, external_id, payload_json, created_at, updated_at)
      values ('m1', 'w1', 'tracker-item', 'jira', '1', '{"key":"PROJ-1"}', 'now', 'now');
    pragma user_version = 0;
  `);
  legacy.close();
  const reopened = openDatabase(config);
  try {
    assert.equal(reopened.getWorkItem('w1')!.title, 'Legacy');
    assert.equal(reopened.listAttachments('w1').length, 1);
    assert.deepEqual(reopened.listWorkActivity(), []);
  } finally { reopened.db.close(); }
});

test('metadata creation activity is atomic and provider payload refresh is not work', async (t) => {
  const { database } = await fixture(t);
  const work = createManualWorkItem(database, { title: 'Metas' });
  const [attachment] = addAttachments(database, work.id, [{ type: 'tracker-item', provider: 'jira', externalId: '1', payload: jiraIssue('To Do') }]);
  const before = database.listWorkActivity();
  database.updateAttachment('tracker-item', attachment!.id, jiraIssue('Done'));
  assert.deepEqual(database.listWorkActivity(), before);
  const attachmentCount = database.listAttachments().length;
  const duplicate = { workItemId: work.id, type: 'tracker-item' as const, provider: 'jira', externalId: '2', payload: jiraIssue('To Do') };
  assert.throws(() => database.addAttachments([duplicate, duplicate]), /UNIQUE constraint/);
  assert.equal(database.listAttachments().length, attachmentCount);
  assert.deepEqual(database.listWorkActivity(), before, 'failed transaction cannot leave activity behind');
  assert.throws(() => database.recordWorkActivity({ workItemId: 'missing', kind: 'session.created' }), /FOREIGN KEY/);
});

function runningSession(database: ReturnType<typeof openDatabase>, workItemId: string, herdr: FakeHerdr) {
  const pane = [...herdr.panes.values()][0]!;
  const payload: AgentSession = {
    terminalRef: { workspaceId: pane.workspaceId, paneId: pane.paneId }, agentName: 'll-fixture', nativeSessionId: null, nativeSessionPath: null,
    toolId: 'codex', title: 'Codex', cwd: '/fixture', status: 'running', agentState: 'idle', metadata: null,
  };
  return addAttachments(database, workItemId, [{ type: 'session', payload }])[0]!;
}

test('Herdr sync mirrors agent state and native identity, and records the end once', async (t) => {
  const { database } = await fixture(t);
  const work = createManualWorkItem(database, { title: 'Agent' });
  const herdr = new FakeHerdr();
  const { paneId } = await herdr.createWorkspace({ cwd: '/fixture', label: 'Agent' });
  await herdr.startAgent({ name: 'll-fixture', kind: 'codex', paneId, args: [] });
  const meta = runningSession(database, work.id, herdr);
  const read = () => database.getAttachment('session', meta.id)!.payload;
  herdr.panes.get(paneId)!.agentStatus = 'working';
  await syncSessions(database, herdr);
  await syncSessions(database, herdr);
  assert.equal(read().agentState, 'working');
  assert.equal(read().nativeSessionId, herdr.panes.get(paneId)!.agentSession!.value);
  herdr.panes.get(paneId)!.agentStatus = 'blocked';
  await syncSessions(database, herdr);
  herdr.exitAgent(paneId);
  await syncSessions(database, herdr);
  await syncSessions(database, herdr);
  const ended = read();
  assert.equal(ended.status, 'ended');
  assert.equal(ended.agentState, 'ended');
  assert.ok(ended.nativeSessionId, 'the identity reported while running survives the agent');
  const changes = database.listWorkActivity({ workItemId: work.id }).filter(row => row.kind === 'session.state-changed').map(row => JSON.parse(row.payloadJson!).state);
  assert.deepEqual(changes, ['working', 'blocked', 'ended']);
});

test('another agent in the session pane is not this session', async (t) => {
  const { database } = await fixture(t);
  const work = createManualWorkItem(database, { title: 'Agent' });
  const herdr = new FakeHerdr();
  const { paneId } = await herdr.createWorkspace({ cwd: '/fixture', label: 'Agent' });
  await herdr.startAgent({ name: 'other', kind: 'claude', paneId, args: [] });
  const meta = runningSession(database, work.id, herdr);
  await syncSessions(database, herdr);
  assert.equal(database.getAttachment('session', meta.id)!.payload.status, 'ended');
});

test('a working agent records one real-work marker per session and local day', async (t) => {
  const { database } = await fixture(t);
  const work = createManualWorkItem(database, { title: 'Long-running work' });
  const herdr = new FakeHerdr();
  const { paneId } = await herdr.createWorkspace({ cwd: '/fixture', label: 'Agent' });
  await herdr.startAgent({ name: 'll-fixture', kind: 'codex', paneId, args: [] });
  runningSession(database, work.id, herdr);
  herdr.panes.get(paneId)!.agentStatus = 'working';
  for (let i = 0; i < 20; i++) await syncSessions(database, herdr, new Date(2026, 9, 6, 12));
  assert.equal(database.listWorkActivity().filter((row) => row.kind === 'session.worked').length, 1);
  await syncSessions(database, herdr, new Date(2026, 9, 7, 12));
  assert.equal(database.listWorkActivity().filter((row) => row.kind === 'session.worked').length, 2);
});

test('cancellation remains distinct from completion in durable work events', async (t) => {
  const { database } = await fixture(t);
  const work = createManualWorkItem(database, { title: 'Cancelled work' });
  database.updateWorkItemState(work.id, 'cancelled');
  assert.equal(database.listWorkActivity().filter((row) => row.kind === 'work-item.cancelled').length, 1);
  assert.equal(database.listWorkActivity().filter((row) => row.kind === 'work-item.completed').length, 0);
});
