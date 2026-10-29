import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DashboardResponse, Launch, LaunchResponse, WorkItemDetails } from '@lovelace/core';
import { fakeClient, serverError, type FakeHandlers } from '@lovelace/client/testing';
import { AppState } from './state.js';
import { handleKey, handleAction, submitLaunch, abandonLaunchIntent, type ControllerDeps } from './controller.js';

function dash(overrides: Partial<DashboardResponse> = {}): DashboardResponse {
  return {
    activeWorkItems: [
      {
        id: 'wi-1', title: 'Active one', state: 'active', notes: null,
        createdAt: '', updatedAt: '', startedAt: null, completedAt: null,
        sessionCount: 0, repositoryCount: 0, trackerIssueKeys: [], changeRequestRefs: [],
      },
    ],
    pendingIssues: [], pendingReviews: [],
    recent: { since: '2026-10-06T00:00:00.000Z', workItems: [], sessionCount: 0, completedCount: 0, activityCount: 0 },
    settings: { defaultAgent: 'pi', repositoryTopics: [] },
    freshness: { trackerFetchedAt: null, codeHostFetchedAt: null, trackerStale: false, codeHostStale: false },
    ...overrides,
  };
}

function detailsOf(id: string): WorkItemDetails {
  return {
    workItem: {
      id, title: `Item ${id}`, state: 'active', notes: null,
      createdAt: '', updatedAt: '', startedAt: null, completedAt: null,
    },
    attachments: [],
    launches: [],
  };
}

function accepted(id: string, requestId = 'uuid'): LaunchResponse {
  const launch: Launch = {
    id: requestId, workItemId: id, state: 'accepted', error: null, harness: 'pi', repoIds: [], promptId: null, prompt: '', createdAt: '', updatedAt: '',
  };
  return { details: { ...detailsOf(id), launches: [launch] }, launch };
}

function makeDeps(overrides: Partial<Omit<ControllerDeps, 'client'>> & { handlers?: FakeHandlers } = {}): ControllerDeps {
  const { handlers, ...rest } = overrides;
  // Minimal procedures covering what the tests exercise.
  const client = fakeClient({
    'workItems.setState': async ({ id }) => detailsOf(id).workItem,
    'launches.newSession': async () => accepted('wi-1'),
    'launches.quickStart': async () => accepted('wi-1'),
    ...handlers,
  });
  return {
    client,
    refreshDashboard: () => {},
    startJiraWork: () => {},
    startReview: async () => {},
    refreshDetails: () => {},
    submitLaunch: async () => {},
    openSession: async () => {},
    openUrl: async () => {},
    resetEditor: () => {},
    focusEditor: () => {},
    invalidate: () => {},
    quit: () => {},
    ...rest,
  };
}

describe('handleKey focus routing', () => {
  it('quits when q pressed with content focus', () => {
    const state = new AppState({ onInvalidate() {} });
    let quit = 0;
    const deps = makeDeps({ quit: () => { quit++; } });
    handleKey(state, { kind: 'quit' }, deps, 0);
    assert.equal(quit, 1);
  });

  it('cycles focus on Tab', () => {
    const state = new AppState({ onInvalidate() {} });
    assert.equal(state.focus, 'content');
    handleKey(state, { kind: 'tab' }, makeDeps(), 0);
    assert.equal(state.focus, 'sidebar');
    handleKey(state, { kind: 'tab' }, makeDeps(), 0);
    assert.equal(state.focus, 'editor');
    // The agent, thinking and model fields sit below the editor, in that order.
    for (const field of ['launch-agent', 'launch-thinking', 'launch-model']) {
      handleKey(state, { kind: 'tab' }, makeDeps(), 0);
      assert.equal(state.focus, field);
    }
    handleKey(state, { kind: 'tab' }, makeDeps(), 0);
    assert.equal(state.focus, 'content');
  });
});

describe('handleAction navigation', () => {
  it('navigates to a selected work item on Enter in dashboard', async () => {
    const state = new AppState({ onInvalidate() {} });
    state.applyDashboardResponse(dash());
    let refreshed = 0;
    await handleAction(state, { kind: 'navigate', entry: { kind: 'work', id: 'wi-1' } },
      makeDeps({ refreshDetails: () => { refreshed++; } }));
    assert.equal(state.view, 'work-item');
    assert.equal(state.selectedWorkItemId, 'wi-1');
    assert.equal(refreshed, 1);
  });
});

describe('submitLaunch flows', () => {
  it('surfaces 409 as error without side effects', async () => {
    const state = new AppState({ onInvalidate() {} });
    state.applyDashboardResponse(dash());
    state.navigateToWorkItem('wi-1');
    state.setDraft({ text: 'do thing' });
    const client = fakeClient({
      'launches.newSession': async () => { throw serverError(409, 'Work item is not active.'); },
    });
    await submitLaunch(state, { client, refreshDashboard: () => {} }, 'do thing');
    assert.match(state.error ?? '', /not active/i);
    assert.equal(state.draft.requestId, undefined, 'a rejected first send leaves nothing to resend');
    assert.equal(state.draft.text, 'do thing');
    assert.equal(state.mutationInFlight, false);
  });

  it('hands any answer to the server: clears the draft and opens the work item', async () => {
    const state = new AppState({ onInvalidate() {} });
    state.applyDashboardResponse(dash());
    state.setDraft({ text: 'build it', repoIds: ['repo'], promptId: 'implement' });
    const client = fakeClient({ 'launches.quickStart': async () => accepted('wi-new') });
    await submitLaunch(state, { client, refreshDashboard: () => {} }, 'build it');
    assert.equal(state.drafts.get('home')!.text, '');
    assert.equal(state.drafts.get('home')!.repoIds, undefined);
    assert.equal(state.drafts.get('home')!.requestId, undefined);
    assert.equal(state.view, 'work-item');
    assert.equal(state.selectedWorkItemId, 'wi-new');
    assert.equal(state.error, null);
  });
});

describe('submitLaunch requestId lifecycle', () => {
  it('keeps the request ID while no answer arrived and resends it', async () => {
    const state = new AppState({ onInvalidate() {} });
    state.applyDashboardResponse(dash());
    state.setDraft({ text: 'retryable' });
    const captured: Array<string | undefined> = [];
    let failure: Error | null = new Error('offline');
    const client = fakeClient({
      'launches.quickStart': async ({ requestId }) => {
        captured.push(requestId);
        if (failure) throw failure;
        return accepted('wi-new', requestId);
      },
      'launches.get': async () => { throw serverError(404, 'launch not found'); },
    });
    let seq = 0;
    const deps = { client, refreshDashboard: () => {}, newRequestId: () => `uuid-${++seq}` };

    await submitLaunch(state, deps, 'retryable');
    assert.equal(state.draft.requestId, 'uuid-1');
    assert.match(state.error ?? '', /never launches twice/);
    failure = serverError(502, 'Bad gateway');
    await submitLaunch(state, deps, 'retryable');
    assert.equal(state.draft.requestId, 'uuid-1');
    failure = null;
    await submitLaunch(state, deps, 'retryable');
    assert.deepEqual(captured, ['uuid-1', 'uuid-1', 'uuid-1']);
    assert.equal(state.drafts.get('home')!.requestId, undefined, 'an answer clears the request ID');
  });

  it('a rejected resend keeps its request ID until the launch is discarded', async () => {
    const state = new AppState({ onInvalidate() {} });
    state.applyDashboardResponse(dash());
    state.setDraft({ text: 'original' });
    const captured: Array<string | undefined> = [];
    const client = fakeClient({
      'launches.quickStart': async ({ requestId }) => {
        captured.push(requestId);
        throw captured.length === 1 ? new Error('offline') : serverError(409, 'This request ID belongs to a different launch');
      },
      'launches.get': async () => { throw serverError(404, 'launch not found'); },
    });
    let seq = 0;
    const deps = { client, refreshDashboard: () => {}, newRequestId: () => `uuid-${++seq}` };
    await submitLaunch(state, deps, 'original');
    state.setDraft({ text: 'edited' });
    await submitLaunch(state, deps, 'edited');
    assert.equal(state.draft.requestId, 'uuid-1', 'a rejection cannot abandon a launch that may have started');
    assert.match(state.error ?? '', /different launch/);
    abandonLaunchIntent(state);
    assert.equal(state.draft.requestId, undefined);
    assert.equal(state.draft.text, '');
    assert.deepEqual(captured, ['uuid-1', 'uuid-1']);
  });

  it('a resend takes the recorded launch instead of sending an edited draft', async () => {
    const state = new AppState({ onInvalidate() {} });
    state.applyDashboardResponse(dash());
    state.setDraft({ text: 'original' });
    let sends = 0;
    let recorded = false;
    const client = fakeClient({
      'launches.quickStart': async () => { sends++; recorded = true; throw new Error('offline'); },
      'launches.get': async ({ id }) => {
        if (!recorded) throw serverError(404, 'launch not found');
        return accepted('wi-new', id);
      },
    });
    const deps = { client, refreshDashboard: () => {}, newRequestId: () => 'uuid-1' };
    await submitLaunch(state, deps, 'original');
    state.setDraft({ text: 'edited' });
    await submitLaunch(state, deps, 'edited');
    assert.equal(sends, 1, 'the recorded launch answers the resend');
    assert.equal(state.error, null);
    assert.equal(state.drafts.get('home')!.requestId, undefined);
    assert.equal(state.selectedWorkItemId, 'wi-new');
  });

  it('passes the exact prompt (including trailing whitespace) through to the server', async () => {
    const state = new AppState({ onInvalidate() {} });
    state.applyDashboardResponse(dash());
    const exact = '  do a thing\n\n  ';
    state.setDraft({ text: exact });
    const sent: string[] = [];
    const client = fakeClient({
      'launches.quickStart': async ({ prompt }) => { sent.push(prompt); return accepted('wi-new'); },
    });
    await submitLaunch(state, { client, refreshDashboard: () => {}, newRequestId: () => 'uuid-x' }, exact);
    assert.deepEqual(sent, [exact]);
  });
});

describe('launch retry', () => {
  it('asks the server to retry the failed launch on its work item', async () => {
    const state = new AppState({ onInvalidate() {} });
    state.applyDashboardResponse(dash());
    state.navigateToWorkItem('wi-1');
    const retried: string[] = [];
    const deps = makeDeps({ handlers: { 'launches.retry': async ({ id }) => { retried.push(id); return accepted('wi-1', id); } } });
    await handleAction(state, { kind: 'launch-retry', launchId: 'launch-1' }, deps);
    assert.deepEqual(retried, ['launch-1']);
    assert.equal(state.selectedWorkItemData!.launches[0]!.state, 'accepted');
  });
});
