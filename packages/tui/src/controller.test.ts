import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DashboardResponse, Launch, LaunchResponse, WorkItemDetails } from '@lovelace/core';
import { ApiError, type LovelaceClient } from '@lovelace/client';
import { AppState } from './state.js';
import { handleKey, handleAction, submitLaunch, abandonLaunchIntent, type ControllerDeps } from './controller.js';

function dash(overrides: Partial<DashboardResponse> = {}): DashboardResponse {
  return {
    activeWorkItems: [
      {
        id: 'wi-1', title: 'Active one', state: 'active', notes: null,
        createdAt: '', updatedAt: '', startedAt: null, completedAt: null,
        sessionCount: 0, repositoryCount: 0, trackerIssueKeys: [], pullRequestRefs: [],
      },
    ],
    pendingJiraIssues: [], pendingReviews: [],
    recent: { since: '2026-10-06T00:00:00.000Z', workItems: [], sessionCount: 0, completedCount: 0, activityCount: 0 },
    settings: { defaultAgent: 'pi', sidebarSide: 'right', repositoryTopics: [] },
    freshness: { jiraFetchedAt: null, githubFetchedAt: null, jiraStale: false, githubStale: false },
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

function makeDeps(overrides: Partial<ControllerDeps> & { client?: Partial<LovelaceClient> } = {}): ControllerDeps {
  const client = { ...fakeClient(), ...overrides.client } as LovelaceClient;
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
    ...overrides,
  };
}

function fakeClient(): LovelaceClient {
  // Minimal shape covering what the tests exercise.
  return {
    setWorkItemState: async () => ({} as never),
    newSession: async () => accepted('wi-1'),
    quickStart: async () => accepted('wi-1'),
  } as unknown as LovelaceClient;
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
    const client = {
      newSession: async () => { throw new ApiError(409, 'Work item is not active.'); },
    } as unknown as LovelaceClient;
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
    const client = { quickStart: async () => accepted('wi-new') } as unknown as LovelaceClient;
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
    let failure: Error | null = new ApiError(0, 'offline');
    const client = {
      quickStart: async (_p: string, _j?: string, _a?: unknown, _o?: unknown, requestId?: string) => {
        captured.push(requestId);
        if (failure) throw failure;
        return accepted('wi-new', requestId);
      },
    } as unknown as LovelaceClient;
    let seq = 0;
    const deps = { client, refreshDashboard: () => {}, newRequestId: () => `uuid-${++seq}` };

    await submitLaunch(state, deps, 'retryable');
    assert.equal(state.draft.requestId, 'uuid-1');
    assert.match(state.error ?? '', /never launches twice/);
    failure = new ApiError(502, 'Bad gateway');
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
    const client = {
      quickStart: async (_p: string, _j?: string, _a?: unknown, _o?: unknown, requestId?: string) => {
        captured.push(requestId);
        throw captured.length === 1 ? new ApiError(0, 'offline') : new ApiError(409, 'This request ID belongs to a different launch');
      },
    } as unknown as LovelaceClient;
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

  it('passes the exact prompt (including trailing whitespace) through to the server', async () => {
    const state = new AppState({ onInvalidate() {} });
    state.applyDashboardResponse(dash());
    const exact = '  do a thing\n\n  ';
    state.setDraft({ text: exact });
    const sent: string[] = [];
    const client = {
      quickStart: async (prompt: string) => { sent.push(prompt); return accepted('wi-new'); },
    } as unknown as LovelaceClient;
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
    const deps = makeDeps({ client: { retryLaunch: async (id: string) => { retried.push(id); return accepted('wi-1', id); } } as unknown as LovelaceClient });
    await handleAction(state, { kind: 'launch-retry', launchId: 'launch-1' }, deps);
    assert.deepEqual(retried, ['launch-1']);
    assert.equal(state.selectedWorkItemData!.launches[0]!.state, 'accepted');
  });
});
