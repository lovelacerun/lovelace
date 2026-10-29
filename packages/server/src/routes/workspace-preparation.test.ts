import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { CreateWorkspaceRequest, PreparedRepositoryWorkspace } from '@lovelace/coriol';
import { attachmentsOfType, type LovelaceConfig, type StartWorkRepositoryInput } from '@lovelace/core';
import { createTRPCClient, httpLink, TRPCClientError } from '@trpc/client';
import { buildServer } from '../app.js';
import { openDatabase } from '../database.js';
import { createManualWorkItem } from '../repositories/work-item-repository.js';
import type { AppRouter } from '../router.js';
import { FakeHerdr } from '../test-support/fake-herdr.js';
import { fixtureProviders } from '../test-support/providers.js';
import { callerFor, rejectsWith } from '../test-support/trpc.js';
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
      assert.equal(database.listAttachmentsOfType('worktree', work.id).find(entry => basename(entry.payload.worktreePath) === request.directoryName)?.payload.status, 'pending');
      return new Promise((resolve, reject) => { pending.set(request, { resolve, reject }); });
    },
  } as unknown as RouteDeps['workspaceManager'];
  const deps: RouteDeps = {
    config, database, tools: [], listModels: async () => [], cache: providers.cache, github: providers.github, jira: providers.jira,
    workspaceManager, herdr,
  };
  const api = callerFor(deps);
  const app = buildServer(deps);
  const add = (repositories: StartWorkRepositoryInput[], wait = false) => api.workItems.addRepositories({ id: work.id, repositories, wait });
  const submit = (repoIds: string[], wait = false) => add(repoIds.map(repoId => ({ repoId })), wait);
  const payloads = () => database.listAttachmentsOfType('worktree', work.id).map(entry => entry.payload);
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
  /** A tRPC client over real HTTP, for tests about the transport rather than the procedure. */
  const httpClient = async (fetchFn: typeof fetch = globalThis.fetch) => {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    return createTRPCClient<AppRouter>({ links: [httpLink({ url: `${address}/trpc`, fetch: fetchFn })] });
  };
  t.after(async () => {
    for (const gate of pending.values()) gate.reject(new Error('fixture teardown'));
    await new Promise(resolve => setImmediate(resolve));
    await app.close(); database.db.close(); await rm(root, { recursive: true, force: true });
  });
  return { api, app, database, work, config, herdr, calls, payloads, start, finish, add, submit, httpClient };
}

test('slow preparation is accepted immediately with durable pending/preparing state and per-repository progress', async t => {
  const f = await fixture(t);
  const accepted = await f.submit(['a', 'b']);
  assert.deepEqual(attachmentsOfType(accepted.attachments, 'worktree').map(entry => entry.payload.status), ['pending', 'pending']);
  assert.equal(f.calls.length, 2);
  f.start('a');
  const details = await f.api.workItems.get({ id: f.work.id });
  const states = attachmentsOfType(details.attachments, 'worktree').map(entry => entry.payload);
  assert.equal(states[0]!.status, 'preparing');
  assert.equal(states[0]!.preparationStep, 'seed.preparing: npm ci');
  assert.equal(states[1]!.status, 'pending');
  const reader = openDatabase(f.config);
  try { assert.equal(reader.listAttachmentsOfType('worktree', f.work.id)[0]!.payload.status, 'preparing'); }
  finally { reader.db.close(); }
  await f.finish('a');
  assert.deepEqual(f.payloads().map(payload => payload.status), ['ready', 'pending']);
  assert.equal(f.payloads()[0]!.dependenciesReused, true);
  await f.finish('b');
  const ids = f.database.listAttachments(f.work.id).map(meta => meta.id);
  const waited = await f.submit(['a', 'b'], true);
  assert.deepEqual(attachmentsOfType(waited.attachments, 'worktree').map(entry => entry.payload.status), ['ready', 'ready'], 'waiting callers get finished details');
  assert.equal(f.calls.length, 2, 'ready worktrees are reused without fetching/installing again');
  assert.deepEqual(f.database.listAttachments(f.work.id).map(meta => meta.id), ids);
  assert.equal(f.herdr.calls.length, 0);
});

test('duplicate selections, overlapping batches and concurrent waiting retries share one operation per repository', async t => {
  const f = await fixture(t);
  await Promise.all([f.submit(['a', 'a', 'b']), f.submit(['b', 'c']), f.submit(['a'])]);
  let waitingCompleted = false;
  const waiting = f.submit(['a'], true).then(response => { waitingCompleted = true; return response; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(waitingCompleted, false);
  assert.equal(f.calls.length, 3);
  assert.equal(f.payloads().length, 3);
  // Startup recovery must not mark another route's active operations failed.
  recoverInterruptedRepositoryPreparations(f.database);
  assert.ok(f.payloads().every(payload => payload.status === 'pending'));
  await f.finish('a');
  const response = await waiting;
  assert.equal(attachmentsOfType(response.attachments, 'worktree').find(entry => entry.payload.repoId === 'a')!.payload.status, 'ready');
  await f.finish('b'); await f.finish('c');
  assert.equal(f.calls.length, 3);
  assert.ok(f.payloads().every(payload => payload.status === 'ready'));
});

test('a repository carries several branches; each is reused and stacks on its requested base', async t => {
  const f = await fixture(t);
  await f.add([{ repoId: 'a' }]);
  await f.finish('a');
  await f.add([{ repoId: 'a', branchName: 'stack/child', baseBranch: 'parent' }]);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1]!.branchName, 'stack/child');
  assert.equal(f.calls[1]!.baseBranch, 'parent');
  await f.finish('a');
  await Promise.all([f.add([{ repoId: 'a' }]), f.add([{ repoId: 'a', branchName: 'stack/child' }])]);
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

test('lost client reply times out without cancelling server preparation; inspection shows progress and a retry joins', async t => {
  const f = await fixture(t);
  let loseReply = true;
  let posts = 0;
  // The request arrives at the server; its reply is lost until the caller's deadline.
  const client = await f.httpClient(async (input, init) => {
    const response = await fetch(input, init);
    if (init?.method !== 'POST') return response;
    posts++;
    if (!loseReply) return response;
    return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
  });
  const input = { id: f.work.id, repositories: [{ repoId: 'a' }], wait: false };
  await assert.rejects(client.workItems.addRepositories.mutate(input, { signal: AbortSignal.timeout(30) }),
    // tRPC reports the caller's expired deadline as an abort of its own request.
    error => error instanceof TRPCClientError && error.cause?.name === 'AbortError');
  assert.equal(posts, 1, 'never automatically resubmit mutations');
  assert.equal(f.calls.length, 1);
  const inspected = await client.workItems.get.query({ id: f.work.id });
  assert.deepEqual(attachmentsOfType(inspected.attachments, 'worktree').map(entry => [entry.payload.repoName, entry.payload.status]), [['a', 'pending']]);
  f.start('a');
  loseReply = false;
  const retried = await client.workItems.addRepositories.mutate(input);
  assert.equal(attachmentsOfType(retried.attachments, 'worktree')[0]!.payload.status, 'preparing');
  assert.equal(f.calls.length, 1);
  await f.finish('a');
  assert.equal(attachmentsOfType((await client.workItems.get.query({ id: f.work.id })).attachments, 'worktree')[0]!.payload.status, 'ready');
  assert.equal(f.calls.length, 1);
});

test('HTTP timeout of a synchronous caller leaves preparation running and concurrent requests join it', async t => {
  const f = await fixture(t);
  const client = await f.httpClient();
  const request = client.workItems.addRepositories.mutate({ id: f.work.id, repositories: [{ repoId: 'a' }] }, { signal: AbortSignal.timeout(100) });
  await assert.rejects(request, error => error instanceof TRPCClientError && error.cause?.name === 'AbortError');
  assert.equal(f.calls.length, 1);
  assert.equal(f.payloads()[0]!.status, 'pending', 'the HTTP abort is not a provisioning failure');
  const accepted = await f.submit(['a']);
  assert.equal(attachmentsOfType(accepted.attachments, 'worktree')[0]!.payload.status, 'pending');
  assert.equal(f.calls.length, 1);
  await f.finish('a');
  assert.equal(attachmentsOfType((await client.workItems.get.query({ id: f.work.id })).attachments, 'worktree')[0]!.payload.status, 'ready');
});

test('invalid batches do not start preparation or leave repository records', async t => {
  const f = await fixture(t);
  await rejectsWith(f.submit(['a', 'missing']), 'BAD_REQUEST');
  await rejectsWith(f.api.workItems.addRepositories({ id: f.work.id, repositories: [], wait: 'no' } as never), 'BAD_REQUEST');
  await rejectsWith(f.api.workItems.addRepositories(null as never), 'BAD_REQUEST');
  // A JSON null body over HTTP is rejected as input, not as a server failure.
  const response = await f.app.inject({ method: 'POST', url: '/trpc/workItems.addRepositories', payload: 'null', headers: { 'content-type': 'application/json' } });
  assert.equal(response.statusCode, 400);
  assert.equal(f.payloads().length, 0);
  assert.equal(f.calls.length, 0);
});

test('orphaned preparation after restart becomes an explicit retryable failure without deleting worktrees', async t => {
  const f = await fixture(t);
  await f.submit(['a']);
  await f.finish('a');
  const original = f.database.listAttachmentsOfType('worktree', f.work.id)[0]!;
  // Emulate durable state left by a process that exited mid-preparation.
  f.database.updateAttachment('worktree', original.id, { ...original.payload, status: 'preparing' });
  const separate = openDatabase(f.config);
  try {
    recoverInterruptedRepositoryPreparations(separate);
    const payload = separate.listAttachmentsOfType('worktree', f.work.id)[0]!.payload;
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
