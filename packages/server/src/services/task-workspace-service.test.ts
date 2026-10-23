import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureTaskWorkspacePath, workItemIdForPath } from './task-workspace-service.js';

test('paths inside a task workspace resolve to their work item', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-task-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaces = join(root, 'workspaces');
  const id = '0123abcd-0000-4000-8000-000000000000';
  const ids = [id, '99999999-0000-4000-8000-000000000000'];
  const task = ensureTaskWorkspacePath(workspaces, id, [], 'Fixture work');
  assert.equal(workItemIdForPath(workspaces, task, ids), id);
  assert.equal(workItemIdForPath(workspaces, join(task, 'repo-a', 'src'), ids), id);
  assert.equal(workItemIdForPath(workspaces, workspaces, ids), null);
  assert.equal(workItemIdForPath(workspaces, root, ids), null);
  assert.equal(workItemIdForPath(workspaces, join(workspaces, 'unrelated'), ids), null);
  assert.equal(workItemIdForPath(workspaces, task, [id, '0123abcd-1111-4000-8000-000000000000']), null);
});
