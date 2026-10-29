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
