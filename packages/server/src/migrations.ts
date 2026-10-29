import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

type Migration = (db: DatabaseSync) => void;

/**
 * Append only: entry `i` upgrades a database from `user_version` `i` to `i + 1`.
 * Never edit a released migration; add a new one instead.
 */
export const migrations: Migration[] = [
  // 1: baseline. Uses `if not exists` so databases created before versioning adopt it unchanged.
  (db) => db.exec(`
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
    create unique index if not exists work_activity_dedupe_idx on work_activity(dedupe_key) where dedupe_key is not null;

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
  `),

  // 2: typed attachments. Sessions and worktrees get their own tables; duplicates keep the row the server read first.
  (db) => db.exec(`
    create table work_item_attachments (
      id text primary key,
      work_item_id text not null references work_items(id) on delete cascade,
      type text not null,
      provider text,
      external_id text,
      payload_json text not null,
      created_at text not null,
      updated_at text not null
    );
    create index work_item_attachments_work_item_idx on work_item_attachments(work_item_id);
    create unique index work_item_attachments_link_idx on work_item_attachments(work_item_id, type, provider, external_id) where external_id is not null;
    create unique index work_item_attachments_herdr_workspace_idx on work_item_attachments(work_item_id) where type = 'herdr-workspace';

    insert into work_item_attachments (id, work_item_id, type, provider, external_id, payload_json, created_at, updated_at)
    select id, work_item_id, meta_type, coalesce(nullif(provider, ''), 'unknown'), coalesce(external_id, id), payload_json, created_at, updated_at
    from work_item_meta m
    where meta_type in ('tracker-item', 'change-request', 'pull-request') and json_valid(payload_json)
      and not exists (
        select 1 from work_item_meta d
        where d.work_item_id = m.work_item_id and d.meta_type = m.meta_type and d.provider = m.provider
          and coalesce(d.external_id, d.id) = coalesce(m.external_id, m.id) and json_valid(d.payload_json)
          and (d.created_at < m.created_at or (d.created_at = m.created_at and d.rowid < m.rowid))
      );

    insert into work_item_attachments (id, work_item_id, type, provider, external_id, payload_json, created_at, updated_at)
    select id, work_item_id, meta_type, null, null, payload_json, created_at, updated_at
    from work_item_meta
    where meta_type = 'prompt-draft' and json_valid(payload_json);

    insert into work_item_attachments (id, work_item_id, type, provider, external_id, payload_json, created_at, updated_at)
    select id, work_item_id, meta_type, null, null,
      json_object('workspaceId', coalesce(json_extract(payload_json, '$.workspaceId'), external_id)), created_at, updated_at
    from work_item_meta m
    where meta_type = 'herdr-workspace' and coalesce(json_extract(payload_json, '$.workspaceId'), external_id) is not null
      and not exists (
        select 1 from work_item_meta d
        where d.work_item_id = m.work_item_id and d.meta_type = m.meta_type
          and (d.created_at < m.created_at or (d.created_at = m.created_at and d.rowid < m.rowid))
      );

    create table worktrees (
      id text primary key,
      work_item_id text not null references work_items(id) on delete cascade,
      repo_id text not null,
      repo_name text not null,
      repo_path text not null,
      role text not null,
      workspace_mode text not null,
      worktree_path text not null,
      branch_name text,
      base_branch text,
      remote_branch text,
      source_external_id text,
      install_command text,
      installed_at text,
      dependencies_reused integer not null default 0,
      status text not null,
      preparation_step text,
      error_message text,
      cleaned_at text,
      prepared_at text not null,
      created_at text not null,
      updated_at text not null
    );
    create index worktrees_work_item_idx on worktrees(work_item_id);
    create unique index worktrees_path_idx on worktrees(worktree_path) where status != 'cleaned';

    insert into worktrees
    select id, work_item_id,
      coalesce(json_extract(payload_json, '$.repoId'), ''),
      coalesce(json_extract(payload_json, '$.repoName'), json_extract(payload_json, '$.repoId'), ''),
      coalesce(json_extract(payload_json, '$.repoPath'), ''),
      coalesce(json_extract(payload_json, '$.role'), 'primary'),
      json_extract(payload_json, '$.workspaceMode'),
      json_extract(payload_json, '$.worktreePath'),
      json_extract(payload_json, '$.branchName'),
      json_extract(payload_json, '$.baseBranch'),
      json_extract(payload_json, '$.remoteBranch'),
      json_extract(payload_json, '$.sourceExternalId'),
      json_extract(payload_json, '$.installCommand'),
      json_extract(payload_json, '$.installedAt'),
      coalesce(json_extract(payload_json, '$.dependenciesReused'), 0),
      coalesce(json_extract(payload_json, '$.status'), 'failed'),
      json_extract(payload_json, '$.preparationStep'),
      json_extract(payload_json, '$.errorMessage'),
      json_extract(payload_json, '$.cleanedAt'),
      coalesce(json_extract(payload_json, '$.preparedAt'), created_at),
      created_at, updated_at
    from work_item_meta m
    where meta_type = 'repository' and json_valid(payload_json)
      and json_extract(payload_json, '$.worktreePath') is not null
      and json_extract(payload_json, '$.workspaceMode') in ('fresh', 'change-request')
      and (json_extract(payload_json, '$.status') = 'cleaned' or not exists (
        select 1 from work_item_meta d
        where d.meta_type = 'repository' and json_valid(d.payload_json)
          and json_extract(d.payload_json, '$.worktreePath') = json_extract(m.payload_json, '$.worktreePath')
          and json_extract(d.payload_json, '$.workspaceMode') in ('fresh', 'change-request')
          and coalesce(json_extract(d.payload_json, '$.status'), '') != 'cleaned'
          and (d.updated_at > m.updated_at or (d.updated_at = m.updated_at and d.rowid > m.rowid))
      ));

    create table sessions (
      id text primary key,
      work_item_id text not null references work_items(id) on delete cascade,
      tool_id text not null,
      agent_name text not null,
      terminal_workspace_id text,
      terminal_pane_id text,
      native_session_id text,
      native_session_path text,
      options_json text,
      prompt_id text,
      prompt text,
      prompt_pending integer not null default 0,
      title text,
      cwd text,
      status text not null,
      agent_state text not null,
      metadata_json text,
      created_at text not null,
      updated_at text not null
    );
    create index sessions_work_item_idx on sessions(work_item_id);
    create unique index sessions_agent_name_idx on sessions(agent_name);

    insert into sessions
    select id, work_item_id,
      coalesce(json_extract(payload_json, '$.toolId'), provider),
      json_extract(payload_json, '$.agentName'),
      json_extract(payload_json, '$.terminalRef.workspaceId'),
      json_extract(payload_json, '$.terminalRef.paneId'),
      json_extract(payload_json, '$.nativeSessionId'),
      json_extract(payload_json, '$.nativeSessionPath'),
      case when json_type(payload_json, '$.options') = 'object' then json_extract(payload_json, '$.options') end,
      json_extract(payload_json, '$.promptId'),
      json_extract(payload_json, '$.prompt'),
      coalesce(json_extract(payload_json, '$.promptPending'), 0),
      json_extract(payload_json, '$.title'),
      json_extract(payload_json, '$.cwd'),
      coalesce(json_extract(payload_json, '$.status'), 'ended'),
      coalesce(json_extract(payload_json, '$.agentState'), 'unknown'),
      case when json_type(payload_json, '$.metadata') in ('object', 'array') then json_extract(payload_json, '$.metadata') end,
      created_at, updated_at
    from work_item_meta m
    where meta_type = 'session' and json_valid(payload_json) and json_type(payload_json, '$.agentName') = 'text'
      and not exists (
        select 1 from work_item_meta d
        where d.meta_type = 'session' and json_valid(d.payload_json)
          and json_extract(d.payload_json, '$.agentName') = json_extract(m.payload_json, '$.agentName')
          and (d.created_at < m.created_at or (d.created_at = m.created_at and d.rowid < m.rowid))
      );

    create table launch_operations_next (
      request_id text primary key,
      operation_kind text not null,
      input_json text not null,
      work_item_id text not null references work_items(id),
      draft_meta_id text not null references work_item_attachments(id),
      status text not null,
      outcome_json text,
      created_at text not null,
      updated_at text not null
    );
    insert into launch_operations_next select * from work_launch_operations;
    drop table work_launch_operations;
    drop table work_item_meta;
    alter table launch_operations_next rename to work_launch_operations;
  `),

  // 3: launches. Operations and their prompt drafts become one row with a single state; unfinished ones become uncertain.
  (db) => db.exec(`
    create table launches (
      id text primary key,
      work_item_id text not null references work_items(id) on delete cascade,
      kind text not null,
      request_json text not null,
      harness text not null,
      options_json text,
      repo_ids_json text not null,
      prompt_id text,
      prompt text not null,
      state text not null,
      error text,
      boot_id text not null,
      created_at text not null,
      updated_at text not null
    );
    create index launches_work_item_idx on launches(work_item_id);

    insert into launches
    select o.request_id, o.work_item_id, o.operation_kind, o.input_json,
      coalesce(json_extract(d.payload_json, '$.toolIds[0]'), ''),
      case when json_type(d.payload_json, '$.toolOptions') = 'object' then json_extract(d.payload_json, '$.toolOptions') end,
      case when json_type(d.payload_json, '$.repoIds') = 'array' then json_extract(d.payload_json, '$.repoIds') else '[]' end,
      json_extract(d.payload_json, '$.promptId'),
      coalesce(json_extract(d.payload_json, '$.prompt'), json_extract(o.input_json, '$.prompt'), ''),
      case
        when o.status = 'completed' and json_extract(o.outcome_json, '$.ok') then 'started'
        when o.status = 'completed' then 'failed'
        else 'uncertain'
      end,
      case
        when o.status = 'completed' and json_extract(o.outcome_json, '$.ok') then null
        when o.status = 'pending' then 'launch outcome uncertain after interruption; check Herdr before an explicit new launch'
        else coalesce(json_extract(o.outcome_json, '$.error'), 'launch failed')
      end,
      '', o.created_at, o.updated_at
    from work_launch_operations o
    left join work_item_attachments d on d.id = o.draft_meta_id and json_valid(d.payload_json);

    insert into launches
    select d.id, d.work_item_id, 'new-session', '{}',
      coalesce(json_extract(d.payload_json, '$.toolIds[0]'), ''),
      case when json_type(d.payload_json, '$.toolOptions') = 'object' then json_extract(d.payload_json, '$.toolOptions') end,
      case when json_type(d.payload_json, '$.repoIds') = 'array' then json_extract(d.payload_json, '$.repoIds') else '[]' end,
      json_extract(d.payload_json, '$.promptId'),
      coalesce(json_extract(d.payload_json, '$.prompt'), ''),
      case when json_extract(d.payload_json, '$.status') = 'launched' then 'started' else 'uncertain' end,
      case when json_extract(d.payload_json, '$.status') = 'launched' then null
        else 'launch outcome uncertain after interruption; check Herdr before an explicit new launch' end,
      '', d.created_at, d.updated_at
    from work_item_attachments d
    where d.type = 'prompt-draft' and json_valid(d.payload_json)
      and not exists (select 1 from work_launch_operations o where o.draft_meta_id = d.id);

    drop table work_launch_operations;
    delete from work_item_attachments where type = 'prompt-draft';
  `),
];

/**
 * Upgrades `db` to the latest schema version. Existing databases are copied to
 * `<backupDir>/state-v<from>-<timestamp>.db` first; databases from a newer
 * Lovelace are refused untouched. Runs with foreign keys off so migrations can
 * rebuild tables; each one must leave every reference intact.
 */
export function migrateDatabase(db: DatabaseSync, backupDir: string, steps: Migration[] = migrations): void {
  const from = (db.prepare('pragma user_version').get() as { user_version: number }).user_version;
  if (from > steps.length) {
    throw new Error(`state.db has schema version ${from}, but this Lovelace supports up to ${steps.length}. Upgrade Lovelace to open it.`);
  }
  if (from === steps.length) return;

  const { count } = db.prepare('select count(*) as count from sqlite_master').get() as { count: number };
  if (count > 0) {
    mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replaceAll(':', '-');
    db.prepare('vacuum into ?').run(join(backupDir, `state-v${from}-${stamp}.db`));
  }

  for (let version = from; version < steps.length; version++) {
    db.exec('begin immediate');
    try {
      steps[version](db);
      if (db.prepare('pragma foreign_key_check').all().length > 0) {
        throw new Error(`Migration to schema version ${version + 1} left dangling references.`);
      }
      db.exec(`pragma user_version = ${version + 1}`);
      db.exec('commit');
    } catch (error) {
      db.exec('rollback');
      throw error;
    }
  }
}
