import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getOsc8LinkAtColumn, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import type { Component, TuiAltScreen, TuiMouseEvent } from '@earendil-works/pi-tui';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { TestContext } from 'node:test';
import { createLovelaceClient, type LovelaceClient } from '@lovelace/client';
import { fakeClient, serverError, type FakeHandlers } from '@lovelace/client/testing';
import {
  CODING_HARNESSES, type AgentSession, type AvailableHarness, type DashboardResponse, type TrackedChangeRequest, type LaunchResponse, type SessionOpenResponse,
  type LaunchState, type WorkItemDetails, type WorkItemState, type Worktree,
} from '@lovelace/core';
import { AppRoot } from './app.js';
import { LaunchDialog } from './launch-dialog.js';
import { handleAction, type ControllerDeps } from './controller.js';
import { openWork } from './test-support.js';

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

// -- FakeServer -----------------------------------------------------------

interface OpenCall { workItemId: string; sessionId: string }
interface LaunchCall { endpoint: 'quickStart' | 'newSession'; workItemId?: string; trackerIssueId?: string | null; reviewRequestId?: string | null; prompt: string; requestId?: string; repoIds?: string[]; promptId?: string }

/** Server state behind a typed fake client; tests may replace `handlers` entries before the call. */
class FakeServer {
  dashboardResponse: DashboardResponse = emptyDashboard();
  workItemByIdResponse: Record<string, WorkItemDetails> = {};
  readonly openCalls: OpenCall[] = [];
  readonly launchCalls: LaunchCall[] = [];
  openQueue: Array<SessionOpenResponse | Error> = [];
  launchQueue: Array<LaunchResponse | Error> = [];

  readonly handlers: FakeHandlers = {
    'dashboard.get': async () => this.dashboardResponse,
    'workItems.get': async ({ id }) => this.workItemByIdResponse[id] ?? detailsOf(id),
    'tracker.issues': async () => [],
    'tools.list': async () => fixtureTools(),
    'prompts.list': async () => [],
    'repositories.list': async () => [],
    'sessions.open': async ({ workItemId, sessionId }) => {
      this.openCalls.push({ workItemId, sessionId });
      const next = this.openQueue.shift();
      if (!next) throw new Error('No queued open response');
      if (next instanceof Error) throw next;
      return next;
    },
    'workItems.setState': async ({ id, state }) => detailsOf(id, state).workItem,
    'launches.get': async () => { throw serverError(404, 'launch not found'); },
    'launches.quickStart': async ({ prompt, trackerIssueId, requestId, reviewRequestId, repoIds, promptId }) => {
      this.launchCalls.push({ endpoint: 'quickStart', trackerIssueId, prompt, requestId, ...(reviewRequestId ? { reviewRequestId } : {}), ...(repoIds ? { repoIds } : {}), ...(promptId ? { promptId } : {}) });
      return this.nextLaunch();
    },
    'launches.newSession': async ({ workItemId, prompt, requestId, repoIds }) => {
      this.launchCalls.push({ endpoint: 'newSession', workItemId, prompt, requestId, ...(repoIds?.length ? { repoIds } : {}) });
      return this.nextLaunch();
    },
  };
  /** Looks handlers up on every call, so replacing one takes effect immediately. */
  readonly client: LovelaceClient = fakeClient(this.handlers);

  private nextLaunch(): LaunchResponse {
    const next = this.launchQueue.shift();
    if (!next) throw new Error('No queued launch response');
    if (next instanceof Error) throw next;
    return next;
  }
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
    pendingIssues: [], pendingReviews: [],
    recent: { since: '', workItems: [], sessionCount: 0, completedCount: 0, activityCount: 0 },
    settings: { defaultAgent: 'pi', repositoryTopics: [] },
    freshness: { trackerFetchedAt: null, codeHostFetchedAt: null, trackerStale: false, codeHostStale: false },
  };
}

function detailsOf(id: string, state: WorkItemState = 'active'): WorkItemDetails {
  return {
    workItem: {
      id, title: `Item ${id}`, state, notes: null,
      createdAt: '', updatedAt: '', startedAt: null, completedAt: null,
    },
    attachments: [],
    launches: [],
  };
}

function launched(id: string, state: LaunchState = 'accepted', error: string | null = null): LaunchResponse {
  const launch = { id: 'launch', workItemId: id, state, error, harness: 'pi', repoIds: [], promptId: null, prompt: '', createdAt: '', updatedAt: '' };
  return { details: { ...detailsOf(id), launches: [launch] }, launch };
}

function makeRoot(opts: { tui?: FakeTui; server?: FakeServer; client?: LovelaceClient } = {}) {
  const tui = opts.tui ?? new FakeTui();
  const server = opts.server ?? new FakeServer();
  const root = new AppRoot({ tui: tui as unknown as TuiAltScreen, client: opts.client ?? server.client, serverUrl: 'http://127.0.0.1:4747' });
  return { root, tui, server };
}

function withSession(id: string, state: WorkItemState = 'active'): WorkItemDetails {
  const details = detailsOf(id, state);
  details.attachments.push({
    id: 'm', workItemId: id, type: 'session',
    payload: { title: 'Pi', toolId: 'pi', status: 'ended', agentState: 'ended' } as AgentSession, createdAt: '', updatedAt: '',
  });
  return details;
}

const openSession = (root: AppRoot, sessionId = 'm') =>
  handleAction(root.state, { kind: 'session', sessionId }, (root as unknown as { makeDeps: () => ControllerDeps }).makeDeps());

// -- Tests ----------------------------------------------------------------

describe('AppRoot review list', () => {
  it('lists reviews in the sidebar and starts one from the dialog with the review template and its repository fixed', async (t) => {
    const { root, tui, server } = makeRoot();
    const rendered: unknown[] = [];
    server.handlers['prompts.list'] = async () => ['default', 'review'].map(id => ({ id, title: id, content: '', builtIn: true, overridden: false }));
    server.handlers['repositories.list'] = async () => ['a', 'b'].map(name => ({
      id: `github:${name}`, provider: 'github', externalId: name, name, fullName: `org/${name}`,
      cloneUrl: '', defaultBranch: 'main', isArchived: false, topics: [], lastSyncedAt: '',
    }));
    server.handlers['prompts.render'] = async input => { rendered.push(input); return { promptId: 'review', content: 'Review org/a#7\n' }; };
    const review = {
      id: 'PR_1', number: 7, title: 'Retry uploads', url: '', repository: 'org/a', repoId: 'github:a',
      author: 'human', sourceBranch: 'feature/retry', targetBranch: 'main', updatedAt: '',
    };
    server.dashboardResponse.pendingReviews = [review];
    const done = root.start();
    t.after(async () => { root.quit(); await done; });
    root.state.applyDashboardResponse(server.dashboardResponse);
    assert.match(stripTerminalSequences(root.render(120).join('\n')), /REVIEWS  1[\s\S]*a#7 Retry uploads/);
    assert.match(stripTerminalSequences(root.render(120).join('\n')), /Reviews  1[\s\S]*Retry uploads/, 'Home lists reviews too');
    root.state.navigate({ kind: 'review', id: review.id });
    assert.match(stripTerminalSequences(root.render(120).join('\n')), /Start review/);
    tui.feedInput('\r');
    const dialog = tui.overlays[0]!.component as LaunchDialog;
    await waitFor(() => !dialog.loading && !dialog.renderingPrompt);
    assert.deepEqual(rendered, [{ promptId: 'review', title: 'org/a#7: Retry uploads',
      sources: [{ sourceType: 'change-request', provider: 'github', externalId: 'PR_1', payload: review }] }]);
    assert.match(stripTerminalSequences(dialog.render(118).join('\n')), /Start review[\s\S]*\[x\] a[\s\S]*\[ \] b/);
    dialog.toggleRepository('github:a');
    assert.match(dialog.error!, /stays selected/);
    dialog.unselectAll();
    dialog.toggleRepository('github:b');
    assert.deepEqual(root.state.draft.repoIds, ['github:a', 'github:b']);
    server.launchQueue.push(launched('created'));
    tui.feedInput('\x13');
    await waitFor(() => server.launchCalls.length === 1 && !root.state.mutationInFlight);
    const launch = server.launchCalls[0]!;
    assert.equal(launch.reviewRequestId, 'PR_1');
    assert.deepEqual(launch.repoIds, ['github:a', 'github:b']);
    assert.equal(launch.promptId, 'review');
    assert.equal(launch.prompt, 'Review org/a#7\n');
    assert.equal(root.state.route.kind, 'work');
  });
});

describe('AppRoot Jira start-work overlay', () => {
  it('keeps Jira details underneath one modal with repositories and an editable prompt together', async (t) => {
    const { root, tui, server } = makeRoot();
    server.handlers['prompts.list'] = async () => [{ id: 'refine', title: 'Refine', content: '', builtIn: true, overridden: true }];
    server.handlers['repositories.list'] = async () => ['sync', 'client'].map((name, index) => ({
      id: String(index), provider: 'github', externalId: String(index), name, fullName: `org/${name}`,
      cloneUrl: '', defaultBranch: 'main', isArchived: false, topics: [index ? 'examplecom' : 'infra'], lastSyncedAt: '',
    }));
    server.handlers['prompts.render'] = async () => ({ promptId: 'refine', content: '  Rendered prompt\n' });
    const issue = { id: '42', key: 'PROJ-42', title: 'Fix sync', url: '', status: 'To Do', issueType: 'Task', updatedAt: '' };
    server.dashboardResponse.pendingIssues = [issue];
    server.dashboardResponse.settings.repositoryTopics = ['infra', 'examplecom'];
    const done = root.start();
    t.after(async () => { root.quit(); await done; });
    root.state.applyDashboardResponse(server.dashboardResponse);
    root.state.navigate({ kind: 'jira', id: issue.id });
    tui.feedInput('\r');
    const overlay = tui.overlays[0]!;
    const modal = overlay.component as LaunchDialog;
    await waitFor(() => !modal.loading);
    assert.equal(root.state.route.kind, 'jira');
    assert.equal(modal.topicFilter.getValue(), 'infra, examplecom');
    assert.match(root.render(80).join('\n'), /Description/);
    assert.equal(tui.overlays.length, 1);
    assert.deepEqual(overlay.options, { width: '96%', maxHeight: '96%', margin: 1, anchor: 'center' });
    const screen = stripTerminalSequences(modal.render(76).join('\n'));
    assert.match(screen, /\[ \] sync/);
    assert.match(screen, /Refine/);
    assert.match(screen, /Rendered prompt/);
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
      // Every row, separators included, reaches the right border.
      assert.ok(lines.every(line => visibleWidth(stripTerminalSequences(line).trimEnd()) === cols! - 2));
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
    server.launchQueue.push(serverError(400, 'fixture preparation failure'));
    tui.feedInput('\x13');
    await waitFor(() => !root.state.mutationInFlight);
    const launch = server.launchCalls[0]!;
    assert.equal(launch.trackerIssueId, '42');
    assert.deepEqual(launch.repoIds, ['0', '1']);
    assert.equal(launch.promptId, 'refine');
    assert.equal(launch.prompt, prompt);
    assert.equal(root.state.draft.requestId, undefined);
    assert.equal(overlay.visible, true, 'a rejection stays in the same dialog');
    assert.match(modal.render(100).join('\n'), /fixture preparation failure/);
    tui.feedInput('\x1b');
    assert.equal(overlay.visible, false);
    assert.equal(root.state.route.kind, 'jira', 'Escape closes the overlay, not the underlying page');
    assert.equal(root.state.draft.text, prompt);
  });

  it('isolates filter command letters, retains drafts on cancel and refuses unresolved launch changes', async (t) => {
    const { root, tui, server } = makeRoot();
    server.handlers['prompts.list'] = async () => [];
    server.handlers['repositories.list'] = async () => [];
    const issue = { id: '42', key: 'PROJ-42', title: 'Task', url: '', status: null, issueType: null, updatedAt: '' };
    server.dashboardResponse.pendingIssues = [issue];
    const done = root.start();
    t.after(async () => { root.quit(); await done; });
    root.state.applyDashboardResponse(server.dashboardResponse);
    root.state.navigate({ kind: 'jira', id: issue.id });
    root.state.setDraft({ text: 'Keep prompt', repoIds: ['1'] });
    tui.feedInput('n'); // Jira opens the modal, never a hidden quick-start editor.
    const modal = tui.overlays[0]!.component as LaunchDialog;
    await waitFor(() => !modal.loading);
    tui.feedInput('/');
    tui.feedInput('qrnd');
    assert.equal(modal.nameFilter.getValue(), 'qrnd');
    assert.equal(tui.state.stopped, 0);
    tui.feedInput('\x1b');
    assert.equal(tui.overlays[0]!.visible, false);
    assert.equal(root.state.route.kind, 'jira');
    assert.equal(root.state.draft.text, 'Keep prompt');
    assert.deepEqual(root.state.draft.repoIds, ['1']);
    root.state.setDraft({ requestId: 'id' });
    assert.match(root.render(80).join('\n'), /Resend unanswered launch/);
    server.launchQueue.push(serverError(503, 'Fixture retry failed'));
    tui.feedInput('\r');
    await waitFor(() => server.launchCalls.length === 1 && !root.state.mutationInFlight);
    assert.equal(tui.overlays.length, 1, 'cannot change an unanswered launch');
    assert.equal(server.launchCalls[0]!.prompt, 'Keep prompt');
    assert.equal(server.launchCalls[0]!.requestId, 'id');
    assert.deepEqual(server.launchCalls[0]!.repoIds, ['1']);
    assert.match(root.state.error!, /Fixture retry failed/);
  });

  it('a successful start closes the overlay and navigates to the saved work without opening a session', async (t) => {
    const { root, tui, server } = makeRoot();
    server.handlers['prompts.list'] = async () => [];
    server.handlers['repositories.list'] = async () => [];
    const issue = { id: '42', key: 'PROJ-42', title: 'Task', url: '', status: null, issueType: null, updatedAt: '' };
    server.dashboardResponse.pendingIssues = [issue];
    const done = root.start();
    t.after(async () => { root.quit(); await done; });
    root.state.applyDashboardResponse(server.dashboardResponse);
    root.state.navigate({ kind: 'jira', id: issue.id });
    root.state.setDraft({ text: 'Start this task' });
    tui.feedInput('\r');
    const modal = tui.overlays[0]!.component as LaunchDialog;
    await waitFor(() => !modal.loading);
    server.launchQueue.push(launched('created'));
    tui.feedInput('\x13');
    await waitFor(() => !tui.overlays[0]!.visible);
    assert.equal(root.state.route.kind, 'work');
    assert.equal(openWork(root.state).id, 'created');
    assert.equal(server.openCalls.length, 0);
  });
});

describe('AppRoot new-session overlay', () => {
  it('starts another session on the selected work item from n or its row', async (t) => {
    const { root, tui, server } = makeRoot();
    const done = root.start();
    t.after(async () => { root.quit(); await done; });
    root.state.navigateToWorkItem('w1');
    root.state.setWorkItemData(withSession('w1'));
    assert.match(stripTerminalSequences(root.render(80).join('\n')), /New session/);
    tui.feedInput('n');
    const overlay = tui.overlays[0]!;
    const modal = overlay.component as LaunchDialog;
    assert.equal(modal.focus, 'prompt');
    await waitFor(() => !modal.loading);
    for (const [cols, rows] of [[50, 12], [80, 24], [120, 36]]) {
      tui.resize(cols!, rows!);
      const lines = modal.render(cols! - 2);
      assert.ok(lines.length <= rows! - 2);
      assert.ok(lines.every(line => visibleWidth(line) <= cols! - 2));
      // Every row, separators included, reaches the right border.
      assert.ok(lines.every(line => visibleWidth(stripTerminalSequences(line).trimEnd()) === cols! - 2));
    }
    tui.feedInput('Second pass');
    server.launchQueue.push(serverError(404, 'Work item not found.'));
    tui.feedInput('\x13');
    await waitFor(() => !root.state.mutationInFlight && !modal.launching);
    assert.equal(overlay.visible, true, 'a rejection stays in the dialog');
    assert.match(stripTerminalSequences(modal.render(76).join('\n')), /Work item not found/);
    server.launchQueue.push({ ...launched('w1'), details: withSession('w1') });
    tui.feedInput('\x13');
    await waitFor(() => !overlay.visible);
    assert.deepEqual(server.launchCalls.map(call => [call.endpoint, call.workItemId, call.prompt]),
      [['newSession', 'w1', 'Second pass'], ['newSession', 'w1', 'Second pass']]);
    assert.equal(root.state.route.kind, 'work');
    assert.equal(root.state.draft.text, '');
    assert.equal(server.openCalls.length, 0);
  });

  it('keeps attached repositories selected and sends only added ones', async (t) => {
    const { root, tui, server } = makeRoot();
    server.handlers['repositories.list'] = async () => ['a', 'b'].map(name => ({
      id: `github:${name}`, provider: 'github', externalId: name, name, fullName: `org/${name}`,
      cloneUrl: '', defaultBranch: 'main', isArchived: false, topics: [], lastSyncedAt: '',
    }));
    const done = root.start();
    t.after(async () => { root.quit(); await done; });
    const details = withSession('w1');
    details.attachments.push({
      id: 'wt', workItemId: 'w1', type: 'worktree', createdAt: '', updatedAt: '',
      payload: { repoId: 'github:a', repoName: 'a', status: 'ready' } as Worktree,
    });
    root.state.navigateToWorkItem('w1');
    root.state.setWorkItemData(details);
    tui.feedInput('n');
    const dialog = tui.overlays[0]!.component as LaunchDialog;
    await waitFor(() => !dialog.loading);
    assert.match(stripTerminalSequences(dialog.render(118).join('\n')), /\[x\] a[\s\S]*\[ \] b[\s\S]*1 repositories/);
    dialog.toggleRepository('github:a');
    assert.match(dialog.error!, /stay selected/);
    dialog.selectAll();
    assert.deepEqual(root.state.draft.repoIds, ['github:b']);
    tui.feedInput('More');
    server.launchQueue.push({ ...launched('w1'), details });
    tui.feedInput('\x13');
    await waitFor(() => server.launchCalls.length === 1 && !root.state.mutationInFlight);
    assert.deepEqual(server.launchCalls[0]!.repoIds, ['github:b']);
  });

  it('refuses inactive work and keeps Escape inside the dialog', async (t) => {
    const { root, tui } = makeRoot();
    const done = root.start();
    t.after(async () => { root.quit(); await done; });
    root.state.navigateToWorkItem('w1');
    root.state.setWorkItemData(withSession('w1', 'done'));
    assert.doesNotMatch(stripTerminalSequences(root.render(80).join('\n')), /New session/);
    tui.feedInput('n');
    assert.equal(tui.overlays.length, 0);
    assert.match(root.state.error!, /Reactivate/);
    root.state.setWorkItemData(withSession('w1'));
    tui.feedInput('n');
    tui.feedInput('Draft');
    tui.feedInput('\x1b');
    assert.equal(tui.overlays[0]!.visible, false);
    assert.equal(root.state.route.kind, 'work', 'Escape closes the overlay, not the page');
    assert.equal(root.state.draft.text, 'Draft');
  });
});

describe('AppRoot session open', () => {
  it('selecting a session asks the server once; Herdr focuses or continues it', async (t) => {
    let finish!: (value: SessionOpenResponse) => void;
    const server = new FakeServer();
    server.handlers['sessions.open'] = ({ workItemId, sessionId }) => { server.openCalls.push({ workItemId, sessionId }); return new Promise(resolve => { finish = resolve; }); };
    const { root, tui } = makeRoot({ server });
    const done = root.start();
    t.after(async () => { root.quit(); await done; });
    root.state.navigateToWorkItem('wi');
    root.state.setWorkItemData(withSession('wi'));
    tui.feedInput('\r');
    tui.feedInput('\r');
    assert.deepEqual(server.openCalls, [{ workItemId: 'wi', sessionId: 'm' }]);
    assert.equal(root.state.pendingConfirm, null, 'no confirmation: selecting is the request');
    finish({ action: 'continued', details: withSession('wi') });
    await waitFor(() => root.state.notice === 'Continued the conversation in Herdr.');
    assert.equal(server.launchCalls.length, 0);
  });

  it('a focused session clears the notice and server refusals surface as errors', async () => {
    const { root, server } = makeRoot();
    root.state.navigateToWorkItem('wi');
    root.state.setWorkItemData(withSession('wi'));
    server.openQueue.push({ action: 'focused', details: withSession('wi') }, serverError(409, 'No native conversation was recorded for this session'));
    await openSession(root);
    assert.equal(root.state.notice, null);
    assert.equal(root.state.error, null);
    await openSession(root);
    assert.match(root.state.error!, /No native conversation/);
    root.stop();
  });

  for (const localState of ['done', 'cancelled'] as const) {
    it(localState + ' work needs explicit reactivation before opening a session', async () => {
      const { root, server } = makeRoot();
      root.state.navigateToWorkItem('wi');
      root.state.setWorkItemData(withSession('wi', localState));
      await openSession(root);
      assert.match(root.state.error!, /Reactivate local work explicitly/);
      assert.equal(server.openCalls.length, 0);
      root.stop();
    });
  }

  it('a late open reply after quit changes nothing', async (t) => {
    let finish!: (value: SessionOpenResponse) => void;
    const server = new FakeServer();
    server.handlers['sessions.open'] = () => new Promise(resolve => { finish = resolve; });
    const { root, tui } = makeRoot({ server });
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

describe('AppRoot offline rendering', () => {
  it('keeps the last-known dashboard content and shows an offline banner', () => {
    const { root, server } = makeRoot();
    const dash = emptyDashboard();
    dash.activeWorkItems = [
      { id: 'wi-A', title: 'Alpha Task', state: 'active', notes: null, createdAt: '', updatedAt: '', startedAt: null, completedAt: null, sessionCount: 0, repositoryCount: 0, trackerIssueKeys: [], changeRequestRefs: [] },
    ];
    server.dashboardResponse = dash;
    root.state.applyDashboardResponse(dash);
    root.state.setOffline();
    const output = root.render(80).join('\n');
    assert.match(output, /Alpha Task/, 'cached dashboard content still present');
    assert.match(output, /Offline/, 'offline banner shown');
    root.stop();
  });
});

describe('AppRoot requestId lifecycle integration', () => {
  it('a failed launch is still an answer: the draft clears and its work item shows the failure', async () => {
    const { root, server } = makeRoot();
    const fake = server;
    fake.launchQueue.push(launched('wi-new', 'failed', 'tool missing'));
    root.state.setDraft({ text: 'go' });
    await (root as unknown as { launch: (p: string) => Promise<boolean> }).launch('go');
    assert.equal(fake.launchCalls.length, 1);
    assert.equal(root.state.route.kind, 'work');
    assert.equal(openWork(root.state).id, 'wi-new');
    assert.match(stripTerminalSequences(root.render(80).join('\n')), /tool missing/);
    root.state.navigateHome();
    assert.equal(root.state.draft.text, '');
    assert.equal(root.state.draft.requestId, undefined);
    root.stop();
  });

  it('an unanswered launch resends its request ID across navigation', async () => {
    const { root, server } = makeRoot();
    const fake = server;
    fake.launchQueue.push(new Error('network'));
    fake.launchQueue.push(launched('wi-ok'));
    root.state.setDraft({ text: 'risky' });
    await (root as unknown as { launch: (p: string) => Promise<boolean> }).launch('risky');
    const firstId = fake.launchCalls[0]?.requestId;
    assert.ok(firstId, 'requestId sent on first attempt');
    assert.equal(root.state.draft.requestId, firstId);

    // Navigate away: the request ID stays with its draft (home).
    root.state.navigateToWorkItem('wi-other');
    assert.equal(root.state.draft.text, '', 'different draft key');
    root.state.navigateHome();

    await (root as unknown as { launch: (p: string) => Promise<boolean> }).launch('risky');
    assert.equal(fake.launchCalls.length, 2);
    assert.equal(fake.launchCalls[1]?.endpoint, 'quickStart');
    assert.equal(fake.launchCalls[1]?.requestId, firstId, 'resends the original request ID');
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
        sessionCount: 0, repositoryCount: 0, trackerIssueKeys: [], changeRequestRefs: [],
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
      attachments: [],
      launches: [],
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
        sessionCount: 0, repositoryCount: 0, trackerIssueKeys: [], changeRequestRefs: [],
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

/** tRPC wire replies: `{ result }` on success, `{ error }` with the HTTP status on rejection. */
const replyData = (res: ServerResponse, data: unknown) => reply(res, 200, { result: { data } });
function replyError(res: ServerResponse, status: 400 | 404, message: string, path: string) {
  const code = status === 400 ? 'BAD_REQUEST' : 'NOT_FOUND';
  reply(res, status, { error: { message, code: status === 400 ? -32600 : -32004, data: { code, httpStatus: status, path } } });
}

describe('AppRoot Home launch over fixture HTTP', () => {
  for (const failure of ['400', 'timeout'] as const) {
    it(`n opens an empty dialog; it keeps exact typed and pasted whitespace after ${failure}, then retries deliberately`, async t => {
      const requests: Array<{ path: string; body: { prompt: string; requestId: string } }> = [];
      const url = await httpFixture(t, (req, res) => {
        let data = '';
        req.on('data', chunk => { data += chunk; });
        req.on('end', () => {
          const path = req.url!.split('?')[0]!;
          if (path !== '/trpc/launches.quickStart') {
            if (path === '/trpc/launches.get') replyError(res, 404, 'launch not found', 'launches.get');
            else replyData(res, path === '/trpc/dashboard.get' ? emptyDashboard() : path === '/trpc/tools.list' ? fixtureTools()
              : path === '/trpc/prompts.list' || path === '/trpc/repositories.list' ? [] : detailsOf('created'));
            return;
          }
          const body = JSON.parse(data) as { prompt: string; requestId: string };
          requests.push({ path, body });
          if (requests.length === 1) {
            if (failure === '400') replyError(res, 400, 'Rejected', 'launches.quickStart');
            else { /* Deliberately withhold fixture reply. */ }
          } else replyData(res, launched('created'));
        });
      });
      // Only the timeout case races a short deadline; slow runners must not turn a reply into one.
      // The TUI cannot pass a per-call deadline, so the injected fetch aborts the launch request itself.
      const deadlineFetch: typeof fetch = (input, init) => failure === 'timeout' && String(input).endsWith('/trpc/launches.quickStart')
        ? fetch(input, { ...init, signal: AbortSignal.any([...init?.signal ? [init.signal] : [], AbortSignal.timeout(35)]) })
        : fetch(input, init);
      const { root, tui } = makeRoot({ client: createLovelaceClient(url, deadlineFetch) });
      const done = root.start();
      t.after(async () => { root.quit(); await done; });
      await waitFor(() => !root.state.isLoading);
      tui.feedInput('n');
      const overlay = tui.overlays[0]!;
      const dialog = overlay.component as LaunchDialog;
      await waitFor(() => !dialog.loading);
      assert.equal(dialog.focus, 'prompt');
      assert.equal(dialog.editor.getExpandedText(), '');
      tui.feedInput('\r'); // Enter in the prompt: leading blank line.
      tui.feedInput('  typed ');
      tui.feedInput('\x1b[200~pasted  \n\n  \x1b[201~');
      const prompt = '\n  typed pasted  \n\n  ';
      assert.equal(dialog.editor.getExpandedText(), prompt);
      tui.feedInput('\x13');
      await waitFor(() => requests.length === 1 && !root.state.mutationInFlight && !dialog.launching);
      assert.equal(requests[0]!.body.prompt, prompt);
      assert.equal(overlay.visible, true, 'failures stay in the dialog');
      assert.equal(dialog.editor.getExpandedText(), prompt, 'failure retains exact buffer');
      assert.equal(root.state.draft.text, prompt);
      if (failure === 'timeout') assert.ok(root.state.draft.requestId);
      tui.feedInput('\x13');
      await waitFor(() => requests.length === 2 && !root.state.mutationInFlight);
      assert.equal(requests[1]!.body.prompt, prompt);
      assert.equal(requests[1]!.path, '/trpc/launches.quickStart');
      if (failure === 'timeout') assert.equal(requests[1]!.body.requestId, requests[0]!.body.requestId);
      else assert.notEqual(requests[1]!.body.requestId, requests[0]!.body.requestId);
      assert.equal(root.state.route.kind, 'work');
      await waitFor(() => !overlay.visible);
      root.state.navigateHome();
      assert.equal(root.state.draft.text, '', 'successful source draft is cleared too');
    });
  }

  it('late mutation reply updates only its originating draft, not a newly selected task', async t => {
    let finish!: (value: LaunchResponse) => void;
    const server = new FakeServer();
    server.handlers['launches.quickStart'] = () => new Promise(resolve => { finish = resolve; });
    const { root } = makeRoot({ server });
    const done = root.start();
    t.after(async () => { root.quit(); await done; });
    root.state.setDraft({ text: 'original' });
    void (root as unknown as { launch: (p: string) => Promise<boolean> }).launch('original');
    root.state.navigateToWorkItem('different');
    root.state.setDraft({ text: 'different draft' });
    root.render(80);
    finish(launched('created', 'failed', 'failed'));
    await waitFor(() => !root.state.mutationInFlight);
    assert.equal(openWork(root.state).id, 'different');
    assert.equal(root.state.draft.text, 'different draft');
    root.state.navigateHome();
    assert.equal(root.state.draft.text, '', 'the answered launch belongs to the server');
    assert.equal(root.state.draft.requestId, undefined);
  });
});

describe('AppRoot input/lifecycle integration', () => {
  it('starts details through real navigation input and restores focus after sidebar selection', async t => {
    const { root, tui, server } = makeRoot();
    const dash = emptyDashboard();
    dash.activeWorkItems = [{
      ...detailsOf('wi').workItem, sessionCount: 0, repositoryCount: 0,
      trackerIssueKeys: [], changeRequestRefs: [],
    }];
    server.dashboardResponse = dash;
    const done = root.start();
    t.after(async () => { root.quit(); await done; });
    await waitFor(() => !root.state.isLoading);
    tui.feedInput('\t');
    tui.feedInput('\x1b[B');
    tui.feedInput('\r');
    await waitFor(() => openWork(root.state).details?.workItem.id === 'wi');
    assert.equal(root.state.focus, 'content');
    root.state.setOffline();
    assert.equal(root.state.route.kind, 'work');
    assert.match(root.render(80).join('\n'), /Item wi/);
  });


  it('kitty key releases do not repeat navigation', async t => {
    const { root, tui, server } = makeRoot();
    const dash = emptyDashboard();
    dash.activeWorkItems = ['a', 'b', 'c'].map(id => ({
      ...detailsOf(id).workItem, sessionCount: 0, repositoryCount: 0, trackerIssueKeys: [], changeRequestRefs: [],
    }));
    server.dashboardResponse = dash;
    const done = root.start();
    t.after(async () => { root.quit(); await done; });
    await waitFor(() => !root.state.isLoading);
    root.state.setFocus('sidebar');
    const before = root.state.sidebarSelectedIndex;
    tui.feedInput('\x1b[1;1:1B');
    tui.feedInput('\x1b[1;1:3B');
    assert.equal(root.state.sidebarSelectedIndex, before + 1);
  });

  it('Esc cancels confirmation before navigating; movement clears it', async t => {
    const { root, tui, server } = makeRoot();
    const done = root.start();
    t.after(async () => { root.quit(); await done; });
    root.state.navigateToWorkItem('wi');
    root.state.pendingConfirm = { kind: 'state', state: 'done' };
    tui.feedInput('\x1b');
    assert.equal(root.state.route.kind, 'work');
    assert.equal(root.state.pendingConfirm, null);
    root.state.pendingConfirm = { kind: 'state', state: 'done' };
    tui.feedInput('\x1b[B');
    tui.feedInput('y');
    assert.equal(root.state.pendingConfirm, null);
    assert.equal(server.openCalls.length, 0);
  });


  it('discarding a stuck launch needs explicit x/y and cannot implicitly replay or clear it', async t => {
    const { root, tui, server } = makeRoot();
    const done = root.start();
    t.after(async () => { root.quit(); await done; });
    root.state.setDraft({ text: 'original', requestId: 'id' });
    tui.feedInput('x');
    assert.equal(root.state.pendingConfirm?.kind, 'launch-abandon');
    assert.equal(root.state.draft.requestId, 'id');
    tui.feedInput('\x1b');
    assert.equal(root.state.pendingConfirm, null);
    assert.equal(root.state.draft.requestId, 'id');
    tui.feedInput('x');
    tui.feedInput('y');
    assert.equal(root.state.draft.requestId, undefined);
    assert.equal(root.state.draft.text, '');
    assert.equal(server.launchCalls.length, 0);
  });

  it('sidebar selection remains visible beyond the viewport and stale/offline footer fits', () => {
    const { root, tui } = makeRoot();
    const dash = emptyDashboard();
    dash.activeWorkItems = Array.from({ length: 60 }, (_, n) => ({
      ...detailsOf('wi-' + n).workItem, title: 'Selected task ' + n, sessionCount: 0,
      repositoryCount: 0, trackerIssueKeys: [], changeRequestRefs: [],
    }));
    dash.freshness.trackerStale = true;
    dash.freshness.codeHostStale = true;
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

describe('AppRoot details refresh', () => {
  it('fetches work item details when selected and refresh is triggered', async () => {
    const { root, server } = makeRoot();
    const fake = server;
    fake.workItemByIdResponse['wi-7'] = detailsOf('wi-7', 'active');
    root.state.route = { kind: 'work', id: 'wi-7', details: null };
    // Fetch directly, without the full start() (no need for input listeners).
    await (root as unknown as { refresh: { fetchDetails: (signal: AbortSignal) => Promise<void> } }).refresh.fetchDetails(new AbortController().signal);
    assert.equal(openWork(root.state).details?.workItem.id, 'wi-7');
    root.stop();
  });
});


describe('Home without a prompt dock', () => {
  it('n opens the launch dialog on Home and on work items; Tab only moves between content and sidebar', async t => {
    const { root, tui } = makeRoot();
    const done = root.start();
    t.after(async () => { root.quit(); await done; });
    await waitFor(() => !root.state.isLoading);
    assert.doesNotMatch(root.render(120).join('\n'), /Quick start/);
    for (let i = 0; i < 4; i++) {
      tui.feedInput('\t');
      assert.ok(['content', 'sidebar'].includes(root.state.focus));
    }
    tui.feedInput('n');
    assert.equal(tui.overlays.length, 1);
    assert.match(stripTerminalSequences((tui.overlays[0]!.component as LaunchDialog).render(118).join('\n')), /New work/);
    tui.feedInput('\x1b');
    root.state.navigateToWorkItem('wi');
    root.state.setWorkItemData(detailsOf('wi'));
    tui.feedInput('n');
    assert.equal(tui.overlays.length, 2);
    assert.match(stripTerminalSequences((tui.overlays[1]!.component as LaunchDialog).render(118).join('\n')), /New session/);
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
    const server = new FakeServer();
    const root = new AppRoot({ tui: tui as unknown as TuiAltScreen, client: server.client, serverUrl: 'http://127.0.0.1:4747', openUrl: async url => { opened.push(url); } });
    const dash = emptyDashboard();
    dash.activeWorkItems = ['a', 'b'].map(id => ({
      ...detailsOf(id).workItem, sessionCount: 0, repositoryCount: 0, trackerIssueKeys: [], changeRequestRefs: [],
    }));
    dash.recent.workItems = [{ ...detailsOf('y').workItem, title: 'Recent item', sessionCount: 0, repositoryCount: 0, trackerIssueKeys: [], changeRequestRefs: [] }];
    root.state.applyDashboardResponse(dash);
    return { root, tui, server, opened };
  }

  it('clicking sidebar and content rows navigates like Enter', async () => {
    const { root, server } = mouseRoot();
    server.workItemByIdResponse.b = detailsOf('b');
    clickText(root, 'Item b');
    assert.equal(root.state.route.kind, 'work');
    assert.equal(openWork(root.state).id, 'b');
    clickText(root, 'Home');
    assert.equal(root.state.route.kind, 'home');
    clickText(root, 'Recent item');
    await waitFor(() => openWork(root.state).id === 'y');
    root.stop();
  });

  it('opens provider cards in the browser and replays clicked help chips', () => {
    const { root, tui, opened } = mouseRoot();
    const details = detailsOf('a');
    details.attachments.push({
      id: 'pr', workItemId: 'a', type: 'pull-request', provider: 'github', externalId: '7',
      payload: { number: 7, url: 'https://github.invalid/org/repo/pull/7', status: 'open' } as TrackedChangeRequest, createdAt: '', updatedAt: '',
    });
    root.state.navigateToWorkItem('a');
    root.state.setWorkItemData(details);
    clickText(root, '#7');
    assert.deepEqual(opened, ['https://github.invalid/org/repo/pull/7']);
    clickText(root, 'Esc back');
    assert.equal(root.state.route.kind, 'home');
    clickText(root, 'n new work');
    assert.equal(tui.overlays.length, 1, 'the n chip opens the launch dialog');
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

  it('wheel moves the selection of the pane under the pointer; plain clicks keep text selection', () => {
    const { root } = mouseRoot();
    root.render(120);
    root.handleMouse(event('wheel', 110, 4, { wheelDelta: 3 }));
    assert.equal(root.state.focus, 'sidebar');
    assert.equal(root.state.sidebarSelectedIndex, 1);
    root.handleMouse(event('wheel', 10, 4, { wheelDelta: -1 }));
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
