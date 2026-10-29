import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { migrateDatabase, migrations } from './migrations.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-migrations-'));
  const db = new DatabaseSync(join(root, 'state.db'));
  t.after(async () => { if (db.isOpen) db.close(); await rm(root, { recursive: true, force: true }); });
  return { db, backupDir: join(root, 'backups') };
}

const version = (db: DatabaseSync) => (db.prepare('pragma user_version').get() as { user_version: number }).user_version;

test('a fresh database is created at the latest version without a backup', async (t) => {
  const { db, backupDir } = await fixture(t);
  migrateDatabase(db, backupDir);
  assert.equal(version(db), migrations.length);
  assert.ok(db.prepare("select name from sqlite_master where name = 'work_items'").get());
  await assert.rejects(readdir(backupDir));
});

test('an unversioned database keeps its data and is backed up before migrating', async (t) => {
  const { db, backupDir } = await fixture(t);
  db.exec("create table work_items (id text primary key, title text not null, state text not null, notes text, created_at text not null, updated_at text not null, started_at text, completed_at text)");
  db.exec("insert into work_items (id, title, state, created_at, updated_at) values ('w1', 'Kept', 'active', 'now', 'now')");
  migrateDatabase(db, backupDir);
  assert.equal(version(db), migrations.length);
  assert.deepEqual({ ...db.prepare('select title from work_items').get() as object }, { title: 'Kept' });
  const [backup] = await readdir(backupDir);
  assert.match(backup!, /^state-v0-.*\.db$/);
  const copy = new DatabaseSync(join(backupDir, backup!));
  assert.equal(version(copy), 0);
  assert.deepEqual({ ...copy.prepare('select title from work_items').get() as object }, { title: 'Kept' });
  copy.close();
});

test('an up-to-date database is left alone', async (t) => {
  const { db, backupDir } = await fixture(t);
  migrateDatabase(db, backupDir);
  migrateDatabase(db, backupDir);
  await assert.rejects(readdir(backupDir));
});

test('a database from a newer Lovelace is refused untouched', async (t) => {
  const { db, backupDir } = await fixture(t);
  db.exec(`pragma user_version = ${migrations.length + 1}`);
  assert.throws(() => migrateDatabase(db, backupDir), /Upgrade Lovelace/);
  assert.equal(version(db), migrations.length + 1);
  assert.equal(db.prepare('select count(*) as count from sqlite_master').get()!.count, 0);
});

test('a failing migration rolls back and keeps the previous version', async (t) => {
  const { db, backupDir } = await fixture(t);
  const steps = [
    (target: DatabaseSync) => target.exec('create table first (id text)'),
    (target: DatabaseSync) => { target.exec('create table second (id text)'); throw new Error('boom'); },
  ];
  assert.throws(() => migrateDatabase(db, backupDir, steps), /boom/);
  assert.equal(version(db), 1);
  assert.equal(db.prepare("select name from sqlite_master where name = 'second'").get(), undefined);
});

test('legacy metas move to typed attachments, sessions and worktrees without duplicates', async (t) => {
  const { db, backupDir } = await fixture(t);
  migrateDatabase(db, backupDir, migrations.slice(0, 1));
  const meta = (id: string, type: string, provider: string, externalId: string | null, payload: unknown, at = '2026-01-01') =>
    db.prepare('insert into work_item_meta values (?, ?, ?, ?, ?, ?, ?, ?)').run(id, 'w1', type, provider, externalId, typeof payload === 'string' ? payload : JSON.stringify(payload), at, at);
  db.exec("insert into work_items (id, title, state, created_at, updated_at) values ('w1', 'Work', 'active', 'now', 'now')");
  meta('jira-1', 'tracker-item', 'jira', '10', { key: 'PROJ-1' });
  meta('jira-2', 'tracker-item', 'jira', '10', { key: 'PROJ-1' }, '2026-01-02');
  meta('draft', 'prompt-draft', 'lovelace', 'launch:r1', { prompt: 'Keep me' });
  meta('herdr', 'herdr-workspace', 'herdr', 'ws-1', { workspaceId: 'ws-1', createdAt: '2026-01-01' });
  meta('old-tree', 'repository', 'github', 'a:/work/a', { repoId: 'a', worktreePath: '/work/a', workspaceMode: 'fresh', status: 'failed' });
  meta('tree', 'repository', 'github', 'a:/work/a', { repoId: 'a', repoName: 'a', repoPath: '/repos/a', worktreePath: '/work/a', workspaceMode: 'fresh', status: 'ready', dependenciesReused: true }, '2026-01-02');
  meta('broken', 'repository', 'github', 'b', 'not json');
  meta('session', 'session', 'pi', 'll-1', { agentName: 'll-1', toolId: 'pi', terminalRef: { workspaceId: 'ws-1', paneId: 'p1' }, status: 'running', agentState: 'idle', options: { model: 'm' }, promptPending: true });
  db.exec(`insert into work_launch_operations values ('r1', 'quick-start', '{}', 'w1', 'draft', 'pending', null, 'now', 'now')`);

  migrateDatabase(db, backupDir, migrations.slice(0, 2));

  const rows = (sql: string) => db.prepare(sql).all().map(row => ({ ...row }));
  assert.deepEqual(rows('select id, type, provider, external_id as externalId, payload_json as payload from work_item_attachments order by id'), [
    { id: 'draft', type: 'prompt-draft', provider: null, externalId: null, payload: '{"prompt":"Keep me"}' },
    { id: 'herdr', type: 'herdr-workspace', provider: null, externalId: null, payload: '{"workspaceId":"ws-1"}' },
    { id: 'jira-1', type: 'tracker-item', provider: 'jira', externalId: '10', payload: '{"key":"PROJ-1"}' },
  ]);
  assert.deepEqual(rows('select id, repo_id as repoId, status, dependencies_reused as reused from worktrees'), [{ id: 'tree', repoId: 'a', status: 'ready', reused: 1 }]);
  assert.deepEqual(rows('select id, tool_id as toolId, terminal_pane_id as paneId, options_json as options, prompt_pending as pending from sessions'),
    [{ id: 'session', toolId: 'pi', paneId: 'p1', options: '{"model":"m"}', pending: 1 }]);
  assert.deepEqual(rows('select request_id as requestId, draft_meta_id as draftId from work_launch_operations'), [{ requestId: 'r1', draftId: 'draft' }]);
  assert.equal(db.prepare("select name from sqlite_master where name = 'work_item_meta'").get(), undefined);
  assert.throws(() => db.exec("insert into sessions select * from sessions where id = 'session'"), /UNIQUE/);
});

test('launch operations and their drafts become launches with one state', async (t) => {
  const { db, backupDir } = await fixture(t);
  migrateDatabase(db, backupDir, migrations.slice(0, 2));
  db.exec("insert into work_items (id, title, state, created_at, updated_at) values ('w1', 'Work', 'active', 'now', 'now')");
  const draft = (id: string, payload: unknown) => db.prepare("insert into work_item_attachments values (?, 'w1', 'prompt-draft', null, null, ?, 'now', 'now')").run(id, JSON.stringify(payload));
  const operation = (id: string, draftId: string, status: string, outcome: unknown) =>
    db.prepare("insert into work_launch_operations values (?, 'quick-start', '{\"prompt\":\"p\"}', 'w1', ?, ?, ?, 'now', 'now')").run(id, draftId, status, outcome ? JSON.stringify(outcome) : null);
  draft('d1', { toolIds: ['claude'], toolOptions: { claude: { model: 'opus' } }, repoIds: ['a'], promptId: 'implement', prompt: 'Started', status: 'launched' });
  draft('d2', { toolIds: ['pi'], repoIds: null, promptId: null, prompt: 'Failed', status: 'pending' });
  draft('d3', { toolIds: ['pi'], repoIds: null, promptId: null, prompt: 'Interrupted', status: 'pending' });
  draft('d4', { toolIds: ['codex'], repoIds: null, promptId: null, prompt: 'Orphan', status: 'pending' });
  draft('d5', { requestId: 'R5', toolIds: ['pi'], repoIds: null, promptId: null, prompt: 'Unanswered', status: 'pending' });
  draft('d6', { requestId: 'r1', toolIds: ['pi'], repoIds: null, promptId: null, prompt: 'Taken', status: 'pending' });
  operation('r1', 'd1', 'completed', { ok: true, phase: 'started', error: null });
  operation('r2', 'd2', 'completed', { ok: false, phase: 'failed', error: 'boom' });
  operation('r3', 'd3', 'pending', { ok: false, phase: 'starting', error: null });

  migrateDatabase(db, backupDir);

  assert.deepEqual(db.prepare(`select id, kind, request_json as request, harness, options_json as options, repo_ids_json as repoIds,
    prompt_id as promptId, prompt, state, error is not null as hasError from launches order by id`).all().map(row => ({ ...row })), [
    { id: 'd4', kind: 'new-session', request: '{}', harness: 'codex', options: null, repoIds: '[]', promptId: null, prompt: 'Orphan', state: 'uncertain', hasError: 1 },
    { id: 'd6', kind: 'new-session', request: '{}', harness: 'pi', options: null, repoIds: '[]', promptId: null, prompt: 'Taken', state: 'uncertain', hasError: 1 },
    { id: 'r1', kind: 'quick-start', request: '{"prompt":"p"}', harness: 'claude', options: '{"claude":{"model":"opus"}}', repoIds: '["a"]', promptId: 'implement', prompt: 'Started', state: 'started', hasError: 0 },
    { id: 'r2', kind: 'quick-start', request: '{"prompt":"p"}', harness: 'pi', options: null, repoIds: '[]', promptId: null, prompt: 'Failed', state: 'failed', hasError: 1 },
    { id: 'r3', kind: 'quick-start', request: '{"prompt":"p"}', harness: 'pi', options: null, repoIds: '[]', promptId: null, prompt: 'Interrupted', state: 'uncertain', hasError: 1 },
    { id: 'r5', kind: 'new-session', request: '{}', harness: 'pi', options: null, repoIds: '[]', promptId: null, prompt: 'Unanswered', state: 'uncertain', hasError: 1 },
  ]);
  assert.equal(db.prepare("select count(*) as count from work_item_attachments where type = 'prompt-draft'").get()!.count, 0);
  assert.equal(db.prepare("select name from sqlite_master where name = 'work_launch_operations'").get(), undefined);
});

test('provider payloads become neutral and review requests are keyed by repository and number', async (t) => {
  const { db, backupDir } = await fixture(t);
  migrateDatabase(db, backupDir, migrations.slice(0, 3));
  db.exec("insert into work_items (id, title, state, created_at, updated_at) values ('w1', 'Work', 'active', 'now', 'now')");
  const attach = (id: string, type: string, provider: string, externalId: string, payload: unknown) =>
    db.prepare("insert into work_item_attachments values (?, 'w1', ?, ?, ?, ?, 'now', 'now')").run(id, type, provider, externalId, JSON.stringify(payload));
  const review = { id: '77', number: 7, title: 'Fix', url: 'https://github.test/org/a/pull/7', repoFullName: 'org/a', project: 'org/a', type: 'Fix',
    authorLogin: 'ann', author: 'ann', descriptionText: null, isDraft: false, headRefName: 'fix', baseRefName: 'main', status: 'open',
    reviewDecision: 'REVIEW_REQUIRED', buildStatus: 'success', updatedAt: '2026-10-01' };
  attach('cr', 'change-request', 'github', '77', review);
  attach('pr', 'pull-request', 'github', 'org/a#8', { repoFullName: 'org/a', number: 8, title: 'Feat', url: 'u', authorLogin: 'bob', headRefName: 'feat',
    baseRefName: 'main', status: 'approved', reviewDecision: 'APPROVED', buildStatus: null, attachedAt: 'a', lastSyncedAt: 'l' });
  attach('done', 'tracker-item', 'jira', '10', { id: '10', key: 'PROJ-1', title: 'T', url: 'u', project: 'PROJ', status: 'Erledigt', statusCategory: 'done',
    issueType: 'Task', type: 'Task', author: 'cy', descriptionText: 'Text', updatedAt: 'x' });
  attach('open', 'tracker-item', 'jira', '11', { id: '11', key: 'PROJ-2', title: 'T', url: 'u', project: null, status: 'Closed', statusCategory: null,
    issueType: null, type: null, author: null, descriptionText: null, updatedAt: 'x' });
  db.exec(`insert into worktrees (id, work_item_id, created_at, updated_at, repo_id, repo_name, repo_path, role, workspace_mode, worktree_path,
    source_external_id, status, prepared_at) values ('tree', 'w1', 'now', 'now', 'github:1', 'a', '/r', 'primary', 'change-request', '/w', '77', 'ready', 'now')`);
  db.prepare("insert into cache_snapshots values ('github.reviewRequests', 'now', ?)").run(JSON.stringify([{ ...review, id: '99', number: 9 }]));
  db.exec(`insert into inbox_meta values ('change-request', 'github', '99', 'dismissed', 'now', 'now'), ('change-request', 'github', '55', 'dismissed', 'now', 'now')`);

  migrateDatabase(db, backupDir);

  const payload = (id: string) => JSON.parse((db.prepare('select payload_json as json from work_item_attachments where id = ?').get(id) as { json: string }).json);
  assert.deepEqual(payload('cr'), { id: 'org/a#7', repository: 'org/a', number: 7, title: 'Fix', url: 'https://github.test/org/a/pull/7', author: 'ann',
    sourceBranch: 'fix', targetBranch: 'main', review: 'required', build: 'success', status: 'open', updatedAt: '2026-10-01' });
  assert.equal((db.prepare("select external_id as id from work_item_attachments where id = 'cr'").get() as { id: string }).id, 'org/a#7');
  assert.deepEqual(payload('pr'), { id: 'org/a#8', repository: 'org/a', number: 8, title: 'Feat', url: 'u', author: 'bob', sourceBranch: 'feat',
    targetBranch: 'main', review: 'approved', build: null, status: 'approved', updatedAt: 'l', attachedAt: 'a', lastSyncedAt: 'l' });
  assert.deepEqual(payload('done'), { id: '10', key: 'PROJ-1', title: 'T', url: 'u', project: 'PROJ', status: 'Erledigt', done: true, issueType: 'Task',
    author: 'cy', description: 'Text', updatedAt: 'x' });
  assert.equal(payload('open').done, true, 'terminal status without a category');
  assert.deepEqual({ ...db.prepare('select source_external_id as id from worktrees').get() as object }, { id: 'org/a#7' });
  assert.deepEqual(db.prepare('select external_id as id from inbox_meta order by id').all().map(row => row.id), ['55', 'org/a#9']);
  assert.equal(db.prepare('select count(*) as count from cache_snapshots').get()!.count, 0);
});
