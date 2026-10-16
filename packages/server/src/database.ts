import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync, type StatementResultingChanges } from 'node:sqlite';
import type { CacheSnapshot, CacheStorage } from '@lovelace/cache';
import type {
  InboxMeta,
  InboxSourceType,
  LovelaceConfig,
  RepoRecord,
  WorkItem,
  WorkItemMeta,
  WorkItemState,
} from '@lovelace/core';

type WorkActivityKind =
  | 'work-item.created'
  | 'work-item.started'
  | 'work-item.completed'
  | 'work-item.cancelled'
  | 'session.worked'
  | 'work-item.tracker-attached'
  | 'session.created'
  | 'session.continued'
  | 'session.state-changed'
  | 'work-item.updated'
  | 'work-item.repository-attached'
  | 'work-item.pull-request-attached'
  | (string & {});

export interface WorkActivityRow {
  id: string;
  workItemId: string;
  kind: WorkActivityKind;
  payloadJson: string | null;
  occurredAt: string;
}

interface RecordWorkActivityInput {
  workItemId: string;
  kind: WorkActivityKind;
  payload?: unknown;
  occurredAt?: string;
  dedupeKey?: string;
}

export interface LaunchOperation {
  requestId: string;
  kind: 'quick-start' | 'new-session';
  inputJson: string;
  workItemId: string;
  draftMetaId: string;
  status: 'pending' | 'completed' | 'uncertain';
  outcomeJson: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Statement {
  run(...params: unknown[]): StatementResultingChanges;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface DatabaseState {
  db: DatabaseSync;
  /** Runs `fn` atomically; nested calls become savepoints of the outer transaction. */
  transaction<T>(fn: () => T): T;
  getRepoCount(): number;
  getWorkItemCount(): number;
  getLastRepoSyncAt(): string | null;
  replaceRepos(repos: RepoRecord[]): void;
  listRepos(): RepoRecord[];
  listWorkItems(state?: WorkItemState): WorkItem[];
  getWorkItem(id: string): WorkItem | null;
  createWorkItem(workItem: WorkItem): WorkItem;
  /** Omitted fields keep their current value. */
  updateWorkItem(id: string, input: { title?: string; notes?: string | null }): WorkItem | null;
  updateWorkItemState(id: string, state: WorkItemState): WorkItem | null;
  touchWorkItem(id: string): WorkItem | null;
  listWorkItemMeta(workItemId?: string): WorkItemMeta[];
  createWorkItemMetas(metas: WorkItemMeta[]): WorkItemMeta[];
  updateWorkItemMetaPayload(id: string, payload: unknown): WorkItemMeta | null;
  deleteWorkItemMetasByExternalIds(workItemId: string, metaType: WorkItemMeta['metaType'], provider: string | null, externalIds: string[]): void;
  listInboxMeta(): InboxMeta[];
  upsertInboxMeta(entry: InboxMeta): InboxMeta;
  deleteInboxMeta(sourceType: InboxSourceType, provider: string | null, externalId: string): void;
  /** Durable backend of the provider cache. */
  cacheStorage: CacheStorage;
  getLaunchOperation(requestId: string): LaunchOperation | null;
  listLaunchOperations(workItemId?: string): LaunchOperation[];
  updateLaunchOperationPhase(requestId: string, phase: 'preparing' | 'starting'): void;
  createLaunchOperation(input: Pick<LaunchOperation, 'requestId' | 'kind' | 'inputJson' | 'workItemId' | 'draftMetaId'>): LaunchOperation;
  finishLaunchOperation(requestId: string, status: LaunchOperation['status'], outcome: unknown): void;
  recordWorkActivityOnce(key: string, input: RecordWorkActivityInput): WorkActivityRow | null;
  recordWorkActivity(input: RecordWorkActivityInput): WorkActivityRow;
  listWorkActivity(input?: { workItemId?: string; sinceIso?: string; untilIso?: string }): WorkActivityRow[];
}

export function openDatabase(config: LovelaceConfig): DatabaseState {
  mkdirSync(config.lovelaceDir, { recursive: true });
  // Statements bind spread records; columns the SQL does not name are ignored.
  const db = new DatabaseSync(join(config.lovelaceDir, 'state.db'), { allowUnknownNamedParameters: true });
  db.exec('pragma journal_mode = WAL');
  db.exec('pragma foreign_keys = ON');
  // Records bind by name and rows are cast to their record types at each call site.
  const prepare = (sql: string) => db.prepare(sql) as unknown as Statement;
  let savepoint = 0;
  function transaction<T>(fn: () => T): T {
    const name = `lovelace_${savepoint++}`;
    db.exec(`savepoint ${name}`);
    try {
      const result = fn();
      db.exec(`release ${name}`);
      return result;
    } catch (error) {
      db.exec(`rollback to ${name}`);
      db.exec(`release ${name}`);
      throw error;
    }
  }

  db.exec(`
    create table if not exists repos (
      id text primary key,
      provider text not null,
      external_id text not null,
      name text not null,
      full_name text not null,
      clone_url text not null,
      default_branch text,
      is_archived integer not null default 0,
      topics_json text not null default '[]',
      last_synced_at text not null,
      unique(provider, external_id)
    );

    create table if not exists cache_snapshots (
      key text primary key,
      fetched_at text not null,
      payload_json text not null
    );

    create table if not exists work_items (
      id text primary key,
      title text not null,
      state text not null,
      notes text,
      created_at text not null,
      updated_at text not null,
      started_at text,
      completed_at text
    );

    create table if not exists work_item_meta (
      id text primary key,
      work_item_id text not null,
      meta_type text not null,
      provider text not null,
      external_id text,
      payload_json text,
      created_at text not null,
      updated_at text not null,
      foreign key(work_item_id) references work_items(id) on delete cascade
    );

    create table if not exists inbox_meta (
      source_type text not null,
      provider text not null,
      external_id text not null,
      state text not null,
      created_at text not null,
      updated_at text not null,
      primary key (source_type, provider, external_id)
    );

    create table if not exists work_activity (
      id text primary key,
      work_item_id text not null,
      kind text not null,
      payload_json text,
      occurred_at text not null,
      dedupe_key text,
      foreign key(work_item_id) references work_items(id) on delete cascade
    );
    create index if not exists work_activity_occurred_at_idx on work_activity(occurred_at);
    create index if not exists work_activity_work_item_idx on work_activity(work_item_id);
    create table if not exists work_launch_operations (
      request_id text primary key,
      operation_kind text not null,
      input_json text not null,
      work_item_id text not null references work_items(id),
      draft_meta_id text not null references work_item_meta(id),
      status text not null,
      outcome_json text,
      created_at text not null,
      updated_at text not null
    );
    create unique index if not exists work_activity_dedupe_idx on work_activity(dedupe_key) where dedupe_key is not null;
  `);


  const insertRepo = prepare(`
    insert into repos (id, provider, external_id, name, full_name, clone_url, default_branch, is_archived, topics_json, last_synced_at)
    values (@id, @provider, @externalId, @name, @fullName, @cloneUrl, @defaultBranch, @isArchived, @topicsJson, @lastSyncedAt)
  `);

  const mapRepo = (row: unknown): RepoRecord => {
    const record = row as Omit<RepoRecord, 'isArchived' | 'topics'> & { isArchived: number; topicsJson: string };
    const { topicsJson, ...repository } = record;
    return { ...repository, isArchived: Boolean(record.isArchived), topics: JSON.parse(topicsJson) as string[] };
  };

  const insertWorkItem = prepare(`
    insert into work_items (id, title, state, notes, created_at, updated_at, started_at, completed_at)
    values (@id, @title, @state, @notes, @createdAt, @updatedAt, @startedAt, @completedAt)
  `);

  const updateWorkItemStatement = prepare(`
    update work_items
    set title = @title,
        notes = @notes,
        updated_at = @updatedAt
    where id = @id
  `);

  const updateWorkItemStateStatement = prepare(`
    update work_items
    set state = @state,
        updated_at = @updatedAt,
        started_at = @startedAt,
        completed_at = @completedAt
    where id = @id
  `);

  const touchWorkItemStatement = prepare(`
    update work_items
    set updated_at = @updatedAt
    where id = @id
  `);

  const selectWorkItemById = prepare(
    'select id, title, state, notes, created_at as createdAt, updated_at as updatedAt, started_at as startedAt, completed_at as completedAt from work_items where id = ?',
  );

  const insertWorkItemMeta = prepare(`
    insert into work_item_meta (id, work_item_id, meta_type, provider, external_id, payload_json, created_at, updated_at)
    values (@id, @workItemId, @metaType, @providerKey, @externalId, @payloadJson, @createdAt, @updatedAt)
  `);

  const updateWorkItemMetaPayloadStatement = prepare(`
    update work_item_meta
    set payload_json = @payloadJson,
        updated_at = @updatedAt
    where id = @id
  `);

  const selectWorkItemMetaById = prepare(
    "select id, work_item_id as workItemId, meta_type as metaType, nullif(provider, '') as provider, external_id as externalId, payload_json as payloadJson, created_at as createdAt, updated_at as updatedAt from work_item_meta where id = ?",
  );

  const deleteWorkItemMetaByExternalId = prepare(`
    delete from work_item_meta
    where work_item_id = ? and meta_type = ? and provider = ? and external_id = ?
  `);

  const upsertCacheSnapshot = prepare(`
    insert into cache_snapshots (key, fetched_at, payload_json)
    values (@key, @fetchedAt, @payloadJson)
    on conflict(key) do update set
      fetched_at = excluded.fetched_at,
      payload_json = excluded.payload_json
  `);

  const upsertInboxMetaStatement = prepare(`
    insert into inbox_meta (source_type, provider, external_id, state, created_at, updated_at)
    values (@sourceType, @providerKey, @externalId, @state, @createdAt, @updatedAt)
    on conflict(source_type, provider, external_id) do update set
      state = excluded.state,
      updated_at = excluded.updated_at
  `);

  const deleteInboxMetaStatement = prepare(`
    delete from inbox_meta where source_type = ? and provider = ? and external_id = ?
  `);

  const insertWorkActivity = prepare(`
    insert into work_activity (id, work_item_id, kind, payload_json, occurred_at, dedupe_key)
    values (@id, @workItemId, @kind, @payloadJson, @occurredAt, @dedupeKey)
  `);

  function recordWorkActivity(input: RecordWorkActivityInput): WorkActivityRow {
    const row: WorkActivityRow = {
      id: randomUUID(),
      workItemId: input.workItemId,
      kind: input.kind,
      payloadJson: input.payload === undefined || input.payload === null ? null : JSON.stringify(input.payload),
      occurredAt: input.occurredAt ?? new Date().toISOString(),
    };
    insertWorkActivity.run({ ...row, dedupeKey: input.dedupeKey ?? null });
    return row;
  }

  return {
    db,
    transaction,
    getRepoCount() {
      const row = prepare('select count(*) as count from repos').get() as { count?: number };
      return Number(row.count ?? 0);
    },
    getWorkItemCount() {
      const row = prepare('select count(*) as count from work_items').get() as { count?: number };
      return Number(row.count ?? 0);
    },
    getLastRepoSyncAt() {
      const row = prepare('select max(last_synced_at) as fetchedAt from repos').get() as
        | { fetchedAt?: string }
        | undefined;
      return row?.fetchedAt ?? null;
    },
    replaceRepos(repos) {
      transaction(() => {
        prepare('delete from repos').run();
        for (const repo of repos) insertRepo.run({ ...repo, isArchived: repo.isArchived ? 1 : 0, topicsJson: JSON.stringify(repo.topics) });
      });
    },
    listRepos() {
      return prepare(
        'select id, provider, external_id as externalId, name, full_name as fullName, clone_url as cloneUrl, default_branch as defaultBranch, is_archived as isArchived, topics_json as topicsJson, last_synced_at as lastSyncedAt from repos order by full_name asc',
      ).all().map(mapRepo);
    },
    listWorkItems(state) {
      const query = state
        ? 'select id, title, state, notes, created_at as createdAt, updated_at as updatedAt, started_at as startedAt, completed_at as completedAt from work_items where state = ? order by updated_at desc'
        : 'select id, title, state, notes, created_at as createdAt, updated_at as updatedAt, started_at as startedAt, completed_at as completedAt from work_items order by updated_at desc';
      return (state ? prepare(query).all(state) : prepare(query).all()) as WorkItem[];
    },
    getWorkItem(id) {
      return (selectWorkItemById.get(id) as WorkItem | undefined) ?? null;
    },
    createWorkItem(workItem) {
      transaction(() => {
        insertWorkItem.run(workItem);
        recordWorkActivity({ workItemId: workItem.id, kind: 'work-item.created' });
        if (workItem.state === 'active') recordWorkActivity({ workItemId: workItem.id, kind: 'work-item.started' });
      });
      return workItem;
    },
    updateWorkItem(id, input) {
      const existing = (selectWorkItemById.get(id) as WorkItem | undefined) ?? null;
      if (!existing) return null;
      const title = input.title ?? existing.title;
      const notes = input.notes === undefined ? existing.notes : input.notes;
      transaction(() => {
        updateWorkItemStatement.run({ id, title, notes, updatedAt: new Date().toISOString() });
        if (existing.title !== title || existing.notes !== notes) {
          recordWorkActivity({ workItemId: id, kind: 'work-item.updated' });
        }
      });
      return (selectWorkItemById.get(id) as WorkItem | undefined) ?? null;
    },
    updateWorkItemState(id, state) {
      const existing = (selectWorkItemById.get(id) as WorkItem | undefined) ?? null;
      if (!existing) return null;
      const now = new Date().toISOString();
      const startedAt = existing.startedAt ?? now;
      const completedAt = state === 'active' ? null : now;
      if (existing.state === state) return existing;
      transaction(() => {
        updateWorkItemStateStatement.run({ id, state, updatedAt: now, startedAt, completedAt });
        recordWorkActivity({
          workItemId: id,
          kind: state === 'active' ? 'work-item.started' : state === 'done' ? 'work-item.completed' : 'work-item.cancelled',
          payload: { from: existing.state, state },
        });
      });
      return (selectWorkItemById.get(id) as WorkItem | undefined) ?? null;
    },
    touchWorkItem(id) {
      const existing = (selectWorkItemById.get(id) as WorkItem | undefined) ?? null;
      if (!existing) return null;
      touchWorkItemStatement.run({ id, updatedAt: new Date().toISOString() });
      return (selectWorkItemById.get(id) as WorkItem | undefined) ?? null;
    },
    listWorkItemMeta(workItemId) {
      const query = workItemId
        ? "select id, work_item_id as workItemId, meta_type as metaType, nullif(provider, '') as provider, external_id as externalId, payload_json as payloadJson, created_at as createdAt, updated_at as updatedAt from work_item_meta where work_item_id = ? order by created_at asc"
        : "select id, work_item_id as workItemId, meta_type as metaType, nullif(provider, '') as provider, external_id as externalId, payload_json as payloadJson, created_at as createdAt, updated_at as updatedAt from work_item_meta order by created_at asc";
      return (workItemId ? prepare(query).all(workItemId) : prepare(query).all()) as WorkItemMeta[];
    },
    createWorkItemMetas(metas) {
      transaction(() => {
        for (const meta of metas) {
          insertWorkItemMeta.run({ ...meta, providerKey: providerKey(meta.provider) });
          const kind = meta.metaType === 'session' ? 'session.created'
            : meta.metaType === 'tracker-item' ? 'work-item.tracker-attached'
            : meta.metaType === 'pull-request' ? 'work-item.pull-request-attached'
            : meta.metaType === 'repository' ? 'work-item.repository-attached' : null;
          if (kind) recordWorkActivity({ workItemId: meta.workItemId, kind, payload: { metaId: meta.id, provider: meta.provider, externalId: meta.externalId } });
        }
      });
      return metas;
    },
    updateWorkItemMetaPayload(id, payload) {
      const existing = (selectWorkItemMetaById.get(id) as WorkItemMeta | undefined) ?? null;
      if (!existing) return null;
      updateWorkItemMetaPayloadStatement.run({
        id,
        payloadJson: JSON.stringify(payload),
        updatedAt: new Date().toISOString(),
      });
      return (selectWorkItemMetaById.get(id) as WorkItemMeta | undefined) ?? null;
    },
    deleteWorkItemMetasByExternalIds(workItemId, metaType, provider, externalIds) {
      transaction(() => {
        for (const externalId of externalIds) {
          deleteWorkItemMetaByExternalId.run(workItemId, metaType, providerKey(provider), externalId);
        }
      });
    },
    listInboxMeta() {
      return prepare(
        "select source_type as sourceType, nullif(provider, '') as provider, external_id as externalId, state, created_at as createdAt, updated_at as updatedAt from inbox_meta order by updated_at desc",
      ).all() as InboxMeta[];
    },
    upsertInboxMeta(entry) {
      upsertInboxMetaStatement.run({
        ...entry,
        providerKey: providerKey(entry.provider),
      });
      return entry;
    },
    deleteInboxMeta(sourceType, provider, externalId) {
      deleteInboxMetaStatement.run(sourceType, providerKey(provider), externalId);
    },
    cacheStorage: {
      load: () => prepare('select key, fetched_at as fetchedAt, payload_json as payloadJson from cache_snapshots').all() as CacheSnapshot[],
      save: (snapshot) => { upsertCacheSnapshot.run(snapshot); },
      delete: (key) => { prepare('delete from cache_snapshots where key = ?').run(key); },
    },
    getLaunchOperation(requestId) {
      return prepare('select request_id as requestId, operation_kind as kind, input_json as inputJson, work_item_id as workItemId, draft_meta_id as draftMetaId, status, outcome_json as outcomeJson, created_at as createdAt, updated_at as updatedAt from work_launch_operations where request_id = ?').get(requestId) as LaunchOperation | undefined ?? null;
    },
    listLaunchOperations(workItemId) {
      const where = workItemId ? ' where work_item_id = ?' : '';
      const query = prepare(`select request_id as requestId, operation_kind as kind, input_json as inputJson, work_item_id as workItemId, draft_meta_id as draftMetaId, status, outcome_json as outcomeJson, created_at as createdAt, updated_at as updatedAt from work_launch_operations${where} order by created_at asc, rowid asc`);
      return (workItemId ? query.all(workItemId) : query.all()) as LaunchOperation[];
    },
    updateLaunchOperationPhase(requestId, phase) {
      prepare("update work_launch_operations set outcome_json = ?, updated_at = ? where request_id = ? and status = 'pending'")
        .run(JSON.stringify({ ok: false, error: null, phase }), new Date().toISOString(), requestId);
    },
    createLaunchOperation(input) {
      const now = new Date().toISOString();
      const operation: LaunchOperation = { ...input, status: 'pending', outcomeJson: null, createdAt: now, updatedAt: now };
      prepare('insert into work_launch_operations values (@requestId,@kind,@inputJson,@workItemId,@draftMetaId,@status,@outcomeJson,@createdAt,@updatedAt)').run(operation);
      return operation;
    },
    finishLaunchOperation(requestId, status, outcome) {
      prepare('update work_launch_operations set status = ?, outcome_json = ?, updated_at = ? where request_id = ?').run(status, JSON.stringify(outcome), new Date().toISOString(), requestId);
    },
    recordWorkActivityOnce(key, input) {
      return transaction(() => {
        if (prepare('select id from work_activity where dedupe_key = ?').get(key)) return null;
        return recordWorkActivity({ ...input, dedupeKey: key });
      });
    },
    recordWorkActivity,
    listWorkActivity(input) {
      const clauses: string[] = [];
      const params: Record<string, string> = {};
      if (input?.workItemId) { clauses.push('work_item_id = @workItemId'); params.workItemId = input.workItemId; }
      if (input?.sinceIso) { clauses.push('occurred_at >= @sinceIso'); params.sinceIso = input.sinceIso; }
      if (input?.untilIso) { clauses.push('occurred_at < @untilIso'); params.untilIso = input.untilIso; }
      const where = clauses.length > 0 ? ` where ${clauses.join(' and ')}` : '';
      return prepare(
        `select id, work_item_id as workItemId, kind, payload_json as payloadJson, occurred_at as occurredAt from work_activity${where} order by occurred_at asc`,
      ).all(params) as WorkActivityRow[];
    },
  };
}

function providerKey(value: string | null): string {
  return value ?? '';
}
