import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { LovelaceClient } from '@lovelace/client';
import type { CreateWorkspaceRequest } from '@lovelace/coriol';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { attachmentsOfType, isLaunchInProgress, type DashboardResponse, type JiraIssueSummary, type LovelaceConfig, type LaunchResponse, type SessionOpenResponse, type AgentSession, type WorkItemDetails } from '@lovelace/core';
import { openDatabase } from '../database.js';
import { buildServer } from '../app.js';
import type { RouteDeps } from './deps.js';
import type { LoadedTool } from '../tools/tool-loader.js';
import { createActiveWorkItem } from '../repositories/work-item-repository.js';
import { HerdrError } from '../herdr/herdr-client.js';
import { FakeHerdr } from '../test-support/fake-herdr.js';
import { fixtureProviders, storedSnapshot } from '../test-support/providers.js';
import { syncSessions } from '../services/session-service.js';

const tools = (): LoadedTool[] => (['pi', 'claude', 'codex'] as const).map((id, index) => ({
  id, title: id, thinkingLevels: [], executablePath: `/fixture/${id}`, defaultSelected: index === 0,
}));

async function fixture(t: TestContext, fail = false, providers = fixtureProviders()) {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-dashboard-route-'));
  const config: LovelaceConfig = {
    domainRoot: root, lovelaceDir: join(root, '.lovelace'), port: 27421, logLevel: 'info',
    syncIntervalMs: 300_000, defaultAgent: 'pi', tui: { sidebarSide: 'right' },
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
    github: providers.github, jira: providers.jira,
  };
  const app = buildServer(deps);
  t.after(async () => { await app.close(); database.db.close(); await rm(root, { recursive: true, force: true }); });
  return { app, database, providers, herdr, starts, deps };
}

const session = (details: LaunchResponse['details']) => {
  const meta = attachmentsOfType(details.attachments, 'session')[0]!;
  return { meta, payload: meta.payload as AgentSession };
};

const issue: JiraIssueSummary = {
  id: '42', key: 'PROJ-42', title: 'Something', url: 'https://jira.invalid/browse/PROJ-42', project: 'PROJ',
  status: 'To Do', statusCategory: 'new', issueType: 'Task', type: 'Task', author: 'fixture', descriptionText: null, updatedAt: '2026-01-01T10:00:00.000Z',
};

test('dashboard exposes configured repository topic defaults without provider access', async t => {
  const { app, deps } = await fixture(t);
  for (const repositoryTopics of [['infra'], ['frontend', 'platform'], []]) {
    deps.config.github = { repositoryTopics };
    const response = await app.inject('/dashboard');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json<DashboardResponse>().settings.repositoryTopics, repositoryTopics);
  }
});

test('quick-start validates every field before creating work or drafts', async (t) => {
  const { app, database, starts } = await fixture(t);
  for (const payload of [{}, { prompt: '   ' }, { prompt: 42 }, { prompt: '\0' }, { prompt: 'Fix', agentId: 'unknown' }, { prompt: 'Fix', agentId: null }, { prompt: 'Fix', jiraIssueId: '' }, { prompt: 'Fix', jiraIssueId: 42 }, { prompt: 'Fix', jiraIssueId: 'missing' }]) {
    const response = await app.inject({ method: 'POST', url: '/work-items/quick-start', payload });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
  }
  assert.equal(database.getWorkItemCount(), 0);
  assert.equal(database.listAttachments().length, 0);
  assert.equal(database.listWorkActivity().length, 0);
  assert.equal(starts().length, 0);
});

test('quick-start opens a Herdr workspace for the work item, starts the agent and submits the exact prompt', async (t) => {
  const { app, database, herdr, starts } = await fixture(t);
  const prompt = '  Rewrite the sync\n\n  Keep this whitespace.\n';
  const response = await app.inject({ method: 'POST', url: '/work-items/quick-start', payload: { prompt } });
  assert.equal(response.statusCode, 200);
  const { details, launch } = response.json<LaunchResponse>();
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
  const dashboard = (await app.inject('/dashboard')).json<DashboardResponse>();
  assert.equal(dashboard.activeWorkItems[0]!.id, details.workItem.id);
  assert.equal(database.listWorkActivity().filter((row) => row.kind === 'session.created').length, 1);
});

test('later sessions open tabs in the same workspace; a restarted Herdr gets its token back', async (t) => {
  const { app, herdr, starts } = await fixture(t);
  const quick = (await app.inject({ method: 'POST', url: '/work-items/quick-start', payload: { prompt: 'First' } })).json<LaunchResponse>();
  herdr.restart();
  const second = (await app.inject({ method: 'POST', url: `/work-items/${quick.details.workItem.id}/new-session`, payload: { prompt: 'Second', agentId: 'claude' } })).json<LaunchResponse>();
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
  const { app, herdr } = await fixture(t);
  const quick = (await app.inject({ method: 'POST', url: '/work-items/quick-start', payload: { prompt: 'First' } })).json<LaunchResponse>();
  const url = `/work-items/${quick.details.workItem.id}/new-session`;
  const [first] = herdr.workspaces.keys();
  herdr.workspaces.get(first!)!.tokens.lovelace = 'someone-else';
  const second = (await app.inject({ method: 'POST', url, payload: { prompt: 'Second' } })).json<LaunchResponse>();
  const recorded = attachmentsOfType(second.details.attachments, 'herdr-workspace');
  assert.equal(recorded.length, 1);
  assert.notEqual(recorded[0]!.payload.workspaceId, first);
  herdr.workspaces.delete(recorded[0]!.payload.workspaceId);
  const third = (await app.inject({ method: 'POST', url, payload: { prompt: 'Third' } })).json<LaunchResponse>();
  assert.equal(third.launch.state, 'started');
  assert.equal(herdr.workspaces.size, 2);
});

test('retitling work relabels its own Herdr workspace; attaching Jira keys the title', async (t) => {
  const { app, herdr, providers } = await fixture(t);
  const quick = (await app.inject({ method: 'POST', url: '/work-items/quick-start', payload: { prompt: 'First' } })).json<LaunchResponse>();
  const id = quick.details.workItem.id;
  const [workspaceId] = herdr.workspaces.keys();
  const renames = () => herdr.calls.filter(call => call.method === 'renameWorkspace').map(call => call.args);
  const settled = () => new Promise(resolve => setImmediate(resolve));

  await app.inject({ method: 'PATCH', url: `/work-items/${id}`, payload: { notes: 'Only notes' } });
  await settled();
  assert.deepEqual(renames(), [], 'unchanged titles leave the workspace alone');
  await app.inject({ method: 'PATCH', url: `/work-items/${id}`, payload: { title: 'Renamed' } });
  await settled();
  assert.deepEqual(renames(), [{ workspaceId, label: 'Renamed' }]);

  providers.jira.fetchIssue = async () => issue;
  const attached = await app.inject({ method: 'POST', url: `/work-items/${id}/tracker-items`, payload: { key: 'PROJ-42' } });
  assert.equal(attached.statusCode, 200);
  await settled();
  assert.equal((await app.inject(`/work-items/${id}`)).json<WorkItemDetails>().workItem.title, 'PROJ-42: Renamed');
  assert.deepEqual(renames().at(-1), { workspaceId, label: 'PROJ-42: Renamed' });

  herdr.workspaces.get(workspaceId!)!.tokens.lovelace = 'someone-else';
  await app.inject({ method: 'DELETE', url: `/work-items/${id}/tracker-items/PROJ-42` });
  await settled();
  assert.equal((await app.inject(`/work-items/${id}`)).json<WorkItemDetails>().workItem.title, 'Renamed');
  assert.equal(renames().length, 2, 'a workspace another owner tagged keeps its label');
});

test('an agent that opens blocked on a startup dialog gets its prompt once it is ready', async (t) => {
  const { app, database, herdr } = await fixture(t);
  herdr.startBlocked = true;
  const prompt = 'Exact prompt';
  const quick = (await app.inject({ method: 'POST', url: '/work-items/quick-start', payload: { prompt } })).json<LaunchResponse>();
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
  const { app, herdr, starts } = await fixture(t);
  herdr.busyStarts = 2;
  const quick = (await app.inject({ method: 'POST', url: '/work-items/quick-start', payload: { prompt: 'Wait for the shell' } })).json<LaunchResponse>();
  assert.equal(quick.launch.state, 'started');
  assert.equal(starts().length, 3);
});

test('a failed launch keeps its work and exact prompt and retries in place', async (t) => {
  const { app, database, herdr, starts } = await fixture(t, true);
  const prompt = '  Keep this exact\n';
  const response = await app.inject({ method: 'POST', url: '/work-items/quick-start', payload: { prompt } });
  assert.equal(response.statusCode, 200);
  const { details, launch } = response.json<LaunchResponse>();
  assert.equal(launch.state, 'failed');
  assert.match(launch.error!, /fixture launch failure/);
  assert.equal(details.workItem.state, 'active');
  assert.equal(attachmentsOfType(details.attachments, 'session').length, 0);
  assert.deepEqual(details.launches.map(entry => [entry.prompt, entry.state]), [[prompt, 'failed']]);
  herdr.failStart = null;
  const retried = await app.inject({ method: 'POST', url: `/launches/${launch.id}/retry` });
  assert.equal(retried.statusCode, 202);
  assert.equal((await waitForLaunch(database, launch.id)).state, 'started');
  assert.equal(starts().at(-1)!.kind, 'pi');
  assert.equal(herdr.prompts.at(-1)!.text, prompt);
  assert.equal(database.getWorkItemCount(), 1);
  assert.equal(database.listLaunches().length, 1);
});

test('Jira quick-start resolves only server cache and selects no repositories', async (t) => {
  const { app, database, providers, starts } = await fixture(t);
  await providers.setAssigned([issue]);
  const response = await app.inject({ method: 'POST', url: '/work-items/quick-start', payload: { prompt: 'Fix', jiraIssueId: issue.id } });
  const { details, launch } = response.json<LaunchResponse>();
  assert.equal(response.statusCode, 200);
  assert.equal(launch.state, 'started');
  assert.equal(details.workItem.title, 'PROJ-42: Something');
  assert.equal(attachmentsOfType(details.attachments, 'tracker-item').length, 1);
  assert.equal(attachmentsOfType(details.attachments, 'worktree').length, 0);
  assert.equal(starts().length, 1);
  assert.equal((await app.inject('/dashboard')).json<DashboardResponse>().pendingJiraIssues.length, 0);
  assert.equal(database.listWorkActivity().filter((row) => row.kind === 'work-item.tracker-attached').length, 1);
});

test('explicit repository/template selections validate before any mutation', async (t) => {
  const { app, database, starts } = await fixture(t);
  const work = createActiveWorkItem(database, { title: 'Active', attachments: [] });
  for (const selection of [
    { repoIds: null }, { repoIds: 'repo' }, { repoIds: [42] }, { repoIds: [''] },
    { repoIds: ['a', 'a'] }, { repoIds: ['missing'] }, { repoIds: Array.from({ length: 101 }, (_, i) => String(i)) },
    { promptId: null }, { promptId: '' }, { promptId: 42 }, { promptId: 'missing' },
  ]) {
    for (const url of ['/work-items/quick-start', `/work-items/${work.id}/new-session`]) {
      const response = await app.inject({ method: 'POST', url, payload: { prompt: 'Keep', ...selection } });
      assert.equal(response.statusCode, 400, JSON.stringify(selection));
    }
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
  const workspacesDirectory = join(deps.config.lovelaceDir, 'workspaces');
  deps.workspaceManager = {
    workspacesDirectory,
    repositoryPath: (id: string) => join(deps.config.lovelaceDir, 'repos', id),
    async createWorkspace(request: CreateWorkspaceRequest) {
      calls.push(request);
      assert.ok(deps.database.listLaunches().length > 0, 'prompt persisted before preparation');
      if (failing && request.repository.id.endsWith('/b')) throw new Error('fixture install failure');
      const path = join(workspacesDirectory, request.workspaceId, request.directoryName!);
      await mkdir(path, { recursive: true });
      return {
        repository: { ...request.repository, path: join(deps.config.lovelaceDir, 'repos', request.repository.id) },
        workspaceId: request.workspaceId, path, branchName: request.branchName, baseBranch: 'main', remoteBranch: null, preparations: [],
      };
    },
  } as unknown as RouteDeps['workspaceManager'];
  return { calls, records, setFailing: (value: boolean) => { failing = value; } };
}

test('Jira selections prepare isolated worktrees before a single idempotent agent launch', async (t) => {
  const { app, providers, database, deps, starts } = await fixture(t);
  const { calls, records } = repositoryFixture(deps);
  await providers.setAssigned([issue]);
  const prompt = '  Edited template\n\nExact final text.\n';
  const payload = { prompt, jiraIssueId: issue.id, repoIds: records.map(repo => repo.id), promptId: 'refine', requestId: randomUUID() };
  const first = await app.inject({ method: 'POST', url: '/work-items/quick-start', payload });
  const { details, launch } = first.json<LaunchResponse>();
  assert.equal(launch.state, 'started', launch.error ?? '');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.mode === 'fresh' && call.branchName.includes('proj-42')));
  assert.equal(attachmentsOfType(details.attachments, 'worktree').length, 2);
  assert.deepEqual(launch.repoIds, payload.repoIds);
  assert.equal(launch.promptId, 'refine');
  assert.equal(launch.prompt, prompt);
  assert.equal(session(details).payload.promptId, 'refine');
  assert.equal(starts().length, 1);
  assert.equal((await app.inject({ method: 'POST', url: '/work-items/quick-start', payload })).json<LaunchResponse>().details.workItem.id, details.workItem.id);
  assert.equal(calls.length, 2);
  for (const changes of [{ repoIds: [records[0]!.id] }, { promptId: 'implement' }]) {
    assert.equal((await app.inject({ method: 'POST', url: '/work-items/quick-start', payload: { ...payload, ...changes } })).statusCode, 409);
  }
  assert.equal(database.getWorkItemCount(), 1);
  assert.equal(starts().length, 1);
});

test('review quick-start checks out the pull request branch of its repository and hides the review', async (t) => {
  const { app, providers, database, deps, starts } = await fixture(t);
  const { calls, records } = repositoryFixture(deps);
  providers.data.reviews = [{
    id: 'PR_1', number: 7, title: 'Retry uploads', url: 'https://github.invalid/org/a/pull/7', repoFullName: 'org/a', project: 'org/a',
    type: null, authorLogin: 'human', author: 'human', descriptionText: null, headRefName: 'feature/retry', baseRefName: 'main', updatedAt: '2026-01-01T10:00:00.000Z',
  }];
  await providers.github.refreshReviewRequests();
  assert.deepEqual((await app.inject('/dashboard')).json<DashboardResponse>().pendingReviews.map(review => [review.id, review.repoId]), [['PR_1', records[0]!.id]]);
  for (const payload of [{ reviewRequestId: 'missing', repoIds: [records[0]!.id] }, { reviewRequestId: 'PR_1', repoIds: [records[1]!.id] }, { reviewRequestId: 42 }]) {
    assert.equal((await app.inject({ method: 'POST', url: '/work-items/quick-start', payload: { prompt: 'Review', ...payload } })).statusCode, 400, JSON.stringify(payload));
  }
  assert.equal(database.getWorkItemCount(), 0);

  const response = await app.inject({ method: 'POST', url: '/work-items/quick-start', payload: { prompt: 'Review', reviewRequestId: 'PR_1', repoIds: records.map(repo => repo.id), promptId: 'review' } });
  const { details, launch } = response.json<LaunchResponse>();
  assert.equal(launch.state, 'started', launch.error ?? '');
  assert.equal(details.workItem.title, 'org/a#7: Retry uploads');
  assert.deepEqual(attachmentsOfType(details.attachments, 'change-request').map(meta => meta.externalId), ['PR_1']);
  assert.deepEqual(calls.map(call => [call.repository.id, call.mode, call.remoteBranch]).sort(), [['github/org/a', 'existing', 'feature/retry'], ['github/org/b', 'fresh', null]]);
  assert.equal(starts().length, 1);
  assert.equal((await app.inject('/dashboard')).json<DashboardResponse>().pendingReviews.length, 0);
});

test('partial workspace failure keeps the launch and its retry prepares only failed repositories', async (t) => {
  const { app, deps, starts, database } = await fixture(t);
  const { calls, records, setFailing } = repositoryFixture(deps);
  setFailing(true);
  const payload = { prompt: '  Keep exactly\n', repoIds: records.map(repo => repo.id), promptId: 'implement' };
  const first = (await app.inject({ method: 'POST', url: '/work-items/quick-start', payload })).json<LaunchResponse>();
  assert.equal(first.launch.state, 'failed');
  assert.match(first.launch.error!, /Repository preparation failed/);
  assert.equal(starts().length, 0);
  assert.equal(first.launch.prompt, payload.prompt);
  setFailing(false);
  await app.inject({ method: 'POST', url: `/launches/${first.launch.id}/retry` });
  const retried = await waitForLaunch(database, first.launch.id);
  assert.equal(retried.state, 'started', retried.error ?? '');
  assert.equal(database.getWorkItemCount(), 1);
  assert.equal(calls.length, 3, 'ready repository reused; failed repository retried');
  assert.equal(starts().length, 1);
});

test('new-session rejects inactive work and malformed options without recording a launch', async (t) => {
  const { app, database, starts } = await fixture(t);
  const work = createActiveWorkItem(database, { title: 'Active', attachments: [] });
  const url = `/work-items/${work.id}/new-session`;
  for (const options of [null, [], 'high', { pi: { model: 42 } }, { pi: { thinkingLevel: 'invalid' } }, { unknown: {} }, { pi: { unknown: true } }]) {
    assert.equal((await app.inject({ method: 'POST', url, payload: { prompt: 'Text', options } })).statusCode, 400);
  }
  for (const state of ['done', 'cancelled'] as const) {
    database.updateWorkItemState(work.id, state);
    assert.equal((await app.inject({ method: 'POST', url, payload: { prompt: 'Text' } })).statusCode, 409);
  }
  assert.equal(database.listLaunches(work.id).length, 0);
  assert.equal(starts().length, 0);
  assert.equal((await app.inject({ method: 'POST', url: '/work-items/missing/new-session', payload: { prompt: 'Text' } })).statusCode, 404);
});

test('quick-start passes harness options as native flags and rejects malformed ones', async (t) => {
  const { app, starts } = await fixture(t);
  assert.equal((await app.inject({ method: 'POST', url: '/work-items/quick-start', payload: { prompt: 'Text', options: { pi: { thinkingLevel: 'invalid' } } } })).statusCode, 400);
  const options = { pi: { model: 'fixture/model', thinkingLevel: 'high' } };
  const response = await app.inject({ method: 'POST', url: '/work-items/quick-start', payload: { prompt: 'Text', agentId: 'pi', options } });
  assert.equal(response.json<LaunchResponse>().launch.state, 'started');
  assert.deepEqual(starts()[0]!.args, ['--model', 'fixture/model', '--thinking', 'high']);
  assert.deepEqual(session(response.json<LaunchResponse>().details).payload.options, options.pi);
});

test('new-session passes harness options as native flags and keeps them with the session', async (t) => {
  const { app, database, starts } = await fixture(t);
  const work = createActiveWorkItem(database, { title: 'Active', attachments: [] });
  const options = { pi: { model: 'fixture/model', thinkingLevel: 'high' } };
  const prompt = '  My text\n';
  const response = await app.inject({ method: 'POST', url: `/work-items/${work.id}/new-session`, payload: { prompt, options } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json<LaunchResponse>().launch.state, 'started');
  const launch = database.listLaunches(work.id)[0]!;
  assert.equal(launch.prompt, prompt);
  assert.deepEqual(launch.options, options);
  assert.deepEqual(starts()[0]!.args, ['--model', 'fixture/model', '--thinking', 'high']);
  assert.deepEqual(session(response.json<LaunchResponse>().details).payload.options, options.pi);
});

test('opening a live session focuses its tab and never starts another agent', async (t) => {
  const { app, herdr, starts } = await fixture(t);
  const quick = (await app.inject({ method: 'POST', url: '/work-items/quick-start', payload: { prompt: 'Session' } })).json<LaunchResponse>();
  const { meta, payload } = session(quick.details);
  const url = `/work-items/${quick.details.workItem.id}/sessions/${meta.id}/open`;
  const opened = await app.inject({ method: 'POST', url });
  assert.equal(opened.statusCode, 200);
  assert.equal(opened.json<SessionOpenResponse>().action, 'focused');
  assert.deepEqual(herdr.calls.at(-1), { method: 'focusTab', args: herdr.panes.get(payload.terminalRef!.paneId)!.tabId });
  assert.equal(starts().length, 1);
});

test('opening an ended session continues its exact native conversation in the pane it left', async (t) => {
  const { app, database, herdr, starts } = await fixture(t);
  const quick = (await app.inject({ method: 'POST', url: '/work-items/quick-start', payload: { prompt: 'Session' } })).json<LaunchResponse>();
  const { meta, payload } = session(quick.details);
  const pane = payload.terminalRef!.paneId;
  const reported = herdr.panes.get(pane)!.agentSession!.value;
  herdr.exitAgent(pane);
  const response = await app.inject({ method: 'POST', url: `/work-items/${quick.details.workItem.id}/sessions/${meta.id}/open` });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json<SessionOpenResponse>().action, 'continued');
  assert.deepEqual(starts()[1], { name: payload.agentName, kind: 'pi', paneId: pane, args: ['--session', reported] });
  const continued = database.listAttachments().find(entry => entry.id === meta.id)!.payload as AgentSession;
  assert.equal(continued.status, 'running');
  assert.equal(continued.nativeSessionPath, reported);
  assert.equal(herdr.prompts.length, 1, 'the initial prompt is never replayed');
  assert.equal(database.listWorkActivity().filter(row => row.kind === 'session.continued').length, 1);
});

test('a closed pane continues in a new tab; sessions without native identity are refused', async (t) => {
  const { app, database, herdr, starts } = await fixture(t);
  herdr.reportSessions = false;
  const quick = (await app.inject({ method: 'POST', url: '/work-items/quick-start', payload: { prompt: 'Session', agentId: 'codex' } })).json<LaunchResponse>();
  const { meta, payload } = session(quick.details);
  const url = `/work-items/${quick.details.workItem.id}/sessions/${meta.id}/open`;
  herdr.closePane(payload.terminalRef!.paneId);
  herdr.reportSessions = true;
  const refused = await app.inject({ method: 'POST', url });
  assert.equal(refused.statusCode, 409);
  assert.match(refused.json().error, /No native conversation/);
  assert.equal(starts().length, 1);

  const second = (await app.inject({ method: 'POST', url: `/work-items/${quick.details.workItem.id}/new-session`, payload: { prompt: 'Again', agentId: 'codex' } })).json<LaunchResponse>();
  const meta2 = attachmentsOfType(second.details.attachments, 'session').find(entry => entry.id !== meta.id)!;
  const payload2 = meta2.payload as AgentSession;
  const nativeId = herdr.panes.get(payload2.terminalRef!.paneId)!.agentSession!.value;
  await app.inject({ method: 'POST', url: `/work-items/${quick.details.workItem.id}/sessions/${meta2.id}/open` });
  herdr.closePane(payload2.terminalRef!.paneId);
  const continued = await app.inject({ method: 'POST', url: `/work-items/${quick.details.workItem.id}/sessions/${meta2.id}/open` });
  assert.equal(continued.json<SessionOpenResponse>().action, 'continued');
  assert.deepEqual(starts().at(-1)!.args, ['resume', nativeId]);
  assert.notEqual(starts().at(-1)!.paneId, payload2.terminalRef!.paneId);
  database.updateWorkItemState(quick.details.workItem.id, 'done');
  assert.equal((await app.inject({ method: 'POST', url })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: `/work-items/${quick.details.workItem.id}/sessions/missing/open` })).statusCode, 409);
});

test('tool listing uses the injected discovery and fake harnesses, with their models', async (t) => {
  const { app } = await fixture(t);
  const [first] = (await app.inject('/tools')).json();
  assert.equal(first.id, 'pi');
  assert.deepEqual(first.models, [{ id: 'pi-model' }]);
});

test('a harness whose models cannot be listed is still offered', async (t) => {
  const { app, deps } = await fixture(t);
  deps.listModels = async () => { throw new Error('fixture listing failure'); };
  const listed = (await app.inject('/tools')).json();
  assert.deepEqual(listed.map((tool: { models: unknown[] }) => tool.models), [[], [], []]);
});

test('excluded v3 routes are not mounted and malformed Jira hydration is safe', async (t) => {
  const { app } = await fixture(t, false, fixtureProviders([storedSnapshot('jira.assigned', '{broken')]));
  for (const url of ['/kizzy', '/repo-dashboard', '/security-alerts', '/repository-insights', '/agent-signals']) assert.equal((await app.inject(url)).statusCode, 404);
  const response = await app.inject('/dashboard');
  assert.equal(response.statusCode, 200);
  const dashboard = response.json<DashboardResponse>();
  assert.deepEqual(dashboard.settings, { defaultAgent: 'pi', sidebarSide: 'right', repositoryTopics: [] });
  assert.equal(dashboard.freshness.jiraStale, true);
});

test('stable request IDs coalesce concurrent submissions and replay uncertain replies without another launch', async (t) => {
  const { app, database, herdr, starts } = await fixture(t);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entering = new Promise<void>((resolve) => { started = resolve; });
  const start = herdr.startAgent.bind(herdr);
  herdr.startAgent = async (input) => { started(); await gate; return start(input); };
  const payload = { prompt: 'Same intentional text', requestId: randomUUID() };
  const first = app.inject({ method: 'POST', url: '/work-items/quick-start', payload });
  await entering;
  const second = app.inject({ method: 'POST', url: '/work-items/quick-start', payload });
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.statusCode, 200);
  assert.deepEqual(a.json(), b.json());
  const replay = await app.inject({ method: 'POST', url: '/work-items/quick-start', payload });
  assert.equal(replay.json<LaunchResponse>().details.workItem.id, a.json<LaunchResponse>().details.workItem.id);
  assert.equal(starts().length, 1);
  assert.equal(database.getWorkItemCount(), 1);
  const conflict = await app.inject({ method: 'POST', url: '/work-items/quick-start', payload: { ...payload, prompt: 'Changed intent' } });
  assert.equal(conflict.statusCode, 409);
  assert.equal(database.getWorkItemCount(), 1);
  const intentionalDuplicate = await app.inject({ method: 'POST', url: '/work-items/quick-start', payload: { ...payload, requestId: randomUUID() } });
  assert.equal(intentionalDuplicate.statusCode, 200);
  assert.equal(database.getWorkItemCount(), 2, 'equal text does not deduplicate deliberate new intents');
});

test('restart recovers a pending intent as uncertain and never replays its launch', async (t) => {
  const { app, database, starts } = await fixture(t);
  const payload = { prompt: 'Uncertain', requestId: randomUUID() };
  const completed = (await app.inject({ method: 'POST', url: '/work-items/quick-start', payload })).json<LaunchResponse>();
  interruptLaunch(database, payload.requestId);
  const recovered = (await app.inject({ method: 'POST', url: '/work-items/quick-start', payload })).json<LaunchResponse>();
  assert.equal(recovered.launch.state, 'uncertain');
  assert.match(recovered.launch.error!, /uncertain/);
  assert.equal(recovered.details.workItem.id, completed.details.workItem.id);
  assert.equal(starts().length, 1);
  assert.equal(database.getWorkItemCount(), 1);
  assert.equal((await app.inject({ method: 'POST', url: '/work-items/quick-start', payload })).json<LaunchResponse>().launch.state, 'uncertain');
  assert.equal((await app.inject({ method: 'POST', url: `/launches/${payload.requestId}/retry` })).statusCode, 409);
  assert.equal(starts().length, 1);
});

test('concurrent launches keep separate prompts; an error after the agent started is uncertain', async (t) => {
  const { app, database, herdr } = await fixture(t);
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
  const url = `/work-items/${work.id}/new-session`;
  const aPayload = { prompt: 'A exact\n  ', requestId: randomUUID() };
  const bPayload = { prompt: 'B exact\n\n  ', requestId: randomUUID() };
  const a = app.inject({ method: 'POST', url, payload: aPayload });
  await entering;
  const b = await app.inject({ method: 'POST', url, payload: bPayload });
  assert.equal(b.json<LaunchResponse>().launch.state, 'uncertain');
  assert.match(b.json<LaunchResponse>().launch.error!, /may be running in Herdr pane/);
  release();
  assert.equal((await a).json<LaunchResponse>().launch.state, 'started');
  assert.equal(database.getLaunch(aPayload.requestId)!.state, 'started');
  assert.equal(database.getLaunch(bPayload.requestId)!.state, 'uncertain');
  assert.equal(database.getLaunch(bPayload.requestId)!.prompt, bPayload.prompt);
  const replay = await app.inject({ method: 'POST', url, payload: bPayload });
  assert.equal(replay.json<LaunchResponse>().launch.state, 'uncertain');
  assert.equal((await app.inject({ method: 'POST', url: `/launches/${bPayload.requestId}/retry` })).statusCode, 409);
  assert.equal(database.listLaunches(work.id).length, 2);
});

test('request identity validates UUIDs and scopes endpoint/work/options before mutation', async (t) => {
  const { app, database } = await fixture(t);
  for (const requestId of ['', 'invalid', 42, null]) assert.equal((await app.inject({ method: 'POST', url: '/work-items/quick-start', payload: { prompt: 'Text', requestId } })).statusCode, 400);
  assert.equal(database.getWorkItemCount(), 0);
  const id = randomUUID();
  const original = (await app.inject({ method: 'POST', url: '/work-items/quick-start', payload: { prompt: 'Text', requestId: id } })).json<LaunchResponse>();
  const workId = original.details.workItem.id;
  assert.equal((await app.inject({ method: 'POST', url: `/work-items/${workId}/new-session`, payload: { prompt: 'Text', requestId: id } })).statusCode, 409);
  const sessionIntent = { prompt: 'Options', requestId: randomUUID(), options: { pi: { model: 'fixture/model', thinkingLevel: 'high' } } };
  const url = `/work-items/${workId}/new-session`;
  const first = (await app.inject({ method: 'POST', url, payload: sessionIntent })).json<LaunchResponse>();
  const reversed = { ...sessionIntent, options: { pi: { thinkingLevel: 'high', model: 'fixture/model' } } };
  assert.deepEqual((await app.inject({ method: 'POST', url, payload: reversed })).json(), first);
  assert.equal((await app.inject({ method: 'POST', url, payload: { ...sessionIntent, options: {} } })).statusCode, 409);
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
  const { app, database, deps, starts } = await fixture(t);
  const { records, calls } = repositoryFixture(deps);
  const gate = deferred();
  const create = deps.workspaceManager.createWorkspace.bind(deps.workspaceManager);
  deps.workspaceManager.createWorkspace = async request => { await gate.promise; return create(request); };
  const payload = { prompt: '  Accepted exact text\n\n', repoIds: [records[0]!.id], promptId: 'implement', requestId: randomUUID(), wait: false };
  const accepted = await app.inject({ method: 'POST', url: '/work-items/quick-start', payload });
  assert.equal(accepted.statusCode, 202);
  const response = accepted.json<LaunchResponse>();
  assert.deepEqual([response.launch.state, response.launch.error], ['preparing', null]);
  assert.equal(response.launch.prompt, payload.prompt);
  assert.equal(attachmentsOfType(response.details.attachments, 'worktree')[0]!.payload.status, 'pending');
  assert.equal(response.details.launches[0]!.id, payload.requestId);
  assert.equal(starts().length, 0);
  const lookup = (await app.inject(`/launches/${payload.requestId}`)).json<LaunchResponse>();
  assert.equal(lookup.launch.state, 'preparing');
  assert.equal(database.getWorkItemCount(), 1);
  const replay = await app.inject({ method: 'POST', url: '/work-items/quick-start', payload });
  assert.equal(replay.statusCode, 202);
  assert.equal(replay.json<LaunchResponse>().details.workItem.id, response.details.workItem.id);
  assert.equal(database.listLaunches().length, 1);
  let synchronousDone = false;
  const synchronous = app.inject({ method: 'POST', url: '/work-items/quick-start', payload: { ...payload, wait: true } })
    .then(result => { synchronousDone = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(synchronousDone, false);
  gate.resolve();
  assert.equal((await synchronous).statusCode, 200);
  const completed = (await app.inject(`/launches/${payload.requestId}`)).json<LaunchResponse>();
  assert.equal(completed.launch.state, 'started');
  assert.equal(calls.length, 1);
  assert.equal(starts().length, 1);
});

test('independent accepted tasks prepare concurrently; later task can finish while the first agent starts', async t => {
  const { app, database, deps, herdr, providers } = await fixture(t);
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
  const firstPayload = { prompt: 'First task', jiraIssueId: issue.id, repoIds: [records[0]!.id], requestId: randomUUID(), wait: false };
  const first = (await app.inject({ method: 'POST', url: '/work-items/quick-start', payload: firstPayload })).json<LaunchResponse>();
  const secondPayload = { prompt: 'Second task', agentId: 'claude', repoIds: [records[1]!.id], requestId: randomUUID(), wait: false };
  const second = (await app.inject({ method: 'POST', url: '/work-items/quick-start', payload: secondPayload })).json<LaunchResponse>();
  assert.equal(requests.length, 2, 'neither task waits for another task to provision');
  assert.notEqual(first.details.workItem.id, second.details.workItem.id);
  let dashboard = (await app.inject('/dashboard')).json<DashboardResponse>();
  assert.ok(dashboard.activeWorkItems.every(item => item.launchState === 'preparing'));
  assert.equal(dashboard.pendingJiraIssues.length, 0, 'accepted Jira work is no longer pending');
  preparation[0]!.resolve();
  await starting.promise;
  assert.equal((await app.inject(`/launches/${firstPayload.requestId}`)).json<LaunchResponse>().launch.state, 'starting');
  preparation[1]!.resolve();
  await waitForLaunch(database, secondPayload.requestId);
  assert.equal(database.getLaunch(firstPayload.requestId)!.state, 'starting');
  dashboard = (await app.inject('/dashboard')).json<DashboardResponse>();
  assert.equal(dashboard.activeWorkItems.find(item => item.id === second.details.workItem.id)!.launchState, undefined);
  assert.equal(dashboard.activeWorkItems.find(item => item.id === first.details.workItem.id)!.launchState, 'starting');
  agent.resolve();
  await waitForLaunch(database, firstPayload.requestId);
  assert.equal(herdr.workspaces.size, 2);
  assert.equal(herdr.calls.filter(call => call.method === 'focusTab').length, 0);
  assert.equal(herdr.prompts.length, 2);
});

test('background partial preparation failure keeps the exact launch for retry on the same work item', async t => {
  const { app, database, deps, starts } = await fixture(t);
  const { records, calls, setFailing } = repositoryFixture(deps);
  setFailing(true);
  const payload = { prompt: '  Keep this exact prompt\n\n  ', repoIds: records.map(record => record.id), promptId: 'refine', requestId: randomUUID(), wait: false };
  const accepted = (await app.inject({ method: 'POST', url: '/work-items/quick-start', payload })).json<LaunchResponse>();
  await waitForLaunch(database, payload.requestId);
  const failed = (await app.inject(`/launches/${payload.requestId}`)).json<LaunchResponse>();
  assert.equal(failed.launch.state, 'failed');
  assert.equal(starts().length, 0);
  assert.equal(failed.launch.prompt, payload.prompt);
  assert.deepEqual(failed.launch.repoIds, payload.repoIds);
  assert.equal(failed.launch.promptId, payload.promptId);
  assert.equal((await app.inject('/dashboard')).json<DashboardResponse>().activeWorkItems[0]!.launchState, 'failed');
  const paths = attachmentsOfType(failed.details.attachments, 'worktree').map(meta => meta.payload.worktreePath);
  setFailing(false);
  const retry = await app.inject({ method: 'POST', url: `/launches/${payload.requestId}/retry` });
  assert.equal(retry.statusCode, 202);
  await waitForLaunch(database, payload.requestId);
  const ready = (await app.inject(`/work-items/${accepted.details.workItem.id}`)).json<WorkItemDetails>();
  assert.deepEqual(ready.launches.map(launch => launch.state), ['started']);
  assert.deepEqual(attachmentsOfType(ready.attachments, 'worktree').map(meta => meta.payload.worktreePath), paths);
  assert.equal(database.getWorkItemCount(), 1);
  assert.equal(calls.length, 3, 'ready sibling reused; only failed repository retried');
  assert.equal(starts().length, 1);
});

test('a lost acceptance reply is inspectable by UUID and never duplicates background preparation or launch', async t => {
  const { app, database, deps, starts } = await fixture(t);
  const { records } = repositoryFixture(deps);
  const gate = deferred();
  let preparations = 0;
  const create = deps.workspaceManager.createWorkspace.bind(deps.workspaceManager);
  deps.workspaceManager.createWorkspace = async request => { preparations++; await gate.promise; return create(request); };
  let loseReply = true;
  let posts = 0;
  const client = new LovelaceClient('http://127.0.0.1:27421', async (input, init) => {
    const response = await app.inject({
      method: init?.method === 'POST' ? 'POST' : 'GET', url: new URL(String(input)).pathname,
      payload: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (init?.method === 'POST') { posts++; if (loseReply) return new Promise(() => {}); }
    return Response.json(response.json(), { status: response.statusCode });
  });
  const requestId = randomUUID();
  const options = { wait: false, repoIds: [records[0]!.id], timeoutMs: 30 };
  await assert.rejects(client.quickStart('Lost acceptance', undefined, undefined, undefined, requestId, options),
    error => error instanceof DOMException && error.name === 'TimeoutError');
  assert.equal(posts, 1);
  const lookup = await client.getLaunch(requestId);
  assert.equal(lookup.launch.state, 'preparing');
  loseReply = false;
  const replay = await client.quickStart('Lost acceptance', undefined, undefined, undefined, requestId, options);
  assert.equal(replay.details.workItem.id, lookup.details.workItem.id);
  assert.equal(preparations, 1);
  gate.resolve();
  await waitForLaunch(database, requestId);
  assert.equal((await client.getLaunch(requestId)).launch.state, 'started');
  assert.equal(starts().length, 1);
  assert.equal(database.getWorkItemCount(), 1);
});

test('concurrent sessions on the same item allocate one Herdr workspace and independent panes', async t => {
  const { app, database, herdr } = await fixture(t);
  const work = createActiveWorkItem(database, { title: 'Concurrent sessions', attachments: [] });
  const gate = deferred();
  let allocations = 0;
  const create = herdr.createWorkspace.bind(herdr);
  herdr.createWorkspace = async input => { allocations++; await gate.promise; return create(input); };
  const requests = ['One', 'Two'].map(prompt => ({ prompt, requestId: randomUUID(), wait: false }));
  const responses = await Promise.all(requests.map(payload => app.inject({ method: 'POST', url: `/work-items/${work.id}/new-session`, payload })));
  assert.ok(responses.every(response => response.statusCode === 202));
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
  const { app, database, starts } = await fixture(t);
  for (const wait of ['false', null, 42]) {
    assert.equal((await app.inject({ method: 'POST', url: '/work-items/quick-start', payload: { prompt: 'Text', wait } })).statusCode, 400);
  }
  assert.equal(database.getWorkItemCount(), 0);
  assert.equal((await app.inject('/launches/invalid')).statusCode, 400);
  assert.equal((await app.inject(`/launches/${randomUUID()}`)).statusCode, 404);
  const requestId = randomUUID();
  const payload = { prompt: 'Text', requestId };
  await app.inject({ method: 'POST', url: '/work-items/quick-start', payload });
  const workId = database.listWorkItems()[0]!.id;
  assert.equal((await app.inject({ method: 'POST', url: '/work-items/quick-start', payload: { ...payload, wait: false } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/work-items/${workId}/new-session`, payload: { prompt: 'Text', wait: 'false' } })).statusCode, 400);
  interruptLaunch(database, requestId);
  const recovered = (await app.inject(`/launches/${requestId}`)).json<LaunchResponse>();
  assert.equal(recovered.launch.state, 'uncertain');
  assert.equal((await app.inject(`/work-items/${workId}`)).json<WorkItemDetails>().launches[0]!.state, 'uncertain');
  assert.equal((await app.inject({ method: 'POST', url: `/launches/${requestId}/retry` })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: '/launches/invalid/retry' })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: `/launches/${randomUUID()}/retry` })).statusCode, 404);
  assert.equal(starts().length, 1, 'lookup never replays an interrupted launch');
});

test('cancelling accepted work during preparation never starts an agent or resets local state', async t => {
  const { app, database, deps, starts } = await fixture(t);
  const { records } = repositoryFixture(deps);
  const gate = deferred();
  const create = deps.workspaceManager.createWorkspace.bind(deps.workspaceManager);
  deps.workspaceManager.createWorkspace = async request => { await gate.promise; return create(request); };
  const requestId = randomUUID();
  const accepted = (await app.inject({
    method: 'POST', url: '/work-items/quick-start',
    payload: { prompt: 'Do not start after cancellation', repoIds: [records[0]!.id], requestId, wait: false },
  })).json<LaunchResponse>();
  database.updateWorkItemState(accepted.details.workItem.id, 'cancelled');
  gate.resolve();
  await waitForLaunch(database, requestId);
  const outcome = (await app.inject(`/launches/${requestId}`)).json<LaunchResponse>();
  assert.equal(outcome.launch.state, 'failed');
  assert.equal(outcome.details.workItem.state, 'cancelled');
  assert.equal(starts().length, 0);
  assert.equal((await app.inject({ method: 'POST', url: `/launches/${requestId}/retry` })).statusCode, 409, 'cancelled work is not retried');
});
