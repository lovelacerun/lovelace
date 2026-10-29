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
];

/**
 * Upgrades `db` to the latest schema version. Existing databases are copied to
 * `<backupDir>/state-v<from>-<timestamp>.db` first; databases from a newer
 * Lovelace are refused untouched.
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
      db.exec(`pragma user_version = ${version + 1}`);
      db.exec('commit');
    } catch (error) {
      db.exec('rollback');
      throw error;
    }
  }
}
