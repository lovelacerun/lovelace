import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync, type StatementResultingChanges } from 'node:sqlite';
import type { CacheSnapshot, CacheStorage } from '@lovelace/cache';
import type {
  Attachment,
  AttachmentType,
  InboxMeta,
  InboxSourceType,
  LinkAttachmentType,
  LovelaceConfig,
  RepoRecord,
  WorkItem,
  WorkItemAttachment,
  WorkItemState,
} from '@lovelace/core';
import { attachmentStore } from './attachments.js';
import { migrateDatabase } from './migrations.js';

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

const ATTACHED_ACTIVITY: Partial<Record<AttachmentType, WorkActivityKind>> = {
  'session': 'session.created',
  'tracker-item': 'work-item.tracker-attached',
  'pull-request': 'work-item.pull-request-attached',
  'worktree': 'work-item.repository-attached',
};

/** An attachment before the database assigned its ID and timestamps. */
export type NewAttachment = WorkItemAttachment extends infer A
  ? A extends WorkItemAttachment ? Omit<A, 'id' | 'createdAt' | 'updatedAt'> : never : never;

export interface Statement {
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
  /** All attachments, oldest first. */
  listAttachments(workItemId?: string): WorkItemAttachment[];
  listAttachmentsOfType<Type extends AttachmentType>(type: Type, workItemId?: string): Array<Attachment<Type>>;
  getAttachment<Type extends AttachmentType>(type: Type, id: string): Attachment<Type> | null;
  addAttachments(attachments: NewAttachment[]): WorkItemAttachment[];
  /** Replaces the payload; null when the attachment no longer exists. */
  updateAttachment<Type extends AttachmentType>(type: Type, id: string, payload: Attachment<Type>['payload']): Attachment<Type> | null;
  deleteLinkAttachments(workItemId: string, type: LinkAttachmentType, provider: string, externalIds: string[]): void;
  deleteAttachment(type: AttachmentType, id: string): void;
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

  try {
    migrateDatabase(db, join(config.lovelaceDir, 'backups'));
    db.exec('pragma foreign_keys = ON');
  } catch (error) {
    db.close();
    throw error;
  }

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

  const attachments = attachmentStore(prepare);

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
    listAttachments(workItemId) {
      return attachments.list(workItemId);
    },
    listAttachmentsOfType(type, workItemId) {
      return attachments.list(workItemId, type);
    },
    getAttachment(type, id) {
      return attachments.get(type, id);
    },
    addAttachments(inputs) {
      return transaction(() => inputs.map((input) => {
        const attachment = attachments.insert(input);
        const kind = ATTACHED_ACTIVITY[attachment.type];
        if (kind) {
          recordWorkActivity({
            workItemId: attachment.workItemId, kind,
            payload: { metaId: attachment.id, provider: 'provider' in attachment ? attachment.provider : null, externalId: 'externalId' in attachment ? attachment.externalId : null },
          });
        }
        return attachment;
      }));
    },
    updateAttachment(type, id, payload) {
      attachments.update(type, id, payload);
      return attachments.get(type, id);
    },
    deleteLinkAttachments(workItemId, type, provider, externalIds) {
      transaction(() => {
        for (const externalId of externalIds) attachments.deleteLink(workItemId, type, provider, externalId);
      });
    },
    deleteAttachment(type, id) {
      attachments.delete(type, id);
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
