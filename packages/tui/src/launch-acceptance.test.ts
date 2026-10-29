import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { stripTerminalSequences, visibleWidth, type Component, type TuiAltScreen } from '@earendil-works/pi-tui';
import type { RouterInputs } from '@lovelace/client';
import { fakeClient } from '@lovelace/client/testing';
import { attachmentsOfType, isLaunchInProgress, type AgentSession, type CodingHarnessId, type DashboardResponse, type LaunchResponse, type ToolLaunchOptionsById, type WorkItemDetails, type WorkItemSummary, type Worktree } from '@lovelace/core';
import { AppRoot } from './app.js';
import { handleAction, type ControllerDeps } from './controller.js';
import { JiraStartModal } from './jira-start-modal.js';
import { renderWorkItem } from './views/work-item.js';

class FakeTui {
  terminal = { columns: 120, rows: 40 };
  overlays: Array<{ component: Component; visible: boolean }> = [];
  requestRender() {}
  start() {}
  stop() {}
  addInputListener() { return () => {}; }
  setFocus() {}
  showOverlay(component: Component) {
    const overlay = { component, visible: true };
    this.overlays.push(overlay);
    return { hide: () => { overlay.visible = false; } };
  }
}

const issues = ['1', '2'].map(id => ({ id, key: `PROJ-${id}`, title: `Task ${id}`, url: '', status: 'To Do', issueType: 'Task', updatedAt: '' }));
type QuickStartInput = RouterInputs['launches']['quickStart'];
type NewSessionInput = RouterInputs['launches']['newSession'];
interface LaunchCall {
  endpoint: string; id: string; prompt: string; requestId: string; agentId?: CodingHarnessId; overrides?: ToolLaunchOptionsById;
  repoIds?: string[]; promptId?: string; wait?: boolean;
}
/** Server-side launch records behind a typed fake client. */
class FakeServer {
  records = new Map<string, WorkItemDetails>();
  calls: LaunchCall[] = [];
  retries: string[] = [];
  linkedIssues = new Set<string>();
  failReads = false;
  opened = 0;
  readonly client = fakeClient({
    'dashboard.get': async () => this.dashboard(),
    'workItems.get': async ({ id }) => {
      if (this.failReads) throw new Error('fixture offline');
      return structuredClone(this.records.get(id)!);
    },
    'jira.issues': async () => [],
    'prompts.list': async () => [{ id: 'refine', title: 'Refine', content: '', builtIn: true, overridden: false }],
    'repositories.list': async () => [
      { id: 'repo', provider: 'github', externalId: 'repo', name: 'api', fullName: 'org/api', cloneUrl: '', defaultBranch: 'main', isArchived: false, topics: [], lastSyncedAt: '' },
    ],
    // Read through the instance so a test can delay acceptance.
    'launches.quickStart': input => this.quickStart(input),
    'launches.newSession': async input => this.newSession(input),
    'launches.retry': async ({ id }) => this.retryLaunch(id),
    'sessions.open': async () => { this.opened++; assert.fail('launches never focus sessions'); },
  });
  private dashboard(): DashboardResponse {
    const activeWorkItems: WorkItemSummary[] = [...this.records.values()].map(({ workItem, attachments, launches }) => {
      const launch = launches.findLast(launch => isLaunchInProgress(launch.state)) ?? launches.at(-1)!;
      return { ...workItem, sessionCount: attachments.filter(meta => meta.type === 'session').length, repositoryCount: 1,
        trackerIssueKeys: [], pullRequestRefs: [], ...(launch.state === 'started' ? {} : { launchState: launch.state }) };
    });
    return {
      activeWorkItems, pendingJiraIssues: issues.filter(issue => !this.linkedIssues.has(issue.id)), pendingReviews: [],
      recent: { since: '', workItems: activeWorkItems, sessionCount: 0, completedCount: 0, activityCount: 0 },
      settings: { defaultAgent: 'pi', sidebarSide: 'right', repositoryTopics: [] },
      freshness: { jiraFetchedAt: null, githubFetchedAt: null, jiraStale: false, githubStale: false },
    };
  }
  quickStart = async ({ prompt, jiraIssueId, agentId, requestId = '', repoIds, promptId, wait }: QuickStartInput): Promise<LaunchResponse> => {
    const existing = [...this.records.values()].find(details => details.launches.some(launch => launch.id === requestId));
    const id = existing?.workItem.id ?? `work-${this.records.size + 1}`;
    this.calls.push({ endpoint: 'quickStart', id, prompt, requestId, agentId, repoIds, promptId, wait });
    if (jiraIssueId) this.linkedIssues.add(jiraIssueId);
    return existing ? this.response(id, requestId) : this.accept({ id, prompt, requestId, agentId, repoIds, promptId });
  };
  private newSession({ workItemId: id, prompt, agentId, options: overrides, requestId = '', repoIds, promptId, wait }: NewSessionInput) {
    this.calls.push({ endpoint: 'newSession', id, prompt, requestId, agentId, overrides, repoIds, promptId, wait });
    return this.accept({ id, prompt, requestId, agentId, overrides, repoIds, promptId });
  }
  private retryLaunch(id: string) {
    this.retries.push(id);
    const details = [...this.records.values()].find(details => details.launches.some(launch => launch.id === id))!;
    Object.assign(details.launches.find(launch => launch.id === id)!, { state: 'starting', error: null });
    return this.response(details.workItem.id, id);
  }
  private accept({ id, prompt, requestId, agentId, overrides, repoIds, promptId }: Omit<LaunchCall, 'endpoint' | 'wait'>) {
    const details: WorkItemDetails = this.records.get(id) ?? {
      workItem: { id, title: `Saved ${id}`, state: 'active', notes: null, createdAt: '', updatedAt: '', startedAt: '', completedAt: null },
      attachments: [], launches: [],
    };
    if (!details.attachments.some(meta => meta.type === 'worktree') && repoIds?.length) {
      details.attachments.push({ id: `repo:${id}`, workItemId: id, type: 'worktree', createdAt: '', updatedAt: '',
        payload: { repoId: 'repo', repoName: 'api', status: 'preparing', preparationStep: 'seed.preparing: npm ci' } as Worktree });
    }
    details.launches.push({
      id: requestId, workItemId: id, state: repoIds?.length ? 'preparing' : 'starting', error: null, harness: agentId ?? 'pi',
      options: overrides, repoIds: repoIds ?? [], promptId: promptId ?? null, prompt, createdAt: '', updatedAt: '',
    });
    this.records.set(id, details);
    return this.response(id, requestId);
  }
  finish(id: string, failed = false) {
    const details = this.records.get(id)!;
    Object.assign(details.launches.at(-1)!, { state: failed ? 'failed' : 'started', error: failed ? 'npm ci failed in api' : null });
    if (failed) {
      const repository = attachmentsOfType(details.attachments, 'worktree')[0];
      if (repository) repository.payload = { ...repository.payload, status: 'failed', errorMessage: 'fixture dependency error' };
    }
    if (!failed) details.attachments.push({ id: `session:${id}`, workItemId: id, type: 'session', createdAt: '', updatedAt: '', payload: { title: 'Pi', toolId: 'pi', agentState: 'working' } as AgentSession });
  }
  response(id: string, requestId: string): LaunchResponse {
    const details = structuredClone(this.records.get(id)!);
    return { details, launch: details.launches.find(launch => launch.id === requestId)! };
  }
}

interface Hooks {
  openJiraStart(): void;
  fetchDashboard(signal: AbortSignal): Promise<void>;
  fetchDetails(signal: AbortSignal): Promise<void>;
  launchFromEditor(prompt: string): Promise<void>;
  makeDeps(): ControllerDeps;
}
const hooks = (root: AppRoot) => root as unknown as Hooks;
async function settle() { await new Promise(resolve => setImmediate(resolve)); }

async function fixture(t: TestContext) {
  const tui = new FakeTui();
  const server = new FakeServer();
  const root = new AppRoot({ tui: tui as unknown as TuiAltScreen, client: server.client, serverUrl: 'http://127.0.0.1:48999' });
  const done = root.start();
  t.after(async () => { root.quit(); await done; });
  await settle();
  return { tui, server, root };
}

async function startIssue(root: AppRoot, tui: FakeTui, id: string, prompt: string) {
  root.state.navigate({ kind: 'jira', id });
  root.state.setDraft({ text: prompt, repoIds: ['repo'], promptId: 'refine' });
  hooks(root).openJiraStart();
  const overlay = tui.overlays.at(-1)!;
  const modal = overlay.component as JiraStartModal;
  await settle();
  assert.equal(modal.loading, false);
  await modal.start();
  return overlay;
}

test('Jira overlay closes on acceptance and a second task can start before either agent is ready', async t => {
  const { root, tui, server } = await fixture(t);
  const first = await startIssue(root, tui, '1', '  First exact prompt\n\n');
  assert.equal(first.visible, false);
  assert.equal(root.state.selectedWorkItemId, 'work-1');
  assert.equal(root.state.mutationInFlight, false);
  assert.equal(root.state.drafts.get('jira:1')!.requestId, undefined);
  assert.equal(root.state.drafts.get('jira:1')!.text, '');
  assert.match(stripTerminalSequences(root.render(120).join('\n')), /Preparing repositories/);
  assert.match(stripTerminalSequences(root.render(120).join('\n')), /npm ci/);
  await hooks(root).fetchDashboard(new AbortController().signal);
  const second = await startIssue(root, tui, '2', 'Second prompt');
  assert.equal(second.visible, false);
  assert.equal(root.state.selectedWorkItemId, 'work-2');
  assert.equal(root.state.mutationInFlight, false);
  assert.equal(server.calls.length, 2);
  assert.ok(server.calls.every(call => call.wait === false));
  assert.notEqual(server.calls[0]!.requestId, server.calls[1]!.requestId);
  assert.ok([...server.records.values()].every(details => isLaunchInProgress(details.launches[0]!.state)));
  assert.equal(server.opened, 0);

  // Completing another task never selects it or disturbs the new Home draft.
  root.state.navigateToDashboard();
  root.state.setDraft({ text: 'Third task, not submitted' });
  root.state.setFocus('editor');
  server.finish('work-1');
  await hooks(root).fetchDashboard(new AbortController().signal);
  await hooks(root).fetchDetails(new AbortController().signal);
  assert.equal(root.state.view, 'dashboard');
  assert.equal(root.state.draft.text, 'Third task, not submitted');
  assert.equal(root.state.focus, 'editor');
  assert.equal(server.calls.length, 2);
  assert.equal(server.opened, 0);
});

test('background failure stays on its work item and the server retries its saved launch', async t => {
  const { root, tui, server } = await fixture(t);
  await startIssue(root, tui, '1', '  Saved prompt\n\n  Keep whitespace\n');
  const firstId = server.calls[0]!.requestId;
  server.finish('work-1', true);
  await hooks(root).fetchDetails(new AbortController().signal);
  root.state.setDraft({ text: 'Another local draft must not become the retry prompt' });
  const doc = renderWorkItem(root.state, 80);
  assert.match(stripTerminalSequences(doc.lines.join('\n')), /Launch failed/);
  assert.match(stripTerminalSequences(doc.lines.join('\n')), /npm ci failed/);
  assert.match(stripTerminalSequences(doc.lines.join('\n')), /fixture dependency error/);
  const retry = doc.actions.find(action => action.kind === 'launch-retry')!;
  assert.deepEqual(retry, { kind: 'launch-retry', launchId: firstId });
  await handleAction(root.state, retry, hooks(root).makeDeps());
  assert.deepEqual(server.retries, [firstId]);
  assert.equal(server.calls.length, 1, 'retry sends no new launch request');
  assert.equal(root.state.draft.text, 'Another local draft must not become the retry prompt');
  assert.equal(server.records.size, 1);
  assert.equal(tui.overlays.filter(overlay => overlay.visible).length, 0, 'retry never reopens the setup window');
  assert.doesNotMatch(stripTerminalSequences(renderWorkItem(root.state, 80).lines.join('\n')), /Launch failed/);
});

test('read failure retains launch progress and quitting stops client polling, not accepted work', async t => {
  const { root, tui, server } = await fixture(t);
  await startIssue(root, tui, '1', 'Start this');
  await settle();
  server.failReads = true;
  await hooks(root).fetchDetails(new AbortController().signal);
  assert.equal(root.state.offline, true);
  assert.equal(root.state.selectedWorkItemData!.launches[0]!.state, 'preparing');
  assert.equal(server.calls.length, 1);
  root.quit();
  server.finish('work-1');
  assert.equal(server.records.get('work-1')!.launches[0]!.state, 'started');
  assert.equal(server.opened, 0);
});

for (const phase of ['preparing', 'starting', 'failed', 'uncertain'] as const) {
  test(`${phase} progress fits narrow views; uncertain launches never offer a retry`, async t => {
    const { root, tui, server } = await fixture(t);
    await startIssue(root, tui, '1', 'Prompt');
    const details = structuredClone(server.records.get('work-1')!);
    Object.assign(details.launches[0]!, { state: phase, error: phase === 'uncertain' ? 'Inspect Herdr' : phase === 'failed' ? 'npm ci failed' : null });
    root.state.setWorkItemData(details);
    for (const width of [36, 50, 80, 120]) {
      const doc = renderWorkItem(root.state, width);
      assert.ok(doc.lines.every(line => visibleWidth(line) <= width));
      if (phase === 'uncertain') assert.ok(doc.actions.every(action => action.kind !== 'launch-retry'));
    }
  });
}

test('Home can queue independent tasks while earlier agent startup is pending', async t => {
  const { root, server } = await fixture(t);
  for (const prompt of ['First', 'Second']) {
    root.state.navigateToDashboard();
    root.state.setDraft({ text: prompt });
    await hooks(root).launchFromEditor(prompt);
    assert.equal(root.state.mutationInFlight, false);
    assert.equal(root.state.drafts.get('home')!.text, '');
  }
  assert.equal(server.records.size, 2);
  assert.ok([...server.records.values()].every(details => details.launches[0]!.state === 'starting'));
  assert.equal(server.calls[0]!.repoIds, undefined, 'Home remains repository-free');
  assert.equal(server.opened, 0);
});

test('acceptance arriving after navigation does not replace the selected issue or its draft', async t => {
  const { root, server } = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const start = server.quickStart;
  server.quickStart = async input => { const response = await start(input); await gate; return response; };
  root.state.setDraft({ text: 'Home task' });
  const pending = hooks(root).launchFromEditor('Home task');
  await settle();
  root.state.navigate({ kind: 'jira', id: '2' });
  root.state.setDraft({ text: 'Untouched second issue', repoIds: ['repo'] });
  release();
  await pending;
  assert.equal(root.state.view, 'jira');
  assert.equal(root.state.selectedJira!.id, '2');
  assert.equal(root.state.draft.text, 'Untouched second issue');
  assert.deepEqual(root.state.draft.repoIds, ['repo']);
  assert.equal(root.state.drafts.get('home')!.requestId, undefined);
});

test('a reopened TUI restores accepted progress and failed-prompt retry from server state alone', async t => {
  const { root, tui, server } = await fixture(t);
  const exact = '  Durable prompt\n\n  ';
  await startIssue(root, tui, '1', exact);
  root.quit();
  const reopened = new AppRoot({ tui: new FakeTui() as unknown as TuiAltScreen, client: server.client, serverUrl: 'http://127.0.0.1:48999' });
  const done = reopened.start();
  t.after(async () => { reopened.quit(); await done; });
  await settle();
  reopened.state.navigateToWorkItem('work-1');
  await hooks(reopened).fetchDetails(new AbortController().signal);
  assert.equal(reopened.state.draft.requestId, undefined, 'no client launch tracker is needed');
  assert.match(stripTerminalSequences(renderWorkItem(reopened.state, 80).lines.join('\n')), /Preparing repositories/);
  server.finish('work-1', true);
  await hooks(reopened).fetchDetails(new AbortController().signal);
  const retry = renderWorkItem(reopened.state, 80).actions.find(action => action.kind === 'launch-retry')!;
  await handleAction(reopened.state, retry, hooks(reopened).makeDeps());
  assert.deepEqual(server.retries, [server.calls[0]!.requestId]);
  assert.equal(server.calls.length, 1);
  assert.equal(server.records.get('work-1')!.launches[0]!.prompt, exact);
  assert.equal(server.records.size, 1);
});
