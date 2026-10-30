import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import type { CreateWorkspaceRequest } from '@lovelace/coriol';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { attachmentsOfType, isLaunchInProgress, type TrackerIssue, type ServerConfig, type LaunchResponse, type AgentSession } from '@lovelace/core';
import { createTRPCClient, httpLink, TRPCClientError } from '@trpc/client';
import { openDatabase } from '../database.js';
import { buildServer } from '../app.js';
import { appRouter, type AppRouter } from '../router.js';
import type { RouteDeps } from './deps.js';
import type { LoadedTool } from '../tools/tool-loader.js';
import { createActiveWorkItem } from '../repositories/work-item-repository.js';
import { HerdrError } from '../herdr/herdr-client.js';
import { FakeHerdr } from '../test-support/fake-herdr.js';
import { changeRequest, fixtureProviders, storedSnapshot, trackerIssue } from '../test-support/providers.js';
import { callerFor, rejectsWith } from '../test-support/trpc.js';
import { syncSessions } from '../services/session-service.js';
import { testDirs } from '../test-support/dirs.js';

const tools = (): LoadedTool[] => (['pi', 'claude', 'codex'] as const).map((id, index) => ({
  id, title: id, thinkingLevels: [], executablePath: `/fixture/${id}`, defaultSelected: index === 0,
}));

async function fixture(t: TestContext, fail = false, providers = fixtureProviders()) {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-dashboard-route-'));
  const config: ServerConfig = {
    ...testDirs(join(root, '.lovelace')), port: 27421, logLevel: 'info',
    syncIntervalMs: 300_000, defaultAgent: 'pi',
  };
  const database = openDatabase(config);
  const herdr = new FakeHerdr();
  if (fail) herdr.failStart = new HerdrError('agent_start_failed', 'fixture launch failure');
  const starts = () => herdr.calls.filter(call => call.method === 'startAgent').map(call => call.args as { name: string; kind: string; paneId: string; args: string[] });
  const deps: RouteDeps = {
    config, tools: tools(), database, cache: providers.cache, herdr,
    // Every route shares these seams: discovery cannot replace our fake tools.
    refreshTools: () => {},
    listModels: async tool => [{ id: `${tool.id}-model` }],
    workspaceManager: {} as RouteDeps['workspaceManager'],
    codeHost: providers.codeHost, tracker: providers.tracker,
  };
  const closers: Array<() => Promise<void>> = [];
  /** Serves the routes over HTTP for transport tests; build after swapping seams in `deps`. */
  const serve = async () => {
    const app = buildServer(deps);
    closers.push(() => app.close());
    return { app, address: await app.listen({ port: 0, host: '127.0.0.1' }) };
  };
  t.after(async () => { for (const close of closers) await close(); database.db.close(); await rm(root, { recursive: true, force: true }); });
  return { api: callerFor(deps), serve, database, providers, herdr, starts, deps };
}

type Api = ReturnType<typeof callerFor>;
/** Invalid inputs are sent as the untyped JSON a client could post. */
type Untyped = Record<string, unknown>;

const quickStart = (api: Api, input: Untyped) => api.launches.quickStart(input as never);
const newSession = (api: Api, workItemId: string, input: Untyped) => api.launches.newSession({ workItemId, ...input } as never);

const session = (details: LaunchResponse['details']) => {
  const meta = attachmentsOfType(details.attachments, 'session')[0]!;
  return { meta, payload: meta.payload as AgentSession };
};

const issue: TrackerIssue = trackerIssue({ id: '42', title: 'Something', author: 'fixture', updatedAt: '2026-01-01T10:00:00.000Z' });

test('dashboard exposes configured repository topic defaults without provider access', async t => {
  const { api, deps } = await fixture(t);
  for (const repositoryTopics of [['infra'], ['frontend', 'platform'], []]) {
    deps.config.github = { repositoryTopics };
    assert.deepEqual((await api.dashboard.get()).settings.repositoryTopics, repositoryTopics);
  }
});

test('quick-start validates every field before creating work or drafts', async (t) => {
  const { api, database, starts } = await fixture(t);
  for (const payload of [{}, { prompt: '   ' }, { prompt: 42 }, { prompt: '\0' }, { prompt: 'Fix', agentId: 'unknown' }, { prompt: 'Fix', agentId: null }, { prompt: 'Fix', trackerIssueId: '' }, { prompt: 'Fix', trackerIssueId: 42 }, { prompt: 'Fix', trackerIssueId: 'missing' }]) {
    await rejectsWith(quickStart(api, payload), 'BAD_REQUEST', undefined, JSON.stringify(payload));
  }
  assert.equal(database.getWorkItemCount(), 0);
  assert.equal(database.listAttachments().length, 0);
  assert.equal(database.listWorkActivity().length, 0);
  assert.equal(starts().length, 0);
});

test('quick-start opens a Herdr workspace for the work item, starts the agent and submits the exact prompt', async (t) => {
  const { api, database, herdr, starts } = await fixture(t);
  const prompt = '  Rewrite the sync\n\n  Keep this whitespace.\n';
  const { details, launch } = await api.launches.quickStart({ prompt });
  assert.deepEqual([launch.state, launch.error], ['started', null]);
  assert.equal(details.workItem.state, 'active');
  assert.equal(details.workItem.title, 'Rewrite the sync');
  assert.equal(launch.prompt, prompt);
  const workspace = attachmentsOfType(details.attachments, 'herdr-workspace')[0]!;
  assert.deepEqual(herdr.workspaces.get(workspace.payload.workspaceId)!.tokens, { lovelace: details.workItem.id });
  const { payload } = session(details);
  assert.equal(starts()[0]!.paneId, payload.terminalRef!.paneId, 'the new workspace root shell hosts the first agent');
  assert.equal(starts()[0]!.kind, 'pi');
  assert.equal(herdr.prompts[0]!.name, payload.agentName);
  assert.ok(herdr.prompts[0]!.text.startsWith(prompt));
  assert.equal(payload.status, 'running');
  const dashboard = await api.dashboard.get();
  assert.equal(dashboard.activeWorkItems[0]!.id, details.workItem.id);
  assert.equal(database.listWorkActivity().filter((row) => row.kind === 'session.created').length, 1);
});

test('later sessions open tabs in the same workspace; a restarted Herdr gets its token back', async (t) => {
  const { api, herdr, starts } = await fixture(t);
  const quick = await api.launches.quickStart({ prompt: 'First' });
  herdr.restart();
  const second = await api.launches.newSession({ workItemId: quick.details.workItem.id, prompt: 'Second', agentId: 'claude' });
  assert.equal(second.launch.state, 'started');
  assert.equal(herdr.workspaces.size, 1);
  const [workspace] = herdr.workspaces.values();
  assert.deepEqual(workspace!.tokens, { lovelace: quick.details.workItem.id });
  assert.equal(herdr.calls.filter(call => call.method === 'createTab').length, 1);
  const claude = starts()[1]!;
  const sessionId = claude.args[claude.args.indexOf('--session-id') + 1];
  const created = attachmentsOfType(second.details.attachments, 'session').map(meta => meta.payload as AgentSession);
  assert.equal(created.find(entry => entry.toolId === 'claude')!.nativeSessionId, sessionId);
});

test('a workspace the user closed or another owner tagged is replaced, not reused', async (t) => {
  const { api, herdr } = await fixture(t);
  const quick = await api.launches.quickStart({ prompt: 'First' });
  const workItemId = quick.details.workItem.id;
  const [first] = herdr.workspaces.keys();
  herdr.workspaces.get(first!)!.tokens.lovelace = 'someone-else';
  const second = await api.launches.newSession({ workItemId, prompt: 'Second' });
  const recorded = attachmentsOfType(second.details.attachments, 'herdr-workspace');
  assert.equal(recorded.length, 1);
  assert.notEqual(recorded[0]!.payload.workspaceId, first);
  herdr.workspaces.delete(recorded[0]!.payload.workspaceId);
  const third = await api.launches.newSession({ workItemId, prompt: 'Third' });
  assert.equal(third.launch.state, 'started');
  assert.equal(herdr.workspaces.size, 2);
});

test('retitling work relabels its own Herdr workspace; attaching Jira keys the title', async (t) => {
  const { api, herdr, providers } = await fixture(t);
  const quick = await api.launches.quickStart({ prompt: 'First' });
  const id = quick.details.workItem.id;
  const [workspaceId] = herdr.workspaces.keys();
  const renames = () => herdr.calls.filter(call => call.method === 'renameWorkspace').map(call => call.args);
  const settled = () => new Promise(resolve => setImmediate(resolve));

  await api.workItems.update({ id, notes: 'Only notes' });
  await settled();
  assert.deepEqual(renames(), [], 'unchanged titles leave the workspace alone');
  await api.workItems.update({ id, title: 'Renamed' });
  await settled();
  assert.deepEqual(renames(), [{ workspaceId, label: 'Renamed' }]);

  providers.tracker.fetchIssue = async () => issue;
  await api.workItems.attachTrackerItem({ id, key: 'PROJ-42' });
  await settled();
  assert.equal((await api.workItems.get({ id })).workItem.title, 'PROJ-42: Renamed');
  assert.deepEqual(renames().at(-1), { workspaceId, label: 'PROJ-42: Renamed' });

  herdr.workspaces.get(workspaceId!)!.tokens.lovelace = 'someone-else';
  await api.workItems.detachTrackerItem({ id, idOrKey: 'PROJ-42' });
  await settled();
  assert.equal((await api.workItems.get({ id })).workItem.title, 'Renamed');
  assert.equal(renames().length, 2, 'a workspace another owner tagged keeps its label');
});

test('an agent that opens blocked on a startup dialog gets its prompt once it is ready', async (t) => {
  const { api, database, herdr } = await fixture(t);
  herdr.startBlocked = true;
  const prompt = 'Exact prompt';
  const quick = await api.launches.quickStart({ prompt });
  assert.equal(quick.launch.state, 'started');
  const { meta, payload } = session(quick.details);
  assert.equal(payload.promptPending, true);
  assert.equal(payload.agentState, 'blocked');
  assert.equal(herdr.prompts.length, 0);
  await syncSessions(database, herdr);
  assert.equal(herdr.prompts.length, 0, 'never typed into a dialog');
  herdr.panes.get(payload.terminalRef!.paneId)!.agentStatus = 'idle';
  await syncSessions(database, herdr);
  await syncSessions(database, herdr);
  assert.equal(herdr.prompts.length, 1);
  assert.ok(herdr.prompts[0]!.text.startsWith(prompt));
  const saved = database.listAttachments().find(entry => entry.id === meta.id)!.payload as AgentSession;
  assert.equal(saved.promptPending, false);
});

test('a freshly created shell that is not ready yet is retried', async (t) => {
  const { api, herdr, starts } = await fixture(t);
  herdr.busyStarts = 2;
  const quick = await api.launches.quickStart({ prompt: 'Wait for the shell' });
  assert.equal(quick.launch.state, 'started');
  assert.equal(starts().length, 3);
});

test('a failed launch keeps its work and exact prompt and retries in place', async (t) => {
  const { api, database, herdr, starts } = await fixture(t, true);
  const prompt = '  Keep this exact\n';
  const { details, launch } = await api.launches.quickStart({ prompt });
  assert.equal(launch.state, 'failed');
  assert.match(launch.error!, /fixture launch failure/);
  assert.equal(details.workItem.state, 'active');
  assert.equal(attachmentsOfType(details.attachments, 'session').length, 0);
  assert.deepEqual(details.launches.map(entry => [entry.prompt, entry.state]), [[prompt, 'failed']]);
  herdr.failStart = null;
  const retried = await api.launches.retry({ id: launch.id });
  assert.ok(isLaunchInProgress(retried.launch.state), 'retry is accepted without waiting');
  assert.equal((await waitForLaunch(database, launch.id)).state, 'started');
  assert.equal(starts().at(-1)!.kind, 'pi');
  assert.equal(herdr.prompts.at(-1)!.text, prompt);
  assert.equal(database.getWorkItemCount(), 1);
  assert.equal(database.listLaunches().length, 1);
});

test('Jira quick-start resolves only server cache and selects no repositories', async (t) => {
  const { api, database, providers, starts } = await fixture(t);
  await providers.setAssigned([issue]);
  const { details, launch } = await api.launches.quickStart({ prompt: 'Fix', trackerIssueId: issue.id });
  assert.equal(launch.state, 'started');
  assert.equal(details.workItem.title, 'PROJ-42: Something');
  assert.equal(attachmentsOfType(details.attachments, 'tracker-item').length, 1);
  assert.equal(attachmentsOfType(details.attachments, 'worktree').length, 0);
  assert.equal(starts().length, 1);
  assert.equal((await api.dashboard.get()).pendingIssues.length, 0);
  assert.equal(database.listWorkActivity().filter((row) => row.kind === 'work-item.tracker-attached').length, 1);
});

test('explicit repository/template selections validate before any mutation', async (t) => {
  const { api, database, starts } = await fixture(t);
  const work = createActiveWorkItem(database, { title: 'Active', attachments: [] });
  for (const selection of [
    { repoIds: null }, { repoIds: 'repo' }, { repoIds: [42] }, { repoIds: [''] },
    { repoIds: ['a', 'a'] }, { repoIds: ['missing'] }, { repoIds: Array.from({ length: 101 }, (_, i) => String(i)) },
    { promptId: null }, { promptId: '' }, { promptId: 42 }, { promptId: 'missing' },
  ]) {
    const payload = { prompt: 'Keep', ...selection };
    await rejectsWith(quickStart(api, payload), 'BAD_REQUEST', undefined, `quick-start ${JSON.stringify(selection)}`);
    await rejectsWith(newSession(api, work.id, payload), 'BAD_REQUEST', undefined, `new-session ${JSON.stringify(selection)}`);
  }
  assert.equal(database.getWorkItemCount(), 1);
  assert.equal(database.listAttachments().length, 0);
  assert.equal(starts().length, 0);
});

function repositoryFixture(deps: RouteDeps) {
  const records = ['a', 'b'].map(name => ({
    id: `github:${name}`, provider: 'github', externalId: name, name, fullName: `org/${name}`,
    cloneUrl: `https://github.invalid/org/${name}.git`, defaultBranch: 'main', isArchived: false,
    topics: ['infra'], lastSyncedAt: new Date().toISOString(),
  }));
  deps.database.replaceRepos(records);
  const calls: CreateWorkspaceRequest[] = [];
  let failing = false;
  const workspacesDirectory = join(deps.config.dataDir, 'workspaces');
  deps.workspaceManager = {
    workspacesDirectory,
    repositoryPath: (id: string) => join(deps.config.dataDir, 'repos', id),
    async createWorkspace(request: CreateWorkspaceRequest) {
      calls.push(request);
      assert.ok(deps.database.listLaunches().length > 0, 'prompt persisted before preparation');
      if (failing && request.repository.id.endsWith('/b')) throw new Error('fixture install failure');
      const path = join(workspacesDirectory, request.workspaceId, request.directoryName!);
      await mkdir(path, { recursive: true });
      return {
        repository: { ...request.repository, path: join(deps.config.dataDir, 'repos', request.repository.id) },
        workspaceId: request.workspaceId, path, branchName: request.branchName, baseBranch: 'main', remoteBranch: null, preparations: [],
      };
    },
  } as unknown as RouteDeps['workspaceManager'];
  return { calls, records, setFailing: (value: boolean) => { failing = value; } };
}

test('Jira selections prepare isolated worktrees before a single idempotent agent launch', async (t) => {
  const { api, providers, database, deps, starts } = await fixture(t);
  const { calls, records } = repositoryFixture(deps);
  await providers.setAssigned([issue]);
  const prompt = '  Edited template\n\nExact final text.\n';
  const payload = { prompt, trackerIssueId: issue.id, repoIds: records.map(repo => repo.id), promptId: 'refine', requestId: randomUUID() };
  const { details, launch } = await api.launches.quickStart(payload);
  assert.equal(launch.state, 'started', launch.error ?? '');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.mode === 'fresh' && call.branchName.includes('proj-42')));
  assert.equal(attachmentsOfType(details.attachments, 'worktree').length, 2);
  assert.deepEqual(launch.repoIds, payload.repoIds);
  assert.equal(launch.promptId, 'refine');
  assert.equal(launch.prompt, prompt);
  assert.equal(session(details).payload.promptId, 'refine');
  assert.equal(starts().length, 1);
  assert.equal((await api.launches.quickStart(payload)).details.workItem.id, details.workItem.id);
  assert.equal(calls.length, 2);
  for (const changes of [{ repoIds: [records[0]!.id] }, { promptId: 'implement' }]) {
    await rejectsWith(api.launches.quickStart({ ...payload, ...changes }), 'CONFLICT', undefined, JSON.stringify(changes));
  }
  assert.equal(database.getWorkItemCount(), 1);
  assert.equal(starts().length, 1);
});

test('review quick-start checks out the pull request branch of its repository and hides the review', async (t) => {
  const { api, providers, database, deps, starts } = await fixture(t);
  const { calls, records } = repositoryFixture(deps);
  providers.data.reviews = [changeRequest({
    repository: 'org/a', number: 7, title: 'Retry uploads', author: 'human', sourceBranch: 'feature/retry', targetBranch: 'main', updatedAt: '2026-01-01T10:00:00.000Z',
  })];
  await providers.codeHost.refreshReviewRequests();
  assert.deepEqual((await api.dashboard.get()).pendingReviews.map(review => [review.id, review.repoId]), [['org/a#7', records[0]!.id]]);
  for (const payload of [{ reviewRequestId: 'missing', repoIds: [records[0]!.id] }, { reviewRequestId: 'org/a#7', repoIds: [records[1]!.id] }, { reviewRequestId: 42 }]) {
    await rejectsWith(quickStart(api, { prompt: 'Review', ...payload }), 'BAD_REQUEST', undefined, JSON.stringify(payload));
  }
  assert.equal(database.getWorkItemCount(), 0);

  const { details, launch } = await api.launches.quickStart({ prompt: 'Review', reviewRequestId: 'org/a#7', repoIds: records.map(repo => repo.id), promptId: 'review' });
  assert.equal(launch.state, 'started', launch.error ?? '');
  assert.equal(details.workItem.title, 'org/a#7: Retry uploads');
  assert.deepEqual(attachmentsOfType(details.attachments, 'change-request').map(meta => meta.externalId), ['org/a#7']);
  assert.deepEqual(calls.map(call => [call.repository.id, call.mode, call.remoteBranch]).sort(), [['github/org/a', 'existing', 'feature/retry'], ['github/org/b', 'fresh', null]]);
  assert.equal(starts().length, 1);
  assert.equal((await api.dashboard.get()).pendingReviews.length, 0);
});

test('partial workspace failure keeps the launch and its retry prepares only failed repositories', async (t) => {
  const { api, deps, starts, database } = await fixture(t);
  const { calls, records, setFailing } = repositoryFixture(deps);
  setFailing(true);
  const payload = { prompt: '  Keep exactly\n', repoIds: records.map(repo => repo.id), promptId: 'implement' };
  const first = await api.launches.quickStart(payload);
  assert.equal(first.launch.state, 'failed');
  assert.match(first.launch.error!, /Repository preparation failed/);
  assert.equal(starts().length, 0);
  assert.equal(first.launch.prompt, payload.prompt);
  setFailing(false);
  await api.launches.retry({ id: first.launch.id });
  const retried = await waitForLaunch(database, first.launch.id);
  assert.equal(retried.state, 'started', retried.error ?? '');
  assert.equal(database.getWorkItemCount(), 1);
  assert.equal(calls.length, 3, 'ready repository reused; failed repository retried');
  assert.equal(starts().length, 1);
});

test('new-session rejects inactive work and malformed options without recording a launch', async (t) => {
  const { api, database, starts } = await fixture(t);
  const work = createActiveWorkItem(database, { title: 'Active', attachments: [] });
  for (const options of [null, [], 'high', { pi: { model: 42 } }, { pi: { thinkingLevel: 'invalid' } }, { unknown: {} }, { pi: { unknown: true } }]) {
    await rejectsWith(newSession(api, work.id, { prompt: 'Text', options }), 'BAD_REQUEST', undefined, JSON.stringify(options));
  }
  for (const state of ['done', 'cancelled'] as const) {
    database.updateWorkItemState(work.id, state);
    await rejectsWith(api.launches.newSession({ workItemId: work.id, prompt: 'Text' }), 'CONFLICT', undefined, state);
  }
  assert.equal(database.listLaunches(work.id).length, 0);
  assert.equal(starts().length, 0);
  await rejectsWith(api.launches.newSession({ workItemId: 'missing', prompt: 'Text' }), 'NOT_FOUND');
});

test('quick-start passes harness options as native flags and rejects malformed ones', async (t) => {
  const { api, starts } = await fixture(t);
  await rejectsWith(quickStart(api, { prompt: 'Text', options: { pi: { thinkingLevel: 'invalid' } } }), 'BAD_REQUEST');
  const options = { pi: { model: 'fixture/model', thinkingLevel: 'high' as const } };
  const response = await api.launches.quickStart({ prompt: 'Text', agentId: 'pi', options });
  assert.equal(response.launch.state, 'started');
  assert.deepEqual(starts()[0]!.args, ['--model', 'fixture/model', '--thinking', 'high']);
  assert.deepEqual(session(response.details).payload.options, options.pi);
});

test('new-session passes harness options as native flags and keeps them with the session', async (t) => {
  const { api, database, starts } = await fixture(t);
  const work = createActiveWorkItem(database, { title: 'Active', attachments: [] });
  const options = { pi: { model: 'fixture/model', thinkingLevel: 'high' as const } };
  const prompt = '  My text\n';
  const response = await api.launches.newSession({ workItemId: work.id, prompt, options });
  assert.equal(response.launch.state, 'started');
  const launch = database.listLaunches(work.id)[0]!;
  assert.equal(launch.prompt, prompt);
  assert.deepEqual(launch.options, options);
  assert.deepEqual(starts()[0]!.args, ['--model', 'fixture/model', '--thinking', 'high']);
  assert.deepEqual(session(response.details).payload.options, options.pi);
});

test('opening a live session focuses its tab and never starts another agent', async (t) => {
  const { api, herdr, starts } = await fixture(t);
  const quick = await api.launches.quickStart({ prompt: 'Session' });
  const { meta, payload } = session(quick.details);
  const opened = await api.sessions.open({ workItemId: quick.details.workItem.id, sessionId: meta.id });
  assert.equal(opened.action, 'focused');
  assert.deepEqual(herdr.calls.at(-1), { method: 'focusTab', args: herdr.panes.get(payload.terminalRef!.paneId)!.tabId });
  assert.equal(starts().length, 1);
});

test('opening an ended session continues its exact native conversation in the pane it left', async (t) => {
  const { api, database, herdr, starts } = await fixture(t);
  const quick = await api.launches.quickStart({ prompt: 'Session' });
  const { meta, payload } = session(quick.details);
  const pane = payload.terminalRef!.paneId;
  const reported = herdr.panes.get(pane)!.agentSession!.value;
  herdr.exitAgent(pane);
  const response = await api.sessions.open({ workItemId: quick.details.workItem.id, sessionId: meta.id });
  assert.equal(response.action, 'continued');
  assert.deepEqual(starts()[1], { name: payload.agentName, kind: 'pi', paneId: pane, args: ['--session', reported] });
  const continued = database.listAttachments().find(entry => entry.id === meta.id)!.payload as AgentSession;
  assert.equal(continued.status, 'running');
  assert.equal(continued.nativeSessionPath, reported);
  assert.equal(herdr.prompts.length, 1, 'the initial prompt is never replayed');
  assert.equal(database.listWorkActivity().filter(row => row.kind === 'session.continued').length, 1);
});

test('a closed pane continues in a new tab; sessions without native identity are refused', async (t) => {
  const { api, database, herdr, starts } = await fixture(t);
  herdr.reportSessions = false;
  const quick = await api.launches.quickStart({ prompt: 'Session', agentId: 'codex' });
  const workItemId = quick.details.workItem.id;
  const { meta, payload } = session(quick.details);
  herdr.closePane(payload.terminalRef!.paneId);
  herdr.reportSessions = true;
  await rejectsWith(api.sessions.open({ workItemId, sessionId: meta.id }), 'CONFLICT', /No native conversation/);
  assert.equal(starts().length, 1);

  const second = await api.launches.newSession({ workItemId, prompt: 'Again', agentId: 'codex' });
  const meta2 = attachmentsOfType(second.details.attachments, 'session').find(entry => entry.id !== meta.id)!;
  const payload2 = meta2.payload as AgentSession;
  const nativeId = herdr.panes.get(payload2.terminalRef!.paneId)!.agentSession!.value;
  await api.sessions.open({ workItemId, sessionId: meta2.id });
  herdr.closePane(payload2.terminalRef!.paneId);
  const continued = await api.sessions.open({ workItemId, sessionId: meta2.id });
  assert.equal(continued.action, 'continued');
  assert.deepEqual(starts().at(-1)!.args, ['resume', nativeId]);
  assert.notEqual(starts().at(-1)!.paneId, payload2.terminalRef!.paneId);
  database.updateWorkItemState(workItemId, 'done');
  await rejectsWith(api.sessions.open({ workItemId, sessionId: meta.id }), 'CONFLICT');
  await rejectsWith(api.sessions.open({ workItemId, sessionId: 'missing' }), 'CONFLICT');
});

test('tool listing uses the injected discovery and fake harnesses, with their models', async (t) => {
  const { api } = await fixture(t);
  const [first] = await api.tools.list();
  assert.equal(first!.id, 'pi');
  assert.deepEqual(first!.models, [{ id: 'pi-model' }]);
});

test('a harness whose models cannot be listed is still offered', async (t) => {
  const { api, deps } = await fixture(t);
  deps.listModels = async () => { throw new Error('fixture listing failure'); };
  const listed = await api.tools.list();
  assert.deepEqual(listed.map(tool => tool.models), [[], [], []]);
});

test('excluded v3 routes are not mounted and malformed Jira hydration is safe', async (t) => {
  const { api, serve } = await fixture(t, false, fixtureProviders([storedSnapshot('tracker.jira.assignedIssues', '{broken')]));
  const excluded = ['kizzy', 'repo-dashboard', 'security-alerts', 'repository-insights', 'agent-signals'];
  const procedures = Object.keys(appRouter._def.procedures);
  for (const name of excluded) {
    const camel = name.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase());
    assert.ok(!procedures.some(path => path.toLowerCase().includes(camel.toLowerCase())), `${name} has no procedure`);
  }
  const { app } = await serve();
  for (const name of excluded) {
    for (const url of [`/${name}`, `/trpc/${name}`]) assert.equal((await app.inject(url)).statusCode, 404, url);
  }
  const dashboard = await api.dashboard.get();
  assert.deepEqual(dashboard.settings, { defaultAgent: 'pi', repositoryTopics: [] });
  assert.equal(dashboard.freshness.trackerStale, true);
});

test('stable request IDs coalesce concurrent submissions and replay uncertain replies without another launch', async (t) => {
  const { api, database, herdr, starts } = await fixture(t);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entering = new Promise<void>((resolve) => { started = resolve; });
  const start = herdr.startAgent.bind(herdr);
  herdr.startAgent = async (input) => { started(); await gate; return start(input); };
  const payload = { prompt: 'Same intentional text', requestId: randomUUID() };
  const first = api.launches.quickStart(payload);
  await entering;
  const second = api.launches.quickStart(payload);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.launch.state, 'started');
  assert.deepEqual(a, b);
  const replay = await api.launches.quickStart(payload);
  assert.equal(replay.details.workItem.id, a.details.workItem.id);
  assert.equal(starts().length, 1);
  assert.equal(database.getWorkItemCount(), 1);
  await rejectsWith(api.launches.quickStart({ ...payload, prompt: 'Changed intent' }), 'CONFLICT');
  assert.equal(database.getWorkItemCount(), 1);
  const intentionalDuplicate = await api.launches.quickStart({ ...payload, requestId: randomUUID() });
  assert.equal(intentionalDuplicate.launch.state, 'started');
  assert.equal(database.getWorkItemCount(), 2, 'equal text does not deduplicate deliberate new intents');
});

test('restart recovers a pending intent as uncertain and never replays its launch', async (t) => {
  const { api, database, starts } = await fixture(t);
  const payload = { prompt: 'Uncertain', requestId: randomUUID() };
  const completed = await api.launches.quickStart(payload);
  interruptLaunch(database, payload.requestId);
  const recovered = await api.launches.quickStart(payload);
  assert.equal(recovered.launch.state, 'uncertain');
  assert.match(recovered.launch.error!, /uncertain/);
  assert.equal(recovered.details.workItem.id, completed.details.workItem.id);
  assert.equal(starts().length, 1);
  assert.equal(database.getWorkItemCount(), 1);
  assert.equal((await api.launches.quickStart(payload)).launch.state, 'uncertain');
  await rejectsWith(api.launches.retry({ id: payload.requestId }), 'CONFLICT');
  assert.equal(starts().length, 1);
});

test('concurrent launches keep separate prompts; an error after the agent started is uncertain', async (t) => {
  const { api, database, herdr } = await fixture(t);
  const work = createActiveWorkItem(database, { title: 'Concurrent drafts', attachments: [] });
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entering = new Promise<void>((resolve) => { started = resolve; });
  const prompt = herdr.promptAgent.bind(herdr);
  herdr.promptAgent = async (name, text) => {
    if (text.startsWith('A')) { started(); await gate; return prompt(name, text); }
    throw new Error('B fixture failed');
  };
  const aPayload = { workItemId: work.id, prompt: 'A exact\n  ', requestId: randomUUID() };
  const bPayload = { workItemId: work.id, prompt: 'B exact\n\n  ', requestId: randomUUID() };
  const a = api.launches.newSession(aPayload);
  await entering;
  const b = await api.launches.newSession(bPayload);
  assert.equal(b.launch.state, 'uncertain');
  assert.match(b.launch.error!, /may be running in Herdr pane/);
  release();
  assert.equal((await a).launch.state, 'started');
  assert.equal(database.getLaunch(aPayload.requestId)!.state, 'started');
  assert.equal(database.getLaunch(bPayload.requestId)!.state, 'uncertain');
  assert.equal(database.getLaunch(bPayload.requestId)!.prompt, bPayload.prompt);
  const replay = await api.launches.newSession(bPayload);
  assert.equal(replay.launch.state, 'uncertain');
  await rejectsWith(api.launches.retry({ id: bPayload.requestId }), 'CONFLICT');
  assert.equal(database.listLaunches(work.id).length, 2);
});

test('request identity validates UUIDs and scopes endpoint/work/options before mutation', async (t) => {
  const { api, database } = await fixture(t);
  for (const requestId of ['', 'invalid', 42, null]) {
    await rejectsWith(quickStart(api, { prompt: 'Text', requestId }), 'BAD_REQUEST', undefined, JSON.stringify(requestId));
  }
  assert.equal(database.getWorkItemCount(), 0);
  const id = randomUUID();
  const original = await api.launches.quickStart({ prompt: 'Text', requestId: id });
  const workItemId = original.details.workItem.id;
  await rejectsWith(api.launches.newSession({ workItemId, prompt: 'Text', requestId: id }), 'CONFLICT');
  const sessionIntent = { workItemId, prompt: 'Options', requestId: randomUUID(), options: { pi: { model: 'fixture/model', thinkingLevel: 'high' as const } } };
  const first = await api.launches.newSession(sessionIntent);
  const reversed = { ...sessionIntent, options: { pi: { thinkingLevel: 'high' as const, model: 'fixture/model' } } };
  assert.deepEqual(await api.launches.newSession(reversed), first);
  await rejectsWith(api.launches.newSession({ ...sessionIntent, options: {} }), 'CONFLICT');
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function waitForLaunch(database: ReturnType<typeof openDatabase>, id: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const launch = database.getLaunch(id);
    if (launch && !isLaunchInProgress(launch.state)) return launch;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('fixture launch did not finish');
}

/** Leaves the launch in progress under an earlier boot, then recovers as a restarted server would. */
function interruptLaunch(database: ReturnType<typeof openDatabase>, id: string) {
  database.db.prepare("update launches set state = 'starting', boot_id = 'earlier' where id = ?").run(id);
  database.recoverInterruptedLaunches();
}

test('async acceptance persists work, launch and progress; replay joins and synchronous callers still wait', async t => {
  const { api, database, deps, starts } = await fixture(t);
  const { records, calls } = repositoryFixture(deps);
  const gate = deferred();
  const create = deps.workspaceManager.createWorkspace.bind(deps.workspaceManager);
  deps.workspaceManager.createWorkspace = async request => { await gate.promise; return create(request); };
  const payload = { prompt: '  Accepted exact text\n\n', repoIds: [records[0]!.id], promptId: 'implement', requestId: randomUUID(), wait: false };
  const response = await api.launches.quickStart(payload);
  assert.deepEqual([response.launch.state, response.launch.error], ['preparing', null]);
  assert.equal(response.launch.prompt, payload.prompt);
  assert.equal(attachmentsOfType(response.details.attachments, 'worktree')[0]!.payload.status, 'pending');
  assert.equal(response.details.launches[0]!.id, payload.requestId);
  assert.equal(starts().length, 0);
  const lookup = await api.launches.get({ id: payload.requestId });
  assert.equal(lookup.launch.state, 'preparing');
  assert.equal(database.getWorkItemCount(), 1);
  const replay = await api.launches.quickStart(payload);
  assert.equal(replay.launch.state, 'preparing');
  assert.equal(replay.details.workItem.id, response.details.workItem.id);
  assert.equal(database.listLaunches().length, 1);
  let synchronousDone = false;
  const synchronous = api.launches.quickStart({ ...payload, wait: true })
    .then(result => { synchronousDone = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(synchronousDone, false);
  gate.resolve();
  assert.equal((await synchronous).launch.state, 'started');
  const completed = await api.launches.get({ id: payload.requestId });
  assert.equal(completed.launch.state, 'started');
  assert.equal(calls.length, 1);
  assert.equal(starts().length, 1);
});

test('independent accepted tasks prepare concurrently; later task can finish while the first agent starts', async t => {
  const { api, database, deps, herdr, providers } = await fixture(t);
  const { records } = repositoryFixture(deps);
  await providers.setAssigned([issue]);
  const preparation = [deferred(), deferred()];
  const requests: CreateWorkspaceRequest[] = [];
  const create = deps.workspaceManager.createWorkspace.bind(deps.workspaceManager);
  deps.workspaceManager.createWorkspace = async request => {
    requests.push(request);
    await preparation[request.repository.id.endsWith('/a') ? 0 : 1]!.promise;
    return create(request);
  };
  const agent = deferred();
  const starting = deferred();
  const start = herdr.startAgent.bind(herdr);
  herdr.startAgent = async input => {
    if (input.kind === 'pi') { starting.resolve(); await agent.promise; }
    return start(input);
  };
  const firstPayload = { prompt: 'First task', trackerIssueId: issue.id, repoIds: [records[0]!.id], requestId: randomUUID(), wait: false };
  const first = await api.launches.quickStart(firstPayload);
  const secondPayload = { prompt: 'Second task', agentId: 'claude' as const, repoIds: [records[1]!.id], requestId: randomUUID(), wait: false };
  const second = await api.launches.quickStart(secondPayload);
  assert.equal(requests.length, 2, 'neither task waits for another task to provision');
  assert.notEqual(first.details.workItem.id, second.details.workItem.id);
  let dashboard = await api.dashboard.get();
  assert.ok(dashboard.activeWorkItems.every(item => item.launchState === 'preparing'));
  assert.equal(dashboard.pendingIssues.length, 0, 'accepted Jira work is no longer pending');
  preparation[0]!.resolve();
  await starting.promise;
  assert.equal((await api.launches.get({ id: firstPayload.requestId })).launch.state, 'starting');
  preparation[1]!.resolve();
  await waitForLaunch(database, secondPayload.requestId);
  assert.equal(database.getLaunch(firstPayload.requestId)!.state, 'starting');
  dashboard = await api.dashboard.get();
  assert.equal(dashboard.activeWorkItems.find(item => item.id === second.details.workItem.id)!.launchState, undefined);
  assert.equal(dashboard.activeWorkItems.find(item => item.id === first.details.workItem.id)!.launchState, 'starting');
  agent.resolve();
  await waitForLaunch(database, firstPayload.requestId);
  assert.equal(herdr.workspaces.size, 2);
  assert.equal(herdr.calls.filter(call => call.method === 'focusTab').length, 0);
  assert.equal(herdr.prompts.length, 2);
});

test('background partial preparation failure keeps the exact launch for retry on the same work item', async t => {
  const { api, database, deps, starts } = await fixture(t);
  const { records, calls, setFailing } = repositoryFixture(deps);
  setFailing(true);
  const payload = { prompt: '  Keep this exact prompt\n\n  ', repoIds: records.map(record => record.id), promptId: 'refine', requestId: randomUUID(), wait: false };
  const accepted = await api.launches.quickStart(payload);
  await waitForLaunch(database, payload.requestId);
  const failed = await api.launches.get({ id: payload.requestId });
  assert.equal(failed.launch.state, 'failed');
  assert.equal(starts().length, 0);
  assert.equal(failed.launch.prompt, payload.prompt);
  assert.deepEqual(failed.launch.repoIds, payload.repoIds);
  assert.equal(failed.launch.promptId, payload.promptId);
  assert.equal((await api.dashboard.get()).activeWorkItems[0]!.launchState, 'failed');
  const paths = attachmentsOfType(failed.details.attachments, 'worktree').map(meta => meta.payload.worktreePath);
  setFailing(false);
  const retry = await api.launches.retry({ id: payload.requestId });
  assert.ok(isLaunchInProgress(retry.launch.state), 'retry is accepted without waiting');
  await waitForLaunch(database, payload.requestId);
  const ready = await api.workItems.get({ id: accepted.details.workItem.id });
  assert.deepEqual(ready.launches.map(launch => launch.state), ['started']);
  assert.deepEqual(attachmentsOfType(ready.attachments, 'worktree').map(meta => meta.payload.worktreePath), paths);
  assert.equal(database.getWorkItemCount(), 1);
  assert.equal(calls.length, 3, 'ready sibling reused; only failed repository retried');
  assert.equal(starts().length, 1);
});

test('a lost acceptance reply is inspectable by UUID and never duplicates background preparation or launch', async t => {
  const { serve, database, deps, starts } = await fixture(t);
  const { records } = repositoryFixture(deps);
  const gate = deferred();
  let preparations = 0;
  const create = deps.workspaceManager.createWorkspace.bind(deps.workspaceManager);
  deps.workspaceManager.createWorkspace = async request => { preparations++; await gate.promise; return create(request); };
  const { address } = await serve();
  let loseReply = true;
  let posts = 0;
  // The request reaches the server; its reply is lost until the caller's deadline.
  const fetchFn: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (init?.method !== 'POST') return response;
    posts++;
    if (!loseReply) return response;
    return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
  };
  const client = createTRPCClient<AppRouter>({ links: [httpLink({ url: `${address}/trpc`, fetch: fetchFn })] });
  const requestId = randomUUID();
  const input = { prompt: 'Lost acceptance', requestId, wait: false, repoIds: [records[0]!.id] };
  await assert.rejects(client.launches.quickStart.mutate(input, { signal: AbortSignal.timeout(30) }),
    // tRPC reports the caller's expired deadline as an abort of its own request.
    error => error instanceof TRPCClientError && error.cause?.name === 'AbortError');
  assert.equal(posts, 1);
  const lookup = await client.launches.get.query({ id: requestId });
  assert.equal(lookup.launch.state, 'preparing');
  loseReply = false;
  const replay = await client.launches.quickStart.mutate(input);
  assert.equal(replay.details.workItem.id, lookup.details.workItem.id);
  assert.equal(preparations, 1);
  gate.resolve();
  await waitForLaunch(database, requestId);
  assert.equal((await client.launches.get.query({ id: requestId })).launch.state, 'started');
  assert.equal(starts().length, 1);
  assert.equal(database.getWorkItemCount(), 1);
});

test('concurrent sessions on the same item allocate one Herdr workspace and independent panes', async t => {
  const { api, database, herdr } = await fixture(t);
  const work = createActiveWorkItem(database, { title: 'Concurrent sessions', attachments: [] });
  const gate = deferred();
  let allocations = 0;
  const create = herdr.createWorkspace.bind(herdr);
  herdr.createWorkspace = async input => { allocations++; await gate.promise; return create(input); };
  const requests = ['One', 'Two'].map(prompt => ({ workItemId: work.id, prompt, requestId: randomUUID(), wait: false }));
  const responses = await Promise.all(requests.map(payload => api.launches.newSession(payload)));
  assert.ok(responses.every(response => isLaunchInProgress(response.launch.state)), 'both launches are accepted without waiting');
  assert.equal(allocations, 1, 'workspace allocation is serialized, not agent startup');
  gate.resolve();
  await Promise.all(requests.map(request => waitForLaunch(database, request.requestId)));
  assert.equal(herdr.workspaces.size, 1);
  assert.equal(database.listAttachmentsOfType('herdr-workspace', work.id).length, 1);
  const sessions = database.listAttachmentsOfType('session', work.id).map(meta => meta.payload);
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0]!.terminalRef!.paneId, sessions[1]!.terminalRef!.paneId);
  assert.equal(herdr.calls.filter(call => call.method === 'createTab').length, 1);
  assert.equal(herdr.calls.filter(call => call.method === 'focusTab').length, 0);
});

test('async launch transport validates wait without changing frozen identity and status lookup never launches', async t => {
  const { api, database, starts } = await fixture(t);
  for (const wait of ['false', null, 42]) {
    await rejectsWith(quickStart(api, { prompt: 'Text', wait }), 'BAD_REQUEST', undefined, JSON.stringify(wait));
  }
  assert.equal(database.getWorkItemCount(), 0);
  await rejectsWith(api.launches.get({ id: 'invalid' }), 'BAD_REQUEST');
  await rejectsWith(api.launches.get({ id: randomUUID() }), 'NOT_FOUND');
  const requestId = randomUUID();
  const payload = { prompt: 'Text', requestId };
  await api.launches.quickStart(payload);
  const workItemId = database.listWorkItems()[0]!.id;
  assert.equal((await api.launches.quickStart({ ...payload, wait: false })).launch.state, 'started', 'wait is not part of the frozen identity');
  await rejectsWith(newSession(api, workItemId, { prompt: 'Text', wait: 'false' }), 'BAD_REQUEST');
  interruptLaunch(database, requestId);
  const recovered = await api.launches.get({ id: requestId });
  assert.equal(recovered.launch.state, 'uncertain');
  assert.equal((await api.workItems.get({ id: workItemId })).launches[0]!.state, 'uncertain');
  await rejectsWith(api.launches.retry({ id: requestId }), 'CONFLICT');
  await rejectsWith(api.launches.retry({ id: 'invalid' }), 'BAD_REQUEST');
  await rejectsWith(api.launches.retry({ id: randomUUID() }), 'NOT_FOUND');
  assert.equal(starts().length, 1, 'lookup never replays an interrupted launch');
});

test('cancelling accepted work during preparation never starts an agent or resets local state', async t => {
  const { api, database, deps, starts } = await fixture(t);
  const { records } = repositoryFixture(deps);
  const gate = deferred();
  const create = deps.workspaceManager.createWorkspace.bind(deps.workspaceManager);
  deps.workspaceManager.createWorkspace = async request => { await gate.promise; return create(request); };
  const requestId = randomUUID();
  const accepted = await api.launches.quickStart({ prompt: 'Do not start after cancellation', repoIds: [records[0]!.id], requestId, wait: false });
  database.updateWorkItemState(accepted.details.workItem.id, 'cancelled');
  gate.resolve();
  await waitForLaunch(database, requestId);
  const outcome = await api.launches.get({ id: requestId });
  assert.equal(outcome.launch.state, 'failed');
  assert.equal(outcome.details.workItem.state, 'cancelled');
  assert.equal(starts().length, 0);
  await rejectsWith(api.launches.retry({ id: requestId }), 'CONFLICT', undefined, 'cancelled work is not retried');
});
