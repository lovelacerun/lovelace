import assert from 'node:assert/strict';
import test from 'node:test';
import type { RepositoryWorkspaceMetaPayload, WorkItemDetails } from '@lovelace/core';
import { ApiError, LovelaceClient } from './client.js';
import { WorkspacePreparationWaitError } from './workspace-preparation.js';

const workspace = (repoId: string, status: RepositoryWorkspaceMetaPayload['status']): RepositoryWorkspaceMetaPayload => ({
  repoId, repoName: repoId, repoPath: `/repos/${repoId}`, role: 'primary', workspaceMode: 'fresh',
  worktreePath: `/work/${repoId}`, branchName: 'lovelace/fixture', baseBranch: 'main', remoteBranch: null,
  sourceExternalId: null, installCommand: null, installedAt: null, cleanedAt: null, preparedAt: '2026-01-01T00:00:00Z', status,
});
const details = (...workspaces: RepositoryWorkspaceMetaPayload[]): WorkItemDetails => ({
  workItem: { id: 'work', title: 'Fixture', state: 'active', notes: null, createdAt: '', updatedAt: '', startedAt: null, completedAt: null },
  metas: workspaces.map(payload => ({
    id: payload.repoId, workItemId: 'work', metaType: 'repository', provider: 'github', externalId: payload.repoId,
    payloadJson: JSON.stringify(payload), createdAt: '', updatedAt: '',
  })),
});

test('polling survives preparation longer than the default 15-second HTTP deadline; partial failure remains data', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let completed = false;
  let posts = 0;
  const fetchFn: typeof fetch = async (_input, init) => {
    if (init?.method === 'POST') {
      posts++;
      assert.deepEqual(JSON.parse(String(init.body)), { repositories: [{ repoId: 'a' }, { repoId: 'b' }], wait: false });
    }
    return Response.json(completed
      ? details({ ...workspace('a', 'ready'), dependenciesReused: true }, { ...workspace('b', 'failed'), errorMessage: 'install failed' })
      : details(workspace('a', 'preparing'), workspace('b', 'pending')));
  };
  const client = new LovelaceClient('http://localhost:27421', fetchFn);
  const progress: string[][] = [];
  let finished = false;
  const promise = client.prepareRepositories('work', [{ repoId: 'a' }, { repoId: 'b' }], {
    onProgress: workspaces => progress.push(workspaces.map(workspace => workspace.status)),
  }).then(result => { finished = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(progress, [['preparing', 'pending']]);
  t.mock.timers.tick(20_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false, 'slow preparation did not expire with the ordinary request deadline');
  completed = true;
  t.mock.timers.tick(1_000);
  const result = await promise;
  assert.equal(posts, 1);
  assert.deepEqual(progress.at(-1), ['ready', 'failed']);
  assert.equal(JSON.parse(result.metas[0]!.payloadJson!).dependenciesReused, true);
});

test('interrupting the wait reports still preparing and an inspect command, removes listeners and never resubmits', async () => {
  const controller = new AbortController();
  let calls = 0, added = 0, removed = 0;
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args: Parameters<AbortSignal['addEventListener']>) => { added++; add(...args); };
  controller.signal.removeEventListener = (...args: Parameters<AbortSignal['removeEventListener']>) => { removed++; remove(...args); };
  const fetchFn: typeof fetch = async () => { calls++; return Response.json(details(workspace('a', 'preparing'))); };
  const client = new LovelaceClient('http://localhost:27421', fetchFn);
  const promise = client.prepareRepositories('work', [{ repoId: 'a' }], { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new DOMException('fixture interrupt', 'AbortError'));
  await assert.rejects(promise, error => {
    assert.ok(error instanceof WorkspacePreparationWaitError);
    assert.match(error.message, /a: preparing/);
    assert.match(error.message, /not cancelled/);
    assert.match(error.message, /lovelace work-items workspaces work/);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(added, removed);
});

test('poll request timeout distinguishes server preparation failure from a failed wait', async () => {
  let calls = 0;
  const fetchFn: typeof fetch = async (_input, init) => {
    calls++;
    if (init?.method === 'POST') return Response.json(details(workspace('a', 'pending')));
    if (calls === 2) return new Promise(() => {});
    return Response.json(details({ ...workspace('a', 'failed'), errorMessage: 'npm ci failed' }));
  };
  const client = new LovelaceClient('http://localhost:27421', fetchFn);
  await assert.rejects(client.prepareRepositories('work', [{ repoId: 'a' }], { timeoutMs: 20, pollIntervalMs: 1 }), error => {
    assert.ok(error instanceof WorkspacePreparationWaitError);
    assert.match(error.message, /a: failed/);
    assert.ok(error.cause instanceof DOMException && error.cause.name === 'TimeoutError');
    return true;
  });
  assert.equal(calls, 3, 'only a read is attempted after a poll timeout');
});

test('HTTP validation errors stay ApiError; unknown timeout state is explicit', async () => {
  const rejected = new LovelaceClient('http://localhost:27421', async () => Response.json({ error: 'Unknown repository' }, { status: 400 }));
  await assert.rejects(rejected.prepareRepositories('work', [{ repoId: 'a' }]), error => error instanceof ApiError && error.status === 400);
  const unreachable = new LovelaceClient('http://localhost:27421', async () => new Promise(() => {}));
  await assert.rejects(unreachable.prepareRepositories('work', [{ repoId: 'a' }], { timeoutMs: 10 }), /unknown.*submission may have reached the server/);
});
