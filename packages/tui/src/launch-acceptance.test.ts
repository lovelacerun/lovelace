import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { stripTerminalSequences, visibleWidth, type Component, type TuiAltScreen } from '@earendil-works/pi-tui';
import { ApiError, LovelaceClient, type LaunchRequestOptions, type NewSessionOptions } from '@lovelace/client';
import type { CodingHarnessId, DashboardResponse, QuickStartResponse, ToolLaunchDraftPayload, WorkItemDetails, WorkItemSummary } from '@lovelace/core';
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
class FakeClient extends LovelaceClient {
  records = new Map<string, WorkItemDetails>();
  calls: Array<{ endpoint: string; id: string; prompt: string; requestId: string; agentId?: CodingHarnessId; overrides?: NewSessionOptions; options?: LaunchRequestOptions }> = [];
  linkedIssues = new Set<string>();
  failReads = false;
  opened = 0;
  constructor() { super('http://127.0.0.1:48999', async () => { throw new Error('No fixture network access'); }); }
  override async getDashboard(): Promise<DashboardResponse> {
    const activeWorkItems: WorkItemSummary[] = [...this.records.values()].map(({ workItem, metas, launchOperations }) => {
      const operation = launchOperations!.findLast(operation => operation.status === 'pending') ?? launchOperations!.at(-1)!;
      return { ...workItem, sessionCount: metas.filter(meta => meta.metaType === 'session').length, repositoryCount: 1,
        trackerIssueKeys: [], pullRequestRefs: [], ...(operation.launch.phase === 'started' ? {} : { launchPhase: operation.launch.phase }) };
    });
    return {
      activeWorkItems, pendingJiraIssues: issues.filter(issue => !this.linkedIssues.has(issue.id)),
      recent: { since: '', workItems: activeWorkItems, sessionCount: 0, completedCount: 0, activityCount: 0 },
      settings: { defaultAgent: 'pi', sidebarSide: 'right', repositoryTopics: [] },
      freshness: { jiraFetchedAt: null, githubFetchedAt: null, jiraStale: false, githubStale: false },
    };
  }
  override async getWorkItem(id: string): Promise<WorkItemDetails> {
    if (this.failReads) throw new ApiError(0, 'fixture offline');
    return structuredClone(this.records.get(id)!);
  }
  override async getJiraIssues() { return []; }
  override async getPromptTemplates() { return [{ id: 'refine', title: 'Refine', content: '', builtIn: true, overridden: false }]; }
  override async getRepositories() {
    return [{ id: 'repo', provider: 'github', externalId: 'repo', name: 'api', fullName: 'org/api', cloneUrl: '', defaultBranch: 'main', isArchived: false, topics: [], lastSyncedAt: '' }];
  }
  override async quickStart(prompt: string, jiraIssueId?: string, agentId?: CodingHarnessId, _overrides?: unknown, requestId = '', options?: LaunchRequestOptions) {
    const existing = [...this.records.values()].find(details => details.launchOperations!.some(operation => operation.requestId === requestId));
    const id = existing?.workItem.id ?? `work-${this.records.size + 1}`;
    this.calls.push({ endpoint: 'quickStart', id, prompt, requestId, agentId, options });
    if (jiraIssueId) this.linkedIssues.add(jiraIssueId);
    return existing ? this.response(id, requestId) : this.accept(id, prompt, requestId, agentId, undefined, options);
  }
  override async newSession(id: string, prompt: string, agentId?: CodingHarnessId, overrides?: NewSessionOptions, requestId = '', options?: LaunchRequestOptions) {
    this.calls.push({ endpoint: 'newSession', id, prompt, requestId, agentId, overrides, options });
    return this.accept(id, prompt, requestId, agentId, overrides, options);
  }
  override async openSession(): Promise<never> { this.opened++; assert.fail('launches never focus sessions'); }
  private accept(id: string, prompt: string, requestId: string, agentId?: CodingHarnessId, overrides?: NewSessionOptions, options?: LaunchRequestOptions) {
    const details: WorkItemDetails = this.records.get(id) ?? {
      workItem: { id, title: `Saved ${id}`, state: 'active', notes: null, createdAt: '', updatedAt: '', startedAt: '', completedAt: null },
      metas: [], launchOperations: [],
    };
    const draftMetaId = `draft:${requestId}`;
    const draft: ToolLaunchDraftPayload = {
      revision: requestId, requestId, prompt, repoIds: options?.repoIds ?? null, promptId: options?.promptId ?? null,
      toolIds: [agentId ?? 'pi'], toolOptions: overrides, status: 'pending', createdAt: '', updatedAt: '',
    };
    details.metas.push({ id: draftMetaId, workItemId: id, metaType: 'prompt-draft', provider: 'lovelace', externalId: requestId, payloadJson: JSON.stringify(draft), createdAt: '', updatedAt: '' });
    if (!details.metas.some(meta => meta.metaType === 'repository') && options?.repoIds?.length) {
      details.metas.push({ id: `repo:${id}`, workItemId: id, metaType: 'repository', provider: 'github', externalId: 'repo', createdAt: '', updatedAt: '',
        payloadJson: JSON.stringify({ repoId: 'repo', repoName: 'api', status: 'preparing', preparationStep: 'seed.preparing: npm ci' }) });
    }
    details.launchOperations!.push({ requestId, draftMetaId, status: 'pending', launch: { ok: false, error: null, phase: options?.repoIds?.length ? 'preparing' : 'starting' } });
    this.records.set(id, details);
    return this.response(id, requestId);
  }
  finish(id: string, failed = false) {
    const details = this.records.get(id)!;
    const operation = details.launchOperations!.at(-1)!;
    operation.status = 'completed';
    operation.launch = { ok: !failed, error: failed ? 'npm ci failed in api' : null, phase: failed ? 'failed' : 'started' };
    if (failed) {
      const repository = details.metas.find(meta => meta.metaType === 'repository');
      if (repository) repository.payloadJson = JSON.stringify({ ...JSON.parse(repository.payloadJson!), status: 'failed', errorMessage: 'fixture dependency error' });
    }
    if (!failed) details.metas.push({ id: `session:${id}`, workItemId: id, metaType: 'session', provider: 'pi', externalId: id, createdAt: '', updatedAt: '', payloadJson: JSON.stringify({ title: 'Pi', toolId: 'pi', agentState: 'working' }) });
  }
  response(id: string, requestId: string): QuickStartResponse {
    const details = structuredClone(this.records.get(id)!);
    const operation = details.launchOperations!.find(operation => operation.requestId === requestId)!;
    return { details, launch: operation.launch, operation: { requestId, status: operation.status } };
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
  const client = new FakeClient();
  const root = new AppRoot({ tui: tui as unknown as TuiAltScreen, client });
  const done = root.start();
  t.after(async () => { root.quit(); await done; });
  await settle();
  return { tui, client, root };
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
  const { root, tui, client } = await fixture(t);
  const first = await startIssue(root, tui, '1', '  First exact prompt\n\n');
  assert.equal(first.visible, false);
  assert.equal(root.state.selectedWorkItemId, 'work-1');
  assert.equal(root.state.mutationInFlight, false);
  assert.equal(root.state.drafts.get('jira:1')!.pendingLaunch, undefined);
  assert.equal(root.state.drafts.get('jira:1')!.text, '');
  assert.match(stripTerminalSequences(root.render(120).join('\n')), /Preparing repositories/);
  assert.match(stripTerminalSequences(root.render(120).join('\n')), /npm ci/);
  await hooks(root).fetchDashboard(new AbortController().signal);
  const second = await startIssue(root, tui, '2', 'Second prompt');
  assert.equal(second.visible, false);
  assert.equal(root.state.selectedWorkItemId, 'work-2');
  assert.equal(root.state.mutationInFlight, false);
  assert.equal(client.calls.length, 2);
  assert.ok(client.calls.every(call => call.options?.wait === false));
  assert.notEqual(client.calls[0]!.requestId, client.calls[1]!.requestId);
  assert.ok([...client.records.values()].every(details => details.launchOperations![0]!.status === 'pending'));
  assert.equal(client.opened, 0);

  // Completing another task never selects it or disturbs the new Home draft.
  root.state.navigateToDashboard();
  root.state.setDraft({ text: 'Third task, not submitted' });
  root.state.setFocus('editor');
  client.finish('work-1');
  await hooks(root).fetchDashboard(new AbortController().signal);
  await hooks(root).fetchDetails(new AbortController().signal);
  assert.equal(root.state.view, 'dashboard');
  assert.equal(root.state.draft.text, 'Third task, not submitted');
  assert.equal(root.state.focus, 'editor');
  assert.equal(client.calls.length, 2);
  assert.equal(client.opened, 0);
});

test('background failure stays on its work item and retries the saved prompt/selection/options with a new UUID', async t => {
  const { root, tui, client } = await fixture(t);
  const exact = '  Saved prompt\n\n  Keep whitespace\n';
  await startIssue(root, tui, '1', exact);
  const firstId = client.calls[0]!.requestId;
  const details = client.records.get('work-1')!;
  const draftMeta = details.metas.find(meta => meta.metaType === 'prompt-draft')!;
  const draft = JSON.parse(draftMeta.payloadJson!) as ToolLaunchDraftPayload;
  draft.toolOptions = { pi: { model: 'fixture/model', thinkingLevel: 'high' } };
  draftMeta.payloadJson = JSON.stringify(draft);
  client.finish('work-1', true);
  await hooks(root).fetchDetails(new AbortController().signal);
  root.state.setDraft({ text: 'Another local draft must not become the retry prompt' });
  const doc = renderWorkItem(root.state, 80);
  assert.match(stripTerminalSequences(doc.lines.join('\n')), /Launch failed/);
  assert.match(stripTerminalSequences(doc.lines.join('\n')), /npm ci failed/);
  assert.match(stripTerminalSequences(doc.lines.join('\n')), /fixture dependency error/);
  const retry = doc.actions.find(action => action.kind === 'launch-retry')!;
  assert.ok(retry);
  await handleAction(root.state, retry, hooks(root).makeDeps());
  const call = client.calls.at(-1)!;
  assert.equal(call.endpoint, 'newSession');
  assert.equal(call.id, 'work-1');
  assert.notEqual(call.requestId, firstId);
  assert.equal(call.prompt, exact);
  assert.equal(call.agentId, 'pi');
  assert.deepEqual(call.overrides, draft.toolOptions);
  assert.deepEqual(call.options?.repoIds, ['repo']);
  assert.equal(call.options?.promptId, 'refine');
  assert.equal(client.records.size, 1);
  assert.equal(tui.overlays.filter(overlay => overlay.visible).length, 0, 'retry never reopens the setup window');
  assert.doesNotMatch(stripTerminalSequences(renderWorkItem(root.state, 80).lines.join('\n')), /Launch failed/);
});

test('read failure retains launch progress and quitting stops client polling, not accepted work', async t => {
  const { root, tui, client } = await fixture(t);
  await startIssue(root, tui, '1', 'Start this');
  await settle();
  client.failReads = true;
  await hooks(root).fetchDetails(new AbortController().signal);
  assert.equal(root.state.offline, true);
  assert.equal(root.state.selectedWorkItemData!.launchOperations![0]!.status, 'pending');
  assert.equal(client.calls.length, 1);
  root.quit();
  client.finish('work-1');
  assert.equal(client.records.get('work-1')!.launchOperations![0]!.launch.ok, true);
  assert.equal(client.opened, 0);
});

for (const phase of ['preparing', 'starting', 'failed', 'uncertain'] as const) {
  test(`${phase} progress fits narrow views; uncertain operations never offer an automatic new launch`, async t => {
    const { root, tui, client } = await fixture(t);
    await startIssue(root, tui, '1', 'Prompt');
    const details = structuredClone(client.records.get('work-1')!);
    const operation = details.launchOperations![0]!;
    operation.launch = { phase, ok: false, error: phase === 'uncertain' ? 'Inspect Herdr' : phase === 'failed' ? 'npm ci failed' : null };
    operation.status = phase === 'uncertain' ? 'uncertain' : phase === 'failed' ? 'completed' : 'pending';
    root.state.setWorkItemData(details);
    for (const width of [36, 50, 80, 120]) {
      const doc = renderWorkItem(root.state, width);
      assert.ok(doc.lines.every(line => visibleWidth(line) <= width));
      if (phase === 'uncertain') assert.ok(doc.actions.every(action => action.kind !== 'launch-retry'));
    }
  });
}

test('Home can queue independent tasks while earlier agent startup is pending', async t => {
  const { root, client } = await fixture(t);
  for (const prompt of ['First', 'Second']) {
    root.state.navigateToDashboard();
    root.state.setDraft({ text: prompt });
    await hooks(root).launchFromEditor(prompt);
    assert.equal(root.state.mutationInFlight, false);
    assert.equal(root.state.drafts.get('home')!.text, '');
  }
  assert.equal(client.records.size, 2);
  assert.ok([...client.records.values()].every(details => details.launchOperations![0]!.launch.phase === 'starting'));
  assert.equal(client.calls[0]!.options?.repoIds, undefined, 'Home remains repository-free');
  assert.equal(client.opened, 0);
});

test('acceptance arriving after navigation does not replace the selected issue or its draft', async t => {
  const { root, client } = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const start = client.quickStart.bind(client);
  client.quickStart = async (...args) => { const response = await start(...args); await gate; return response; };
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
  assert.equal(root.state.drafts.get('home')!.pendingLaunch, undefined);
});

test('a reopened TUI restores accepted progress and failed-prompt retry from server state alone', async t => {
  const { root, tui, client } = await fixture(t);
  const exact = '  Durable prompt\n\n  ';
  await startIssue(root, tui, '1', exact);
  root.quit();
  const reopened = new AppRoot({ tui: new FakeTui() as unknown as TuiAltScreen, client });
  const done = reopened.start();
  t.after(async () => { reopened.quit(); await done; });
  await settle();
  reopened.state.navigateToWorkItem('work-1');
  await hooks(reopened).fetchDetails(new AbortController().signal);
  assert.equal(reopened.state.draft.pendingLaunch, undefined, 'no client launch tracker is needed');
  assert.match(stripTerminalSequences(renderWorkItem(reopened.state, 80).lines.join('\n')), /Preparing repositories/);
  client.finish('work-1', true);
  await hooks(reopened).fetchDetails(new AbortController().signal);
  const retry = renderWorkItem(reopened.state, 80).actions.find(action => action.kind === 'launch-retry')!;
  await handleAction(reopened.state, retry, hooks(reopened).makeDeps());
  assert.equal(client.calls.at(-1)!.prompt, exact);
  assert.equal(client.calls.at(-1)!.id, 'work-1');
  assert.equal(client.calls.at(-1)!.endpoint, 'newSession');
  assert.equal(client.records.size, 1);
});
