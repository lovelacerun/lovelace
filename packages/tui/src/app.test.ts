import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getOsc8LinkAtColumn, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import type { Component, TuiAltScreen, TuiMouseEvent } from '@earendil-works/pi-tui';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { TestContext } from 'node:test';
import { ApiError, LovelaceClient, type LaunchRequestOptions } from '@lovelace/client';
import {
  CODING_HARNESSES, type AvailableHarness, type DashboardResponse, type QuickStartResponse, type SessionOpenResponse,
  type WorkItemDetails, type WorkItemState,
} from '@lovelace/core';
import { AppRoot } from './app.js';
import { JiraStartModal } from './jira-start-modal.js';

// -- FakeTui --------------------------------------------------------------

class FakeTerminal {
  constructor(public columns = 80, public rows = 24) {}
}

class FakeTui {
  readonly terminal = new FakeTerminal();
  readonly events: string[] = [];
  readonly focusCalls: Array<Component | null> = [];
  readonly overlays: Array<{ component: Component; visible: boolean; options: unknown }> = [];
  private inputListeners: Array<(data: string) => unknown> = [];
  state = { started: 0, stopped: 0 };

  requestRender(_force?: boolean) { this.events.push('render'); }
  start() { this.events.push('start'); this.state.started++; }
  stop(_options?: unknown) { this.events.push('stop'); this.state.stopped++; }
  setFocus(component: Component | null) {
    this.focusCalls.push(component);
    this.events.push(component === null ? 'focus:null' : 'focus:editor');
  }
  showOverlay(component: Component, options?: unknown) {
    const overlay = { component, options, visible: true };
    this.overlays.push(overlay);
    this.setFocus(component);
    return {
      hide: () => { overlay.visible = false; this.setFocus(null); },
      focus: () => this.setFocus(component),
      isFocused: () => this.focusCalls.at(-1) === component,
      setHidden: (hidden: boolean) => { overlay.visible = !hidden; },
      isHidden: () => !overlay.visible,
      unfocus: () => this.setFocus(null),
      getBounds: () => undefined,
    };
  }
  setLayoutRoot(_component: unknown) { /* noop */ }
  addInputListener(l: (data: string) => unknown) {
    this.inputListeners.push(l);
    return () => { this.inputListeners = this.inputListeners.filter(x => x !== l); };
  }
  removeInputListener(_l: unknown) { /* noop */ }
  resize(cols: number, rows: number) {
    this.terminal.columns = cols;
    this.terminal.rows = rows;
  }
  /** Simulate a stdin chunk routed to AppRoot. */
  feedInput(data: string) {
    for (const l of this.inputListeners) l(data);
  }
}

// -- FakeClient -----------------------------------------------------------

interface OpenCall { workItemId: string; metaId: string }
interface LaunchCall { endpoint: 'quickStart' | 'newSession'; workItemId?: string; jiraIssueId?: string; prompt: string; requestId?: string; repoIds?: string[]; promptId?: string }

class FakeClient {
  readonly serverUrl = 'http://127.0.0.1:4747';
  dashboardResponse: DashboardResponse = emptyDashboard();
  workItemByIdResponse: Record<string, WorkItemDetails> = {};
  readonly openCalls: OpenCall[] = [];
  readonly launchCalls: LaunchCall[] = [];
  openQueue: Array<SessionOpenResponse | Error> = [];
  launchQueue: Array<QuickStartResponse | Error> = [];

  async getDashboard() { return this.dashboardResponse; }
  async getWorkItem(id: string): Promise<WorkItemDetails> {
    return this.workItemByIdResponse[id] ?? detailsOf(id);
  }
  async getJiraIssues() { return []; }
  async getTools() { return fixtureTools(); }
  async openSession(workItemId: string, metaId: string): Promise<SessionOpenResponse> {
    this.openCalls.push({ workItemId, metaId });
    const next = this.openQueue.shift();
    if (!next) throw new Error('No queued open response');
    if (next instanceof Error) throw next;
    return next;
  }
  async setWorkItemState() { return {} as never; }
  async quickStart(prompt: string, jiraIssueId?: string, _agentId?: unknown, _overrides?: unknown, requestId?: string, options?: LaunchRequestOptions): Promise<QuickStartResponse> {
    this.launchCalls.push({ endpoint: 'quickStart', jiraIssueId, prompt, requestId, ...(options?.repoIds ? { repoIds: options.repoIds } : {}), ...(options?.promptId ? { promptId: options.promptId } : {}) });
    const next = this.launchQueue.shift();
    if (!next) throw new Error('No queued launch response');
    if (next instanceof Error) throw next;
    return next;
  }
  async newSession(id: string, prompt: string, _agentId?: unknown, _o?: unknown, requestId?: string): Promise<QuickStartResponse> {
    this.launchCalls.push({ endpoint: 'newSession', workItemId: id, prompt, requestId });
    const next = this.launchQueue.shift();
    if (!next) throw new Error('No queued launch response');
    if (next instanceof Error) throw next;
    return next;
  }
}

function fakeClient(): LovelaceClient {
  return new FakeClient() as unknown as LovelaceClient;
}

function asFake(c: LovelaceClient): FakeClient {
  return c as unknown as FakeClient;
}

// -- Helpers --------------------------------------------------------------

function fixtureTools(): AvailableHarness[] {
  return (['pi', 'claude'] as const).map((id, index) => ({
    id, title: id === 'pi' ? 'Pi' : 'Claude Code', thinkingLevels: CODING_HARNESSES.find(entry => entry.id === id)!.thinkingLevels,
    executablePath: `/fixture/${id}`, defaultSelected: index === 0, models: id === 'claude' ? [{ id: 'opus' }, { id: 'sonnet' }] : [],
  }));
}

function emptyDashboard(): DashboardResponse {
  return {
    activeWorkItems: [],
    pendingJiraIssues: [],
    recent: { since: '', workItems: [], sessionCount: 0, completedCount: 0, activityCount: 0 },
    settings: { defaultAgent: 'pi', sidebarSide: 'right', repositoryTopics: [] },
    freshness: { jiraFetchedAt: null, githubFetchedAt: null, jiraStale: false, githubStale: false },
  };
}

function detailsOf(id: string, state: WorkItemState = 'active'): WorkItemDetails {
  return {
    workItem: {
      id, title: `Item ${id}`, state, notes: null,
      createdAt: '', updatedAt: '', startedAt: null, completedAt: null,
    },
    metas: [],
  };
}

function makeRoot(opts: { tui?: FakeTui; client?: LovelaceClient } = {}) {
  const tui = opts.tui ?? new FakeTui();
  const client = opts.client ?? fakeClient();
  const root = new AppRoot({ tui: tui as unknown as TuiAltScreen, client });
  return { root, tui, client: client as LovelaceClient };
}

function withSession(id: string, state: WorkItemState = 'active'): WorkItemDetails {
  const details = detailsOf(id, state);
  details.metas.push({
    id: 'm', workItemId: id, metaType: 'session', provider: 'pi', externalId: 'll-fixture',
    payloadJson: JSON.stringify({ title: 'Pi', toolId: 'pi', status: 'ended', agentState: 'ended' }), createdAt: '', updatedAt: '',
  });
  return details;
}

const openSession = (root: AppRoot, metaId = 'm') => (root as unknown as { openSession: (id: string) => Promise<void> }).openSession(metaId);

// -- Tests ----------------------------------------------------------------

describe('AppRoot Jira start-work overlay', () => {
  it('keeps Jira details underneath one modal with repositories and an editable prompt together', async (t) => {
    const { root, tui, client } = makeRoot();
    client.getPromptTemplates = async () => [{ id: 'refine', title: 'Refine', content: '', builtIn: true, overridden: true }];
    client.getRepositories = async () => ['sync', 'client'].map((name, index) => ({
      id: String(index), provider: 'github', externalId: String(index), name, fullName: `org/${name}`,
      cloneUrl: '', defaultBranch: 'main', isArchived: false, topics: [index ? 'examplecom' : 'infra'], lastSyncedAt: '',
    }));
    client.renderPrompt = async () => ({ promptId: 'refine', content: '  Rendered prompt\n' });
    const issue = { id: '42', key: 'PROJ-42', title: 'Fix sync', url: '', status: 'To Do', issueType: 'Task', updatedAt: '' };
    asFake(client).dashboardResponse.pendingJiraIssues = [issue];
    asFake(client).dashboardResponse.settings.repositoryTopics = ['infra', 'examplecom'];
    const done = root.start();
    t.after(async () => { root.quit(); await done; });
    root.state.applyDashboardResponse(asFake(client).dashboardResponse);
    root.state.navigate({ kind: 'jira', id: issue.id });
    tui.feedInput('\r');
    const overlay = tui.overlays[0]!;
    const modal = overlay.component as JiraStartModal;
    await waitFor(() => !modal.loading);
    assert.equal(root.state.view, 'jira');
    assert.equal(modal.topicFilter.getValue(), 'infra, examplecom');
    assert.match(root.render(80).join('\n'), /Description/);
    assert.equal(tui.overlays.length, 1);
    assert.deepEqual(overlay.options, { width: '96%', maxHeight: '96%', margin: 1, anchor: 'center' });
    const screen = stripTerminalSequences(modal.render(76).join('\n'));
    assert.match(screen, /\[ \] sync/);
    assert.match(screen, /Refine/);
    assert.match(screen, /Rendered prompt/);
    assert.equal(root.editor.getExpandedText(), '', 'background editor is not replaced with a picker');
    tui.feedInput(' ');
    assert.deepEqual(root.state.draft.repoIds, ['0']);
    tui.feedInput('\x1b[47u');
    tui.feedInput('\x1b[200~client topic:examplecom\x1b[201~');
    tui.feedInput('\r');
    tui.feedInput('\x1b[32u');
    assert.deepEqual(root.state.draft.repoIds, ['0', '1']);
    for (const [cols, rows] of [[50, 12], [80, 24], [120, 36]]) {
      tui.resize(cols!, rows!);
      const lines = modal.render(cols! - 2);
      assert.ok(lines.length <= rows! - 2);
      assert.ok(lines.every(line => visibleWidth(line) <= cols! - 2));
      assert.match(lines.join('\n'), /2 repositories/);
      assert.match(lines.join('\n'), /Name:/);
      // Narrow dialogs show only the focused pane; Tab reaches the prompt.
      if (cols! >= 80) assert.match(lines.join('\n'), /Prompt/);
      else assert.doesNotMatch(lines.join('\n'), /Template:/);
    }
    tui.feedInput('\t'); // template
    tui.feedInput('\t'); // prompt
    assert.equal(modal.focus, 'prompt');
    tui.feedInput('\x1b[1;5F');
    tui.feedInput('Edited');
    const prompt = modal.editor.getExpandedText();
    asFake(client).launchQueue.push({ details: detailsOf('created'), launch: { ok: false, error: 'fixture preparation failure' } });
    tui.feedInput('\x13');
    await waitFor(() => !root.state.mutationInFlight);
    const launch = asFake(client).launchCalls[0]!;
    assert.equal(launch.jiraIssueId, '42');
    assert.deepEqual(launch.repoIds, ['0', '1']);
    assert.equal(launch.promptId, 'refine');
    assert.equal(launch.prompt, prompt);
    assert.equal(root.state.draft.retryWorkId, 'created');
    assert.equal(overlay.visible, true, 'failure stays in the same dialog');
    assert.match(modal.render(100).join('\n'), /fixture preparation failure/);
    tui.feedInput('\x1b');
    assert.equal(overlay.visible, false);
    assert.equal(root.state.view, 'jira', 'Escape closes the overlay, not the underlying page');
    assert.equal(root.editor.getExpandedText(), prompt);
  });

  it('isolates filter command letters, retains drafts on cancel and refuses unresolved launch changes', async (t) => {
    const { root, tui, client } = makeRoot();
    client.getPromptTemplates = async () => [];
    client.getRepositories = async () => [];
    const issue = { id: '42', key: 'PROJ-42', title: 'Task', url: '', status: null, issueType: null, updatedAt: '' };
    asFake(client).dashboardResponse.pendingJiraIssues = [issue];
    const done = root.start();
    t.after(async () => { root.quit(); await done; });
    root.state.applyDashboardResponse(asFake(client).dashboardResponse);
    root.state.navigate({ kind: 'jira', id: issue.id });
    root.state.setDraft({ text: 'Keep prompt', repoIds: ['1'] });
    tui.feedInput('n'); // Jira opens the modal, never a hidden quick-start editor.
    const modal = tui.overlays[0]!.component as JiraStartModal;
    await waitFor(() => !modal.loading);
    tui.feedInput('/');
    tui.feedInput('qrnd');
    assert.equal(modal.nameFilter.getValue(), 'qrnd');
    assert.equal(tui.state.stopped, 0);
    tui.feedInput('\x1b');
    assert.equal(tui.overlays[0]!.visible, false);
    assert.equal(root.state.view, 'jira');
    assert.equal(root.state.draft.text, 'Keep prompt');
    assert.deepEqual(root.state.draft.repoIds, ['1']);
    root.state.setDraft({
      text: 'An edit must not replace the saved request',
      pendingLaunch: { endpoint: 'quickStart', jiraIssueId: '42', prompt: 'Keep prompt', requestId: 'id', repoIds: ['1'] },
    });
    assert.match(root.render(80).join('\n'), /Retry exact saved launch/);
    asFake(client).launchQueue.push(new ApiError(503, 'Fixture retry failed'));
    tui.feedInput('\r');
    await waitFor(() => asFake(client).launchCalls.length === 1 && !root.state.mutationInFlight);
    assert.equal(tui.overlays.length, 1, 'cannot change an unresolved intent');
    assert.equal(asFake(client).launchCalls[0]!.prompt, 'Keep prompt');
    assert.equal(asFake(client).launchCalls[0]!.requestId, 'id');
    assert.deepEqual(asFake(client).launchCalls[0]!.repoIds, ['1']);
    assert.match(root.state.error!, /Fixture retry failed/);
  });

  it('a successful start closes the overlay and navigates to the saved work without opening a session', async (t) => {
    const { root, tui, client } = makeRoot();
    client.getPromptTemplates = async () => [];
    client.getRepositories = async () => [];
    const issue = { id: '42', key: 'PROJ-42', title: 'Task', url: '', status: null, issueType: null, updatedAt: '' };
    asFake(client).dashboardResponse.pendingJiraIssues = [issue];
    const done = root.start();
    t.after(async () => { root.quit(); await done; });
    root.state.applyDashboardResponse(asFake(client).dashboardResponse);
    root.state.navigate({ kind: 'jira', id: issue.id });
    root.state.setDraft({ text: 'Start this task' });
    tui.feedInput('\r');
    const modal = tui.overlays[0]!.component as JiraStartModal;
    await waitFor(() => !modal.loading);
    asFake(client).launchQueue.push({ details: detailsOf('created'), launch: { ok: true, error: null } });
    tui.feedInput('\x13');
    await waitFor(() => !tui.overlays[0]!.visible);
    assert.equal(root.state.view, 'work-item');
    assert.equal(root.state.selectedWorkItemId, 'created');
    assert.equal(asFake(client).openCalls.length, 0);
  });
});

describe('AppRoot session open', () => {
  it('selecting a session asks the server once; Herdr focuses or continues it', async (t) => {
    let finish!: (value: SessionOpenResponse) => void;
    const client = fakeClient();
    client.openSession = (workItemId, metaId) => { asFake(client).openCalls.push({ workItemId, metaId }); return new Promise(resolve => { finish = resolve; }); };
    const { root, tui } = makeRoot({ client });
    const done = root.start();
    t.after(async () => { root.quit(); await done; });
    root.state.navigateToWorkItem('wi');
    root.state.setWorkItemData(withSession('wi'));
    tui.feedInput('\r');
    tui.feedInput('\r');
    assert.deepEqual(asFake(client).openCalls, [{ workItemId: 'wi', metaId: 'm' }]);
    assert.equal(root.state.pendingConfirm, null, 'no confirmation: selecting is the request');
    finish({ action: 'continued', details: withSession('wi') });
    await waitFor(() => root.state.notice === 'Continued the conversation in Herdr.');
    assert.equal(asFake(client).launchCalls.length, 0);
  });

  it('a focused session clears the notice and server refusals surface as errors', async () => {
    const { root, client } = makeRoot();
    root.state.navigateToWorkItem('wi');
    root.state.setWorkItemData(withSession('wi'));
    asFake(client).openQueue.push({ action: 'focused', details: withSession('wi') }, new ApiError(409, 'No native conversation was recorded for this session'));
    await openSession(root);
    assert.equal(root.state.notice, null);
    assert.equal(root.state.error, null);
    await openSession(root);
    assert.match(root.state.error!, /No native conversation/);
    root.stop();
  });

  for (const localState of ['done', 'cancelled'] as const) {
    it(localState + ' work needs explicit reactivation before opening a session', async () => {
      const { root, client } = makeRoot();
      root.state.navigateToWorkItem('wi');
      root.state.setWorkItemData(withSession('wi', localState));
      await openSession(root);
      assert.match(root.state.error!, /Reactivate local work explicitly/);
      assert.equal(asFake(client).openCalls.length, 0);
      root.stop();
    });
  }

  it('a late open reply after quit changes nothing', async (t) => {
    let finish!: (value: SessionOpenResponse) => void;
    const client = fakeClient();
    client.openSession = () => new Promise(resolve => { finish = resolve; });
    const { root, tui } = makeRoot({ client });
    const done = root.start();
    t.after(() => root.stop());
    root.state.navigateToWorkItem('wi');
    const opening = openSession(root);
    root.quit();
    await done;
    const starts = tui.state.started;
    finish({ action: 'continued', details: withSession('wi') });
    await opening;
    assert.equal(tui.state.started, starts);
    assert.notEqual(root.state.notice, 'Continued the conversation in Herdr.');
  });
});

describe('AppRoot editor sync across drafts', () => {
  it('swaps editor contents when navigating between work items and back', async () => {
    const { root, client, tui } = makeRoot();
    const dash = emptyDashboard();
    dash.activeWorkItems = [
      { id: 'wi-A', title: 'A', state: 'active', notes: null, createdAt: '', updatedAt: '', startedAt: null, completedAt: null, sessionCount: 0, repositoryCount: 0, trackerIssueKeys: [], pullRequestRefs: [] },
      { id: 'wi-B', title: 'B', state: 'active', notes: null, createdAt: '', updatedAt: '', startedAt: null, completedAt: null, sessionCount: 0, repositoryCount: 0, trackerIssueKeys: [], pullRequestRefs: [] },
    ];
    asFake(client).dashboardResponse = dash;
    root.state.applyDashboardResponse(dash);

    // Navigate to A and set a draft.
    root.state.navigateToWorkItem('wi-A');
    root.state.setDraft({ text: 'hello A' });
    // syncEditor runs on render + input routing. Force by rendering.
    root.render(80);
    assert.equal(root.editor.getText(), 'hello A');

    // Navigate to B — editor should reset to B's (empty) draft after render.
    root.state.navigateToWorkItem('wi-B');
    root.render(80);
    assert.equal(root.editor.getText(), '');

    // Back to A — A's text is restored.
    root.state.navigateToWorkItem('wi-A');
    root.render(80);
    assert.equal(root.editor.getText(), 'hello A');

    // Only Home can focus the dock editor.
    (root as unknown as { focusEditor: () => void }).focusEditor();
    assert.equal(root.editor.focused, false);
    root.state.navigateToDashboard();
    (root as unknown as { focusEditor: () => void }).focusEditor();
    const lastFocus = tui.focusCalls[tui.focusCalls.length - 1];
    assert.ok(lastFocus === root.editor, 'tui.setFocus called with editor');
    assert.equal(root.editor.focused, true);

    // Leaving editor focus clears pi-tui focus.
    root.state.setFocus('content');
    (root as unknown as { applyFocusToTui: () => void }).applyFocusToTui();
    assert.equal(root.editor.focused, false);
    assert.equal(tui.focusCalls[tui.focusCalls.length - 1], null);
    root.stop();
  });

  it('editor onChange from a keystroke does not clobber a retained requestId', async () => {
    const { root } = makeRoot();
    root.state.setDraft({ text: '', pendingLaunch: { endpoint: 'quickStart', prompt: 'p', requestId: 'retained-uuid' } });
    // Simulate the editor firing onChange from a plain character edit.
    root.editor.handleInput('x');
    assert.equal(root.state.draft.pendingLaunch?.requestId, 'retained-uuid', 'requestId preserved by onChange');
    root.stop();
  });
});

describe('AppRoot offline rendering', () => {
  it('keeps the last-known dashboard content and shows an offline banner', () => {
    const { root, client } = makeRoot();
    const dash = emptyDashboard();
    dash.activeWorkItems = [
      { id: 'wi-A', title: 'Alpha Task', state: 'active', notes: null, createdAt: '', updatedAt: '', startedAt: null, completedAt: null, sessionCount: 0, repositoryCount: 0, trackerIssueKeys: [], pullRequestRefs: [] },
    ];
    asFake(client).dashboardResponse = dash;
    root.state.applyDashboardResponse(dash);
    root.state.setOffline();
    const output = root.render(80).join('\n');
    assert.match(output, /Alpha Task/, 'cached dashboard content still present');
    assert.match(output, /Offline/, 'offline banner shown');
    root.stop();
  });
});

describe('AppRoot requestId lifecycle integration', () => {
  it('confirmed completed failure → retry on same work item uses NEW uuid via newSession', async () => {
    const { root, client } = makeRoot();
    const fake = asFake(client);
    fake.launchQueue.push({
      details: detailsOf('wi-new'),
      launch: { ok: false, error: 'tool missing' },
      operation: { requestId: 'U1', status: 'completed' },
    });
    fake.launchQueue.push({
      details: detailsOf('wi-new'),
      launch: { ok: true, error: null },
      operation: { requestId: 'U2', status: 'completed' },
    });
    // Trigger via the launch helper directly to control prompts.
    root.state.setDraft({ text: 'go' });
    await (root as unknown as { launchFromEditor: (p: string) => Promise<void> }).launchFromEditor('go');
    assert.equal(fake.launchCalls.length, 1);
    assert.equal(fake.launchCalls[0]?.endpoint, 'quickStart');

    // After confirmed failure the draft requestId was cleared.
    assert.equal(root.state.draft.pendingLaunch?.requestId, undefined);
    assert.equal(root.state.draft.retryWorkId, 'wi-new');

    await (root as unknown as { launchFromEditor: (p: string) => Promise<void> }).launchFromEditor('go');
    assert.equal(fake.launchCalls.length, 2);
    assert.equal(fake.launchCalls[1]?.endpoint, 'newSession');
    assert.equal(fake.launchCalls[1]?.workItemId, 'wi-new');
    assert.notEqual(fake.launchCalls[0]?.requestId, fake.launchCalls[1]?.requestId);
    root.stop();
  });

  it('uncertain outcome replays the exact pending body across navigation', async () => {
    const { root, client } = makeRoot();
    const fake = asFake(client);
    fake.launchQueue.push(new ApiError(0, 'network'));
    fake.launchQueue.push({
      details: detailsOf('wi-ok'),
      launch: { ok: true, error: null },
      operation: { requestId: 'anything', status: 'completed' },
    });
    root.state.setDraft({ text: 'risky' });
    await (root as unknown as { launchFromEditor: (p: string) => Promise<void> }).launchFromEditor('risky');
    const firstId = fake.launchCalls[0]?.requestId;
    assert.ok(firstId, 'requestId sent on first attempt');
    assert.equal(fake.launchCalls[0]?.endpoint, 'quickStart');
    assert.equal(root.state.draft.uncertain, true);
    assert.ok(root.state.draft.pendingLaunch, 'pendingLaunch pinned');

    // Navigate away: pending draft should survive on its original key (home).
    root.state.navigateToWorkItem('wi-other');
    assert.equal(root.state.draft.text, '', 'different draft key');
    root.state.navigateToDashboard();

    // Retry: same endpoint + same id.
    await (root as unknown as { launchFromEditor: (p: string) => Promise<void> }).launchFromEditor('risky');
    assert.equal(fake.launchCalls.length, 2);
    assert.equal(fake.launchCalls[1]?.endpoint, 'quickStart', 'replays original endpoint');
    assert.equal(fake.launchCalls[1]?.requestId, firstId, 'replays original UUID');
    assert.equal(fake.launchCalls[1]?.prompt, 'risky');
    root.stop();
  });
});

describe('AppRoot sizing + resize', () => {
  function makeDashWith(n: number): DashboardResponse {
    const d = emptyDashboard();
    for (let i = 0; i < n; i++) {
      d.activeWorkItems.push({
        id: `wi-${i}`, title: `Active task ${i}`, state: 'active', notes: null,
        createdAt: '', updatedAt: '', startedAt: null, completedAt: null,
        sessionCount: 0, repositoryCount: 0, trackerIssueKeys: [], pullRequestRefs: [],
      });
    }
    return d;
  }

  function assertFits(lines: string[], cols: number, rows: number) {
    assert.ok(lines.length <= rows, `line count ${lines.length} > ${rows}`);
    for (const [i, line] of lines.entries()) {
      assert.ok(visibleWidth(line) <= cols, `line ${i} width ${visibleWidth(line)} > ${cols}: ${JSON.stringify(line)}`);
    }
  }

  it('renders within 50×12', () => {
    const tui = new FakeTui();
    tui.resize(50, 12);
    const { root } = makeRoot({ tui });
    root.state.applyDashboardResponse(makeDashWith(10));
    const out = root.render(50);
    assertFits(out, 50, 12);
    root.stop();
  });

  for (const [cols, rows] of [[35, 10], [36, 9]] as const) {
    it(`asks to resize below 36×10 (${cols}×${rows})`, () => {
      const tui = new FakeTui();
      tui.resize(cols, rows);
      const { root } = makeRoot({ tui });
      const out = root.render(cols);
      assert.match(stripTerminalSequences(out[0]!), /Terminal too small/);
      assertFits(out, cols, rows);
      root.stop();
    });
  }

  it('renders within 120×36 with sidebar + help bar visible', () => {
    const tui = new FakeTui();
    tui.resize(120, 36);
    const { root } = makeRoot({ tui });
    root.state.applyDashboardResponse(makeDashWith(10));
    root.state.navigateToWorkItem('wi-0');
    root.state.setWorkItemData({
      workItem: {
        id: 'wi-0', title: 'Big one', state: 'active', notes: 'Lots of notes '.repeat(60),
        createdAt: '', updatedAt: '', startedAt: null, completedAt: null,
      },
      metas: [],
    });
    const out = root.render(120);
    assertFits(out, 120, 36);
    const joined = out.join('\n');
    // Help bar key present.
    assert.match(joined, /quit/);
    // Sidebar entry visible.
    assert.match(joined, /ACTIVE WORK/);
    root.stop();
  });

  it('keeps the selected row visible when content exceeds viewport', () => {
    const tui = new FakeTui();
    tui.resize(80, 14);
    const { root } = makeRoot({ tui });
    const dash = makeDashWith(0);
    dash.recent.workItems = [];
    for (let i = 0; i < 50; i++) {
      dash.recent.workItems.push({
        id: `y-${i}`, title: `Recent ${i}`, state: 'done', notes: null,
        createdAt: '', updatedAt: '', startedAt: null, completedAt: null,
        sessionCount: 0, repositoryCount: 0, trackerIssueKeys: [], pullRequestRefs: [],
      });
    }
    root.state.applyDashboardResponse(dash);
    root.state.contentSelectedIndex = 45;
    const out = root.render(80).join('\n');
    assert.match(out, /Recent 45/, 'selected row remains visible');
    root.stop();
  });
});


async function waitFor(predicate: () => boolean): Promise<void> {
  for (let n = 0; n < 200; n++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Fixture condition did not settle');
}

async function httpFixture(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

function reply(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

describe('AppRoot real Editor submission over fixture HTTP', () => {
  for (const failure of ['400', 'completed', 'timeout'] as const) {
    it(`preserves exact typed and pasted whitespace/buffer after ${failure}, then retries deliberately`, async t => {
      const requests: Array<{ path: string; body: { prompt: string; requestId: string } }> = [];
      const url = await httpFixture(t, (req, res) => {
        if (req.method === 'GET') {
          reply(res, 200, req.url === '/dashboard' ? emptyDashboard() : req.url === '/tools' ? fixtureTools() : detailsOf('created'));
          return;
        }
        let data = '';
        req.on('data', chunk => { data += chunk; });
        req.on('end', () => {
          const body = JSON.parse(data) as { prompt: string; requestId: string };
          requests.push({ path: req.url!, body });
          if (requests.length === 1) {
            if (failure === '400') reply(res, 400, { error: 'Rejected' });
            else if (failure === 'timeout') { /* Deliberately withhold fixture reply. */ }
            else reply(res, 200, {
              details: detailsOf('created'), launch: { ok: false, error: 'Fixture launcher missing' },
              operation: { requestId: body.requestId, status: 'completed' },
            });
          } else reply(res, 200, {
            details: detailsOf('created'), launch: { ok: true, error: null },
            operation: { requestId: body.requestId, status: 'completed' },
          });
        });
      });
      class DeadlineClient extends LovelaceClient {
        override quickStart(...args: Parameters<LovelaceClient['quickStart']>) {
          args[5] = { ...args[5], timeoutMs: 35 };
          return super.quickStart(...args);
        }
      }
      const { root, tui } = makeRoot({ client: new DeadlineClient(url) });
      const done = root.start();
      t.after(async () => { root.quit(); await done; });
      await waitFor(() => !root.state.isLoading);
      tui.feedInput('n');
      tui.feedInput('\x1b[13;2u'); // Shift+Enter: leading blank line.
      tui.feedInput('  typed ');
      tui.feedInput('\x1b[200~pasted  \n\n  \x1b[201~');
      const prompt = '\n  typed pasted  \n\n  ';
      assert.equal(root.editor.getExpandedText(), prompt);
      tui.feedInput('\r');
      assert.equal(root.editor.getExpandedText(), prompt, 'no pre-submit clearing');
      await waitFor(() => requests.length === 1 && !root.state.mutationInFlight);
      assert.equal(requests[0]!.body.prompt, prompt);
      assert.equal(root.editor.getExpandedText(), prompt, 'failure retains exact buffer');
      assert.equal(root.state.draft.text, prompt);
      assert.equal(root.state.focus, 'editor');
      if (failure === 'timeout') {
        assert.equal(root.state.draft.uncertain, true);
        // Editing must not change an unresolved endpoint/body/UUID.
        tui.feedInput('changed');
        root.state.navigateToWorkItem('other');
        root.render(80);
        assert.equal(root.editor.getExpandedText(), '');
        root.state.navigateToDashboard();
        root.state.setFocus('editor');
        root.render(80);
      }
      tui.feedInput('\r');
      await waitFor(() => requests.length === 2 && !root.state.mutationInFlight);
      assert.equal(requests[1]!.body.prompt, prompt);
      assert.equal(requests[1]!.path, failure === 'completed'
        ? '/work-items/created/new-session' : '/work-items/quick-start');
      if (failure === 'timeout') assert.equal(requests[1]!.body.requestId, requests[0]!.body.requestId);
      else assert.notEqual(requests[1]!.body.requestId, requests[0]!.body.requestId);
      assert.equal(root.state.view, 'work-item');
      assert.equal(root.editor.getExpandedText(), '');
      root.state.navigateToDashboard();
      assert.equal(root.state.draft.text, '', 'successful source draft is cleared too');
    });
  }

  it('expands large paste markers but retains native compact rendering, split paste Enter and newline shortcuts', async t => {
    const { root, tui, client } = makeRoot();
    const done = root.start();
    t.after(async () => { root.quit(); await done; });
    await waitFor(() => !root.state.isLoading);
    tui.feedInput('n');
    tui.feedInput('\x1b[200~');
    tui.feedInput('\r'); // Standalone Enter chunk is part of paste, not submit.
    tui.feedInput('  ' + 'large line \n'.repeat(200) + '  ');
    tui.feedInput('\x1b[201~');
    const prompt = root.editor.getExpandedText();
    assert.ok(root.editor.getText().includes('[paste #'));
    assert.equal(asFake(client).launchCalls.length, 0);
    assert.ok(prompt.startsWith('\n  '));
    for (const [cols, rows] of [[50, 12], [80, 24], [120, 36]]) {
      tui.resize(cols!, rows!);
      const lines = root.render(cols!);
      assert.ok(lines.length <= rows!);
      assert.ok(lines.every(line => visibleWidth(line) <= cols!));
    }
    root.state.navigateToWorkItem('other');
    root.render(80);
    root.state.navigateToDashboard();
    root.state.setFocus('editor');
    root.render(80);
    assert.equal(root.editor.getExpandedText(), prompt);
    assert.ok(root.editor.getText().includes('[paste #'), 'restore stays compact');
    asFake(client).launchQueue.push(new ApiError(400, 'Rejected'));
    tui.feedInput('\r');
    await waitFor(() => asFake(client).launchCalls.length === 1 && !root.state.mutationInFlight);
    assert.equal(asFake(client).launchCalls[0]!.prompt, prompt);
    assert.equal(root.editor.getExpandedText(), prompt);

    root.editor.setText('');
    tui.feedInput('a');
    tui.feedInput('\\');
    tui.feedInput('\r'); // Backslash+Enter legacy newline.
    tui.feedInput('b');
    tui.feedInput('\n'); // Ctrl+J/newline is never submit.
    tui.feedInput('c');
    tui.feedInput('\x1b[13;2u');
    assert.equal(root.editor.getExpandedText(), 'a\nb\nc\n');
    tui.feedInput('burst\rtext');
    assert.equal(asFake(client).launchCalls.length, 1, 'input burst does not submit');
  });

  it('late mutation reply updates only its originating draft, not a newly selected task', async t => {
    let finish!: (value: QuickStartResponse) => void;
    const client = fakeClient();
    client.quickStart = () => new Promise(resolve => { finish = resolve; });
    const { root, tui } = makeRoot({ client });
    const done = root.start();
    t.after(async () => { root.quit(); await done; });
    tui.feedInput('n');
    tui.feedInput('original');
    tui.feedInput('\r');
    root.state.navigateToWorkItem('different');
    root.state.setDraft({ text: 'different draft' });
    root.render(80);
    finish({ details: detailsOf('created'), launch: { ok: false, error: 'failed' } });
    await waitFor(() => !root.state.mutationInFlight);
    assert.equal(root.state.selectedWorkItemId, 'different');
    assert.equal(root.state.draft.text, 'different draft');
    assert.equal(root.state.draft.retryWorkId, undefined);
    root.state.navigateToDashboard();
    assert.equal(root.state.draft.text, 'original');
    assert.equal(root.state.draft.retryWorkId, 'created');
  });
});

describe('AppRoot input/lifecycle integration', () => {
  it('starts details through real navigation input and restores focus after sidebar selection', async t => {
    const { root, tui, client } = makeRoot();
    const dash = emptyDashboard();
    dash.activeWorkItems = [{
      ...detailsOf('wi').workItem, sessionCount: 0, repositoryCount: 0,
      trackerIssueKeys: [], pullRequestRefs: [],
    }];
    asFake(client).dashboardResponse = dash;
    const done = root.start();
    t.after(async () => { root.quit(); await done; });
    await waitFor(() => !root.state.isLoading);
    tui.feedInput('\t');
    tui.feedInput('\x1b[B');
    tui.feedInput('\r');
    await waitFor(() => root.state.selectedWorkItemData?.workItem.id === 'wi');
    assert.equal(root.state.focus, 'content');
    assert.equal(root.editor.focused, false);
    assert.equal(tui.focusCalls.at(-1), null);
    root.state.setOffline();
    assert.equal(root.state.view, 'work-item');
    assert.match(root.render(80).join('\n'), /Item wi/);
  });


  it('kitty key releases do not repeat navigation', async t => {
    const { root, tui, client } = makeRoot();
    const dash = emptyDashboard();
    dash.activeWorkItems = ['a', 'b', 'c'].map(id => ({
      ...detailsOf(id).workItem, sessionCount: 0, repositoryCount: 0, trackerIssueKeys: [], pullRequestRefs: [],
    }));
    asFake(client).dashboardResponse = dash;
    const done = root.start();
    t.after(async () => { root.quit(); await done; });
    await waitFor(() => !root.state.isLoading);
    root.state.setFocus('sidebar');
    const before = root.state.sidebarSelectedIndex;
    tui.feedInput('\x1b[1;1:1B');
    tui.feedInput('\x1b[1;1:3B');
    assert.equal(root.state.sidebarSelectedIndex, before + 1);
  });

  it('cropped multiline editor keeps its cursor visible when moving upwards', async t => {
    const { root, tui } = makeRoot();
    const done = root.start();
    t.after(async () => { root.quit(); await done; });
    tui.resize(50, 12);
    tui.feedInput('n');
    for (let n = 0; n < 9; n++) { tui.feedInput('line ' + n); tui.feedInput('\n'); }
    for (let n = 0; n < 9; n++) tui.feedInput('\x1b[A');
    const lines = root.render(50);
    assert.ok(lines.some(line => line.includes('\x1b_pi:c\x07')), 'hardware cursor survives crop');
    assert.ok(lines.length <= 12);
    assert.ok(lines.every(line => visibleWidth(line) <= 50));
    tui.feedInput('\x1b');
    assert.equal(root.editor.focused, false);
    assert.ok(!root.render(50).some(line => line.includes('\x1b_pi:c\x07')));
  });

  it('Esc cancels confirmation before navigating; movement clears it', async t => {
    const { root, tui, client } = makeRoot();
    const done = root.start();
    t.after(async () => { root.quit(); await done; });
    root.state.navigateToWorkItem('wi');
    root.state.pendingConfirm = { kind: 'state', state: 'done' };
    tui.feedInput('\x1b');
    assert.equal(root.state.view, 'work-item');
    assert.equal(root.state.pendingConfirm, null);
    root.state.pendingConfirm = { kind: 'state', state: 'done' };
    tui.feedInput('\x1b[B');
    tui.feedInput('y');
    assert.equal(root.state.pendingConfirm, null);
    assert.equal(asFake(client).openCalls.length, 0);
  });


  it('discarding a stuck launch needs explicit x/y and cannot implicitly replay or clear it', async t => {
    const { root, tui, client } = makeRoot();
    const done = root.start();
    t.after(async () => { root.quit(); await done; });
    root.state.setDraft({
      text: 'original', uncertain: true,
      pendingLaunch: { endpoint: 'quickStart', prompt: 'original', requestId: 'id' },
    });
    tui.feedInput('x');
    assert.equal(root.state.pendingConfirm?.kind, 'launch-abandon');
    assert.equal(root.state.draft.pendingLaunch?.requestId, 'id');
    tui.feedInput('\x1b');
    assert.equal(root.state.pendingConfirm, null);
    assert.equal(root.state.draft.pendingLaunch?.requestId, 'id');
    tui.feedInput('x');
    tui.feedInput('y');
    assert.equal(root.state.draft.pendingLaunch, undefined);
    assert.equal(root.editor.getExpandedText(), '');
    assert.equal(root.state.focus, 'editor');
    assert.equal(asFake(client).launchCalls.length, 0);
  });

  it('sidebar selection remains visible beyond the viewport and stale/offline footer fits', () => {
    const { root, tui } = makeRoot();
    const dash = emptyDashboard();
    dash.activeWorkItems = Array.from({ length: 60 }, (_, n) => ({
      ...detailsOf('wi-' + n).workItem, title: 'Selected task ' + n, sessionCount: 0,
      repositoryCount: 0, trackerIssueKeys: [], pullRequestRefs: [],
    }));
    dash.freshness.jiraStale = true;
    dash.freshness.githubStale = true;
    root.state.applyDashboardResponse(dash);
    root.state.focus = 'sidebar';
    root.state.sidebarSelectedIndex = 51;
    tui.resize(90, 12);
    const lines = root.render(90);
    assert.match(lines.join('\n'), /Selected task 50/);
    assert.ok(lines.every(line => visibleWidth(line) <= 90));
    root.state.setOffline();
    assert.ok(root.render(90).every(line => visibleWidth(line) <= 90));
    // Phone-sized terminals hide the sidebar, so focus returns to the content.
    tui.resize(50, 12);
    assert.ok(root.render(50).every(line => visibleWidth(line) <= 50));
    assert.equal(root.state.focus, 'content');
    root.stop();
  });
});

describe('AppRoot detailsPoller runs from start', () => {
  it('fetches work item details when selected and refresh is triggered', async () => {
    const { root, client } = makeRoot();
    const fake = asFake(client);
    fake.workItemByIdResponse['wi-7'] = detailsOf('wi-7', 'active');
    root.state.selectedWorkItemId = 'wi-7';
    root.state.view = 'work-item';
    // Simulate a fresh poller start without the full start() (no need for input listeners).
    (root as unknown as { detailsPoller: { start: () => void; refresh: () => void } }).detailsPoller.start();
    // Drive refresh directly.
    (root as unknown as { triggerDetailsRefresh: () => void }).triggerDetailsRefresh();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(root.state.selectedWorkItemData?.workItem.id, 'wi-7');
    root.stop();
  });
});


describe('Home-only quick-start dock', () => {
  it('shows active work without a prompt and never focuses a hidden editor', async t => {
    const { root, tui } = makeRoot();
    const done = root.start();
    t.after(async () => { root.quit(); await done; });
    await waitFor(() => !root.state.isLoading);
    root.state.navigateToWorkItem('wi');
    root.state.setWorkItemData(detailsOf('wi'));
    root.state.setDraft({ text: 'hidden session draft' });
    const output = root.render(120).join('\n');
    assert.doesNotMatch(output, /Quick start|Session prompt|hidden session draft|New session|Edit a prompt/);
    assert.match(output, /Agent sessions/);
    tui.feedInput('n');
    assert.equal(root.state.focus, 'content');
    assert.equal(root.editor.focused, false);
    for (let i = 0; i < 10; i++) {
      tui.feedInput('\t');
      assert.notEqual(root.state.focus, 'editor');
    }
    root.state.setFocus('editor');
    assert.equal(root.state.focus, 'content');
    root.state.navigateToDashboard();
    tui.feedInput('n');
    assert.equal(root.state.focus, 'editor');
    assert.match(root.render(120).join('\n'), /Quick start/);
  });

  for (const [cols, rows] of [[50, 12], [80, 24], [120, 36]]) {
    it('keeps three input lines pinned at the bottom on Home at ' + cols + 'x' + rows, () => {
      const { root, tui } = makeRoot();
      tui.resize(cols!, rows!);
      root.state.applyDashboardResponse(emptyDashboard());
      for (const text of ['', 'one\ntwo\nthree\nfour\nfive\nsix']) {
        root.state.setDraft({ text });
        const lines = root.render(cols!);
        assert.equal(lines.length, rows);
        const titleRow = lines.findIndex(line => line.includes('Quick start'));
        if (rows! < 18) assert.equal(titleRow, rows! - 2, 'short terminals collapse the unfocused dock to one row');
        else assert.equal(titleRow, rows! - 8, 'title, two borders, three input rows and the launch fields above the footer');
        assert.ok(lines.slice(titleRow + 1, titleRow + 7).every(line => visibleWidth(line) <= cols!));
        if (rows! >= 18) assert.match(stripTerminalSequences(lines[rows! - 2]!), cols! >= 100 ? /Agent +Pi ▾ +Thinking +default ▾ +Model +default ▾/ : /Pi ▾ +Thinking ▾ +Model ▾/);
      }
      root.state.setFocus('editor');
      const focused = root.render(cols!);
      assert.equal(focused.findIndex(line => line.includes('Quick start')), rows! - 8, 'a focused dock always shows three input rows');
      root.stop();
    });
  }

  it('shows no quick-start/input on Jira and skips hidden editor focus', () => {
    const { root } = makeRoot();
    const issue = { id: '42', key: 'PROJ-42', title: 'Task', url: '', status: null, issueType: null, updatedAt: '' };
    root.state.applyDashboardResponse({ ...emptyDashboard(), pendingJiraIssues: [issue] });
    root.state.navigate({ kind: 'jira', id: issue.id });
    root.state.setDraft({ text: 'retained Jira draft' });
    const output = root.render(120).join('\n');
    assert.doesNotMatch(output, /Quick start|Session prompt|retained Jira draft|Edit prompt/);
    assert.match(output, /Start work/);
    root.state.toggleFocus();
    assert.equal(root.state.focus, 'sidebar');
    root.state.toggleFocus();
    assert.equal(root.state.focus, 'content');
    root.state.setFocus('editor');
    assert.equal(root.state.focus, 'content');
    assert.equal(root.editor.focused, false);
    root.state.navigateToWorkItem('wi');
    assert.doesNotMatch(root.render(120).join('\n'), /Quick start/);
    assert.doesNotMatch(root.render(120).join('\n'), /Session prompt/);
    root.stop();
  });
});

describe('Cold rendering and drafts', () => {
  for (const [cols, rows] of [[50, 12], [80, 24], [120, 36]]) {
    it('keeps cold loading/offline navigation, honest footer and padded bounds at ' + cols + 'x' + rows, () => {
      const { root, tui } = makeRoot();
      tui.resize(cols!, rows!);
      for (const offline of [false, true]) {
        if (offline) root.state.setOffline();
        const lines = root.render(cols!);
        const output = lines.join('\n');
        assert.match(output, /Home/);
        assert.match(output, /Active work/i);
        assert.match(output, /Pending Jira/i);
        if (cols! >= 80) assert.match(output, /http:\/\/127\.0\.0\.1:4747/);
        assert.match(output, offline ? /unavailable/i : /Loading/);
        assert.doesNotMatch(output, /cached data|last-known data|No pending issues/);
        assert.ok(lines.length <= rows!);
        assert.ok(lines.every(line => visibleWidth(line) <= cols!));
      }
      root.stop();
    });
  }

  it('pasted Unicode and boundary whitespace round-trip across drafts at narrow size', async t => {
    const { root, tui } = makeRoot(); const done = root.start();
    t.after(async () => { root.quit(); await done; });
    tui.resize(50, 12); root.state.setFocus('editor');
    const prompt = '\n  👩🏽‍💻 é 漢字 λ\n\n  ';
    tui.feedInput('\x1b[200~' + prompt + '\x1b[201~');
    assert.equal(root.editor.getExpandedText(), prompt);
    root.state.navigateToWorkItem('other'); root.render(50);
    root.state.navigateToDashboard(); root.state.setFocus('editor');
    const lines = root.render(50);
    assert.equal(root.editor.getExpandedText(), prompt);
    assert.ok(lines.every(line => visibleWidth(line) <= 50));
  });
});


describe('Centred confirmation dialog', () => {
  for (const [cols, rows] of [[50, 12], [80, 24], [120, 32]]) {
    it('overlays the middle of the frame at ' + cols + 'x' + rows, () => {
      const { root, tui } = makeRoot();
      tui.resize(cols!, rows!);
      root.state.pendingConfirm = { kind: 'launch-abandon', draftKey: 'home' };
      const lines = root.render(cols!);
      const plain = lines.map(line => stripTerminalSequences(line));
      const row = plain.findIndex(line => line.includes('Discard the unresolved'));
      assert.ok(row > 1 && row < rows! - 2, 'question sits away from the header and footer');
      const top = plain.findIndex(line => line.includes('╭'));
      const bottom = plain.findIndex(line => line.includes('╰'));
      assert.ok(Math.abs(top - (rows! - 1 - bottom)) <= 1, 'vertically centred');
      assert.ok(plain.some(line => /y confirm {3}Esc cancel/.test(line)));
      assert.equal(lines.length, rows!);
      assert.ok(lines.every(line => visibleWidth(line) === cols!));
      root.stop();
    });
  }

  it('is modal: other keys neither act nor dismiss it', () => {
    const { root, tui } = makeRoot();
    void root.start();
    root.state.pendingConfirm = { kind: 'launch-abandon', draftKey: 'home' };
    for (const key of ['q', 'j', '\x1b[B', '\r', '\t']) tui.feedInput(key);
    assert.equal(root.state.pendingConfirm?.kind, 'launch-abandon');
    assert.equal(tui.state.stopped, 0);
    tui.feedInput('n');
    assert.equal(root.state.pendingConfirm, null);
    root.stop();
  });
});

describe('AppRoot mouse', () => {
  const event = (type: TuiMouseEvent['type'], x: number, y: number, extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent => ({
    type, button: type === 'wheel' ? 'none' : 'left', x, y, screenX: x, screenY: y,
    width: 120, height: 36, shift: false, alt: false, ctrl: false, ...extra,
  });
  /** Click the link pi-tui would find under the first match of `text`, as its fullscreen viewport does. */
  const clickText = (root: AppRoot, text: string, nth = 0) => {
    const frame = root.render(120);
    const hits = frame.flatMap((line, y) => {
      const plain = stripTerminalSequences(line);
      const x = plain.indexOf(text);
      return x < 0 ? [] : [getOsc8LinkAtColumn(line, x)];
    });
    const url = hits[nth];
    assert.ok(url, `no link under ${text}`);
    root.openLink(url);
  };
  function mouseRoot() {
    const tui = new FakeTui();
    tui.resize(120, 36);
    const opened: string[] = [];
    const client = fakeClient();
    const root = new AppRoot({ tui: tui as unknown as TuiAltScreen, client, openUrl: async url => { opened.push(url); } });
    const dash = emptyDashboard();
    dash.activeWorkItems = ['a', 'b'].map(id => ({
      ...detailsOf(id).workItem, sessionCount: 0, repositoryCount: 0, trackerIssueKeys: [], pullRequestRefs: [],
    }));
    dash.recent.workItems = [{ ...detailsOf('y').workItem, title: 'Recent item', sessionCount: 0, repositoryCount: 0, trackerIssueKeys: [], pullRequestRefs: [] }];
    root.state.applyDashboardResponse(dash);
    return { root, tui, client, opened };
  }

  it('clicking sidebar and content rows navigates like Enter', async () => {
    const { root, client } = mouseRoot();
    asFake(client).workItemByIdResponse.b = detailsOf('b');
    clickText(root, 'Item b');
    assert.equal(root.state.view, 'work-item');
    assert.equal(root.state.selectedWorkItemId, 'b');
    clickText(root, 'Home');
    assert.equal(root.state.view, 'dashboard');
    clickText(root, 'Recent item');
    await waitFor(() => root.state.selectedWorkItemId === 'y');
    root.stop();
  });

  it('opens provider cards in the browser and replays clicked help chips', () => {
    const { root, opened } = mouseRoot();
    const details = detailsOf('a');
    details.metas.push({
      id: 'pr', workItemId: 'a', metaType: 'pull-request', provider: 'github', externalId: '7',
      payloadJson: JSON.stringify({ number: 7, url: 'https://github.invalid/org/repo/pull/7', status: 'open' }), createdAt: '', updatedAt: '',
    });
    root.state.navigateToWorkItem('a');
    root.state.setWorkItemData(details);
    clickText(root, '#7');
    assert.deepEqual(opened, ['https://github.invalid/org/repo/pull/7']);
    clickText(root, 'Esc back');
    assert.equal(root.state.view, 'dashboard');
    clickText(root, 'n new');
    assert.equal(root.state.focus, 'editor');
    root.stop();
  });

  it('drags the divider to resize the sidebar and double-click restores it', () => {
    const { root } = mouseRoot();
    const divider = () => stripTerminalSequences(root.render(120)[5]!).lastIndexOf('│');
    const start = divider();
    assert.equal(start, 120 - 34 - 1);
    assert.equal(root.handleMouse(event('press', start, 5))?.capture, true);
    root.handleMouse(event('drag', 60, 5));
    root.handleMouse(event('release', 60, 5));
    assert.equal(divider(), 60);
    root.handleMouse(event('drag', 2, 5)); // Not captured any more.
    assert.equal(divider(), 60);
    root.handleMouse(event('press', 60, 5));
    root.handleMouse(event('drag', 110, 5));
    root.handleMouse(event('release', 110, 5));
    assert.equal(divider(), 120 - 12 - 1, 'clamped to the minimum sidebar width');
    root.handleMouse(event('press', divider(), 5));
    root.handleMouse(event('click', divider(), 5, { clickCount: 2 }));
    assert.equal(divider(), start);
    root.stop();
  });

  it('wheel moves the selection of the pane under the pointer; plain clicks focus the dock', () => {
    const { root } = mouseRoot();
    root.render(120);
    root.handleMouse(event('wheel', 110, 4, { wheelDelta: 3 }));
    assert.equal(root.state.focus, 'sidebar');
    assert.equal(root.state.sidebarSelectedIndex, 1);
    root.handleMouse(event('wheel', 10, 4, { wheelDelta: -1 }));
    assert.equal(root.state.focus, 'content');
    root.handleMouse(event('click', 10, 33));
    assert.equal(root.state.focus, 'editor');
    root.handleMouse(event('click', 10, 4));
    assert.equal(root.state.focus, 'content');
    assert.equal(root.handleMouse(event('press', 10, 4)), undefined, 'presses keep native text selection');
    root.stop();
  });
});

describe('AppRoot mouse confirmations', () => {
  it('clicked actions respect a pending confirmation, whose y/Esc are clickable', () => {
    const tui = new FakeTui();
    tui.resize(120, 36);
    const { root } = makeRoot({ tui });
    root.state.navigateToWorkItem('a');
    root.state.setWorkItemData(detailsOf('a'));
    root.state.pendingConfirm = { kind: 'state', state: 'cancelled' };
    const frame = root.render(120);
    const links = (text: string) => frame.flatMap(line => {
      const x = stripTerminalSequences(line).indexOf(text);
      return x < 0 ? [] : [getOsc8LinkAtColumn(line, x)!];
    });
    root.openLink(links('Mark done')[0]!);
    assert.equal(root.state.pendingConfirm?.kind, 'state', 'action click ignored while confirming');
    assert.ok(links('y confirm')[0]);
    root.openLink(links('Esc cancel')[0]!);
    assert.equal(root.state.pendingConfirm, null);
    root.stop();
  });
});
