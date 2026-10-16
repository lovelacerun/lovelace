import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { LovelaceClient, WorkspacePreparationWaitError } from '@lovelace/client';
import type { CreateWorkspaceRequest, PreparedRepositoryWorkspace } from '@lovelace/coriol';
import type { LovelaceConfig, WorkItemDetails } from '@lovelace/core';
import { buildServer } from '../app.js';
import { openDatabase } from '../database.js';
import { repositoryWorkspaces } from '../helpers.js';
import { createManualWorkItem } from '../repositories/work-item-repository.js';
import { FakeHerdr } from '../test-support/fake-herdr.js';
import { fixtureProviders } from '../test-support/providers.js';
import { recoverInterruptedRepositoryPreparations } from '../services/work-start-service.js';
import type { RouteDeps } from './deps.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-workspace-preparation-'));
  const config: LovelaceConfig = {
    domainRoot: root, lovelaceDir: join(root, '.lovelace'), port: 27421, logLevel: 'info',
    syncIntervalMs: 300_000, defaultAgent: 'pi', tui: { sidebarSide: 'right' },
  };
  const database = openDatabase(config);
  const providers = fixtureProviders();
  const herdr = new FakeHerdr();
  const work = createManualWorkItem(database, { title: 'Fixture preparation' });
  const records = ['a', 'b', 'c'].map(name => ({
    id: name, provider: 'github', externalId: name, name, fullName: `org/${name}`,
    cloneUrl: `https://github.invalid/org/${name}.git`, defaultBranch: 'main', isArchived: false,
    topics: [], lastSyncedAt: new Date().toISOString(),
  }));
  database.replaceRepos(records);
  const calls: CreateWorkspaceRequest[] = [];
  const pending = new Map<CreateWorkspaceRequest, { resolve: (value: PreparedRepositoryWorkspace) => void; reject: (error: Error) => void }>();
  const workspacesDirectory = join(config.lovelaceDir, 'workspaces');
  const workspaceManager = {
    workspacesDirectory,
    repositoryPath: (id: string) => join(config.lovelaceDir, 'repos', id),
    createWorkspace(request: CreateWorkspaceRequest): Promise<PreparedRepositoryWorkspace> {
      calls.push(request);
      assert.equal(repositoryWorkspaces(database.listWorkItemMeta(work.id)).find(entry => basename(entry.payload.worktreePath) === request.directoryName)?.payload.status, 'pending');
      return new Promise((resolve, reject) => { pending.set(request, { resolve, reject }); });
    },
  } as unknown as RouteDeps['workspaceManager'];
  const app = buildServer({
    config, database, tools: [], listModels: async () => [], cache: providers.cache, github: providers.github, jira: providers.jira,
    releaseChecker: {} as RouteDeps['releaseChecker'], workspaceManager, herdr,
  });
  const url = `/work-items/${work.id}/repositories`;
  const submit = (repoIds: string[], wait = false) => app.inject({
    method: 'POST', url, payload: { repositories: repoIds.map(repoId => ({ repoId })), wait },
  });
  const payloads = () => repositoryWorkspaces(database.listWorkItemMeta(work.id)).map(entry => entry.payload);
  const latestCall = (repoId: string) => calls.findLast(request => request.repository.id.endsWith(`/${repoId}`))!;
  const start = (repoId: string) => {
    const request = latestCall(repoId);
    request.onEvent?.({ type: 'seed.preparing', repositoryId: request.repository.id, path: workspaceManager.repositoryPath(request.repository.id), command: 'npm ci' });
  };
  const finish = async (repoId: string, fail = false) => {
    const request = latestCall(repoId);
    const gate = pending.get(request)!;
    pending.delete(request);
    if (fail) gate.reject(new Error(`fixture ${repoId} install failure`));
    else {
      const path = join(workspacesDirectory, request.workspaceId, request.directoryName!);
      await mkdir(path, { recursive: true });
      gate.resolve({
        repository: { ...request.repository, path: workspaceManager.repositoryPath(request.repository.id) },
        workspaceId: request.workspaceId, path, branchName: request.branchName, baseBranch: 'main', remoteBranch: null,
        preparations: [{ toolchain: 'npm', command: 'npm ci', strategy: 'reflink', preparedAt: new Date().toISOString() }],
      });
    }
    await new Promise(resolve => setImmediate(resolve));
  };
  t.after(async () => {
    for (const gate of pending.values()) gate.reject(new Error('fixture teardown'));
    await new Promise(resolve => setImmediate(resolve));
    await app.close(); database.db.close(); await rm(root, { recursive: true, force: true });
  });
  return { app, database, work, config, herdr, calls, payloads, start, finish, submit, url };
}

test('slow preparation is accepted immediately with durable pending/preparing state and per-repository progress', async t => {
  const f = await fixture(t);
  const accepted = await f.submit(['a', 'b']);
  assert.equal(accepted.statusCode, 202);
  assert.deepEqual(repositoryWorkspaces(accepted.json<WorkItemDetails>().metas).map(entry => entry.payload.status), ['pending', 'pending']);
  assert.equal(f.calls.length, 2);
  f.start('a');
  const details = (await f.app.inject(`/work-items/${f.work.id}`)).json<WorkItemDetails>();
  const states = repositoryWorkspaces(details.metas).map(entry => entry.payload);
  assert.equal(states[0]!.status, 'preparing');
  assert.equal(states[0]!.preparationStep, 'seed.preparing: npm ci');
  assert.equal(states[1]!.status, 'pending');
  const reader = openDatabase(f.config);
  try { assert.equal(repositoryWorkspaces(reader.listWorkItemMeta(f.work.id))[0]!.payload.status, 'preparing'); }
  finally { reader.db.close(); }
  await f.finish('a');
  assert.deepEqual(f.payloads().map(payload => payload.status), ['ready', 'pending']);
  assert.equal(f.payloads()[0]!.dependenciesReused, true);
  await f.finish('b');
  const ids = f.database.listWorkItemMeta(f.work.id).map(meta => meta.id);
  assert.equal((await f.submit(['a', 'b'], true)).statusCode, 200, 'legacy route still waits and returns details');
  assert.equal(f.calls.length, 2, 'ready worktrees are reused without fetching/installing again');
  assert.deepEqual(f.database.listWorkItemMeta(f.work.id).map(meta => meta.id), ids);
  assert.equal(f.herdr.calls.length, 0);
});

test('duplicate selections, overlapping batches and concurrent legacy retries share one operation per repository', async t => {
  const f = await fixture(t);
  await Promise.all([f.submit(['a', 'a', 'b']), f.submit(['b', 'c']), f.submit(['a'])]);
  let legacyCompleted = false;
  const legacy = f.submit(['a'], true).then(response => { legacyCompleted = true; return response; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(legacyCompleted, false);
  assert.equal(f.calls.length, 3);
  assert.equal(f.payloads().length, 3);
  // Startup recovery must not mark another route's active operations failed.
  recoverInterruptedRepositoryPreparations(f.database);
  assert.ok(f.payloads().every(payload => payload.status === 'pending'));
  await f.finish('a');
  const response = await legacy;
  assert.equal(response.statusCode, 200);
  assert.equal(repositoryWorkspaces(response.json<WorkItemDetails>().metas).find(entry => entry.payload.repoId === 'a')!.payload.status, 'ready');
  await f.finish('b'); await f.finish('c');
  assert.equal(f.calls.length, 3);
  assert.ok(f.payloads().every(payload => payload.status === 'ready'));
});

test('a repository carries several branches; each is reused and stacks on its requested base', async t => {
  const f = await fixture(t);
  const submit = (repositories: Array<{ repoId: string; branchName?: string; baseBranch?: string }>) =>
    f.app.inject({ method: 'POST', url: f.url, payload: { repositories, wait: false } });
  await submit([{ repoId: 'a' }]);
  await f.finish('a');
  await submit([{ repoId: 'a', branchName: 'stack/child', baseBranch: 'parent' }]);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1]!.branchName, 'stack/child');
  assert.equal(f.calls[1]!.baseBranch, 'parent');
  await f.finish('a');
  await Promise.all([submit([{ repoId: 'a' }]), submit([{ repoId: 'a', branchName: 'stack/child' }])]);
  assert.equal(f.calls.length, 2, 'both worktrees are reused');
  assert.equal(new Set(f.payloads().map(payload => payload.worktreePath)).size, 2);
  assert.deepEqual(f.payloads().map(payload => payload.status), ['ready', 'ready']);
});

test('partial batch failure is visible while siblings prepare; retries keep paths and only retry failures', async t => {
  const f = await fixture(t);
  await f.submit(['a', 'b', 'c']);
  const paths = f.payloads().map(payload => payload.worktreePath);
  await f.finish('a'); await f.finish('b', true);
  assert.deepEqual(f.payloads().map(payload => payload.status), ['ready', 'failed', 'pending']);
  assert.match(f.payloads()[1]!.errorMessage!, /fixture b install failure/);
  await Promise.all([f.submit(['a', 'b', 'c']), f.submit(['b'])]);
  assert.equal(f.calls.length, 4, 'only b is retried; c joins the original preparation');
  await f.finish('b'); await f.finish('c');
  assert.deepEqual(f.payloads().map(payload => payload.worktreePath), paths);
  assert.ok(f.payloads().every(payload => payload.status === 'ready' && payload.dependenciesReused));
});

test('lost client reply times out without cancelling server preparation; error provides inspection command and retry joins', async t => {
  const f = await fixture(t);
  let loseReply = true;
  let posts = 0;
  const fetchFn: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const response = await f.app.inject({ method: init?.method === 'POST' ? 'POST' : 'GET', url: path, payload: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (init?.method === 'POST') {
      posts++;
      if (loseReply) return new Promise(() => {}); // The request arrived; the reply is lost.
    }
    return Response.json(response.json(), { status: response.statusCode });
  };
  const client = new LovelaceClient('http://127.0.0.1:27421', fetchFn);
  await assert.rejects(client.prepareRepositories(f.work.id, [{ repoId: 'a' }], { timeoutMs: 30, pollIntervalMs: 1 }), error => {
    assert.ok(error instanceof WorkspacePreparationWaitError);
    assert.match(error.message, /a: pending/);
    assert.match(error.message, new RegExp(`lovelace work-items workspaces ${f.work.id}`));
    assert.ok(error.cause instanceof DOMException && error.cause.name === 'TimeoutError');
    return true;
  });
  assert.equal(posts, 1, 'never automatically resubmit mutations');
  assert.equal(f.calls.length, 1);
  f.start('a');
  loseReply = false;
  const retry = client.prepareRepositories(f.work.id, [{ repoId: 'a' }], { pollIntervalMs: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 1);
  await f.finish('a');
  assert.equal(repositoryWorkspaces((await retry).metas)[0]!.payload.status, 'ready');
  assert.equal(f.calls.length, 1);
});

test('HTTP timeout of a synchronous caller leaves preparation running and concurrent requests join it', async t => {
  const f = await fixture(t);
  const address = await f.app.listen({ port: 0, host: '127.0.0.1' });
  const client = new LovelaceClient(address);
  const request = client.requestJson(f.url, {
    method: 'POST', body: JSON.stringify({ repositories: [{ repoId: 'a' }] }),
  }, { timeoutMs: 100 });
  await assert.rejects(request, error => error instanceof DOMException && error.name === 'TimeoutError');
  assert.equal(f.calls.length, 1);
  assert.equal(f.payloads()[0]!.status, 'pending', 'the HTTP abort is not a provisioning failure');
  const accepted = await f.submit(['a']);
  assert.equal(accepted.statusCode, 202);
  assert.equal(f.calls.length, 1);
  await f.finish('a');
  assert.equal(repositoryWorkspaces((await client.getWorkItem(f.work.id)).metas)[0]!.payload.status, 'ready');
});

test('invalid batches do not start preparation or leave repository records', async t => {
  const f = await fixture(t);
  assert.equal((await f.submit(['a', 'missing'])).statusCode, 400);
  assert.equal((await f.app.inject({ method: 'POST', url: f.url, payload: { repositories: [], wait: 'no' } })).statusCode, 400);
  assert.equal((await f.app.inject({ method: 'POST', url: f.url, payload: 'null', headers: { 'content-type': 'application/json' } })).statusCode, 400);
  assert.equal(f.payloads().length, 0);
  assert.equal(f.calls.length, 0);
});

test('orphaned preparation after restart becomes an explicit retryable failure without deleting worktrees', async t => {
  const f = await fixture(t);
  await f.submit(['a']);
  await f.finish('a');
  const original = repositoryWorkspaces(f.database.listWorkItemMeta(f.work.id))[0]!;
  // Emulate durable state left by a process that exited mid-preparation.
  f.database.updateWorkItemMetaPayload(original.meta.id, { ...original.payload, status: 'preparing' });
  const separate = openDatabase(f.config);
  try {
    recoverInterruptedRepositoryPreparations(separate);
    const payload = repositoryWorkspaces(separate.listWorkItemMeta(f.work.id))[0]!.payload;
    assert.equal(payload.status, 'failed');
    assert.match(payload.errorMessage!, /server restart/);
    assert.equal(separate.getWorkItem(f.work.id)!.state, 'active');
  } finally { separate.db.close(); }
  await f.submit(['a']);
  assert.equal(f.calls.length, 2, 'orphaned preparation is explicitly retryable');
  await f.finish('a');
  assert.equal(f.payloads()[0]!.worktreePath, original.payload.worktreePath);
  assert.equal(f.payloads()[0]!.status, 'ready');
});
