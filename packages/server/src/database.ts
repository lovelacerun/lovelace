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
  Launch,
  LaunchState,
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

export type LaunchKind = 'quick-start' | 'new-session';

/** A launch as stored, with the request it was created by. */
export interface LaunchRecord extends Launch {
  kind: LaunchKind;
  /** Canonical request body; a request ID only ever replays this request. */
  requestJson: string;
  /** Server boot that last ran the launch. */
  bootId: string;
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
  /** Identifies this server process; launches of earlier boots are no longer running. */
  bootId: string;
  getLaunch(id: string): LaunchRecord | null;
  /** Oldest first. */
  listLaunches(workItemId?: string): LaunchRecord[];
  createLaunch(launch: Omit<LaunchRecord, 'state' | 'error' | 'bootId' | 'createdAt' | 'updatedAt'>): LaunchRecord;
  /** Moves a launch to `state`, claiming it for this boot. */
  setLaunchState(id: string, state: LaunchState, error?: string | null): void;
  /** Marks launches left in progress by an earlier boot uncertain. */
  recoverInterruptedLaunches(): void;
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

  const bootId = randomUUID();

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
    bootId,
    getLaunch(id) {
      const row = prepare(`select ${LAUNCH_COLUMNS} from launches where id = ?`).get(id);
      return row ? fromLaunchRow(row as Record<string, unknown>) : null;
    },
    listLaunches(workItemId) {
      const query = prepare(`select ${LAUNCH_COLUMNS} from launches${workItemId ? ' where work_item_id = ?' : ''} order by created_at asc, rowid asc`);
      return (workItemId ? query.all(workItemId) : query.all()).map(row => fromLaunchRow(row as Record<string, unknown>));
    },
    createLaunch(input) {
      const now = new Date().toISOString();
      const launch: LaunchRecord = { ...input, state: 'accepted', error: null, bootId, createdAt: now, updatedAt: now };
      prepare(`insert into launches (id, work_item_id, kind, request_json, harness, options_json, repo_ids_json, prompt_id, prompt, state, error, boot_id, created_at, updated_at)
        values (@id, @workItemId, @kind, @requestJson, @harness, @optionsJson, @repoIdsJson, @promptId, @prompt, @state, @error, @bootId, @createdAt, @updatedAt)`)
        .run({ ...launch, optionsJson: launch.options ? JSON.stringify(launch.options) : null, repoIdsJson: JSON.stringify(launch.repoIds) });
      return launch;
    },
    setLaunchState(id, state, error = null) {
      prepare('update launches set state = ?, error = ?, boot_id = ?, updated_at = ? where id = ?').run(state, error, bootId, new Date().toISOString(), id);
    },
    recoverInterruptedLaunches() {
      prepare(`update launches set state = 'uncertain', error = ?, updated_at = ? where state in ('accepted', 'preparing', 'starting') and boot_id != ?`)
        .run('launch outcome uncertain after interruption; check Herdr before an explicit new launch', new Date().toISOString(), bootId);
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

/** The launch as clients see it. */
export function toLaunch({ kind: _kind, requestJson: _request, bootId: _boot, ...launch }: LaunchRecord): Launch {
  return launch;
}

const LAUNCH_COLUMNS = `id, work_item_id as workItemId, kind, request_json as requestJson, harness, options_json as optionsJson,
  repo_ids_json as repoIdsJson, prompt_id as promptId, prompt, state, error, boot_id as bootId, created_at as createdAt, updated_at as updatedAt`;

function fromLaunchRow(row: Record<string, unknown>): LaunchRecord {
  const { optionsJson, repoIdsJson, ...launch } = row;
  return {
    ...launch as Omit<LaunchRecord, 'options' | 'repoIds'>,
    ...optionsJson ? { options: JSON.parse(optionsJson as string) as LaunchRecord['options'] } : {},
    repoIds: JSON.parse(repoIdsJson as string) as string[],
  };
}

function providerKey(value: string | null): string {
  return value ?? '';
}
