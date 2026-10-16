import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DashboardResponse, QuickStartResponse, WorkItemDetails } from '@lovelace/core';
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
    pendingJiraIssues: [],
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
    metas: [],
  };
}

function makeDeps(overrides: Partial<ControllerDeps> & { client?: Partial<LovelaceClient> } = {}): ControllerDeps {
  const client = { ...fakeClient(), ...overrides.client } as LovelaceClient;
  return {
    client,
    refreshDashboard: () => {},
    startJiraWork: () => {},
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
    newSession: async () => ({ details: detailsOf('wi-1'), launch: { ok: true, error: null } }),
    quickStart: async () => ({ details: detailsOf('wi-1'), launch: { ok: true, error: null } }),
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
    } as unknown as import('@lovelace/client').LovelaceClient;
    await submitLaunch(state, {
      client,
      refreshDashboard: () => {},
    }, 'do thing');
    assert.match(state.error ?? '', /not active/i);
    assert.equal(state.mutationInFlight, false);
  });

  it('on partial launch failure keeps retryWorkId pointing to the same work item', async () => {
    const state = new AppState({ onInvalidate() {} });
    state.applyDashboardResponse(dash());
    state.setDraft({ text: 'build it' });
    let calls = 0;
    const client = {
      quickStart: async () => {
        calls++;
        return { details: detailsOf('wi-new'), launch: { ok: false, error: 'tool missing' } } satisfies QuickStartResponse;
      },
      newSession: async (id: string) => {
        calls++;
        assert.equal(id, 'wi-new', 'retry must target the same work item');
        return { details: detailsOf('wi-new'), launch: { ok: true, error: null } } satisfies QuickStartResponse;
      },
    } as unknown as import('@lovelace/client').LovelaceClient;
    await submitLaunch(state, { client, refreshDashboard: () => {} }, 'build it');
    assert.equal(state.draft.retryWorkId, 'wi-new');
    assert.match(state.error ?? '', /tool missing/);
    // Second submit uses newSession on the retained id.
    await submitLaunch(state, { client, refreshDashboard: () => {} }, 'build it');
    assert.equal(calls, 2);
    assert.equal(state.draft.retryWorkId, undefined);
  });

  it('on offline network error marks uncertain and does not retry', async () => {
    const state = new AppState({ onInvalidate() {} });
    state.applyDashboardResponse(dash());
    state.setDraft({ text: 'risky' });
    const client = {
      quickStart: async () => { throw new ApiError(0, 'cannot reach server'); },
    } as unknown as import('@lovelace/client').LovelaceClient;
    await submitLaunch(state, { client, refreshDashboard: () => {} }, 'risky');
    assert.equal(state.draft.uncertain, true);
    assert.match(state.error ?? '', /uncertain/i);
    assert.equal(state.draft.retryWorkId, undefined);
  });
});

describe('submitLaunch requestId lifecycle', () => {
  it('generates a stable requestId per launch intent and forwards it to the server', async () => {
    const state = new AppState({ onInvalidate() {} });
    state.applyDashboardResponse(dash());
    state.setDraft({ text: 'go' });
    const captured: Array<string | undefined> = [];
    const client = {
      quickStart: async (_p: string, _j?: string, _a?: unknown, _o?: unknown, requestId?: string) => {
        captured.push(requestId);
        return { details: detailsOf('wi-new'), launch: { ok: true, error: null } } satisfies QuickStartResponse;
      },
    } as unknown as import('@lovelace/client').LovelaceClient;
    let seq = 0;
    const newRequestId = () => `uuid-${++seq}`;
    await submitLaunch(state, {
      client, refreshDashboard: () => {}, newRequestId,
    }, 'go');
    assert.deepEqual(captured, ['uuid-1']);
    // Success clears the id.
    const key = state.draftKey;
    const draftAfter = state.drafts.get(key);
    assert.equal(draftAfter?.pendingLaunch?.requestId, undefined);
  });

  it('retains requestId across uncertain network failure and reuses it on retry', async () => {
    const state = new AppState({ onInvalidate() {} });
    state.applyDashboardResponse(dash());
    state.setDraft({ text: 'retryable' });
    const captured: Array<string | undefined> = [];
    let shouldThrow = true;
    const client = {
      quickStart: async (_p: string, _j?: string, _a?: unknown, _o?: unknown, requestId?: string) => {
        captured.push(requestId);
        if (shouldThrow) throw new ApiError(0, 'offline');
        return { details: detailsOf('wi-new'), launch: { ok: true, error: null } } satisfies QuickStartResponse;
      },
    } as unknown as import('@lovelace/client').LovelaceClient;
    let seq = 0;
    const newRequestId = () => `uuid-${++seq}`;
    const deps = { client, refreshDashboard: () => {}, newRequestId };

    await submitLaunch(state, deps, 'retryable');
    assert.equal(state.draft.uncertain, true);
    assert.equal(state.draft.pendingLaunch?.requestId, 'uuid-1');

    shouldThrow = false;
    await submitLaunch(state, deps, 'retryable');
    assert.deepEqual(captured, ['uuid-1', 'uuid-1'], 'retry must reuse the stable intent id');
    assert.equal(state.draft.pendingLaunch?.requestId, undefined, 'success clears the intent id');
  });

  it('on confirmed completed failure clears requestId and retries with a fresh UUID on same work item', async () => {
    const state = new AppState({ onInvalidate() {} });
    state.applyDashboardResponse(dash());
    state.setDraft({ text: 'build' });
    const captured: Array<{ fn: string; id?: string; req?: string }> = [];
    const client = {
      quickStart: async (_p: string, _j?: string, _a?: unknown, _o?: unknown, requestId?: string) => {
        captured.push({ fn: 'quickStart', req: requestId });
        return {
          details: detailsOf('wi-new'),
          launch: { ok: false, error: 'tool missing' },
          operation: { requestId: requestId ?? '', status: 'completed' as const },
        } satisfies QuickStartResponse;
      },
      newSession: async (id: string, _p: string, _a?: unknown, _o?: unknown, requestId?: string) => {
        captured.push({ fn: 'newSession', id, req: requestId });
        return { details: detailsOf(id), launch: { ok: true, error: null } } satisfies QuickStartResponse;
      },
    } as unknown as import('@lovelace/client').LovelaceClient;
    let seq = 0;
    const deps = { client, refreshDashboard: () => {}, newRequestId: () => `uuid-${++seq}` };

    await submitLaunch(state, deps, 'build');
    await submitLaunch(state, deps, 'build');
    assert.equal(captured[0]?.fn, 'quickStart');
    assert.equal(captured[0]?.req, 'uuid-1');
    assert.equal(captured[1]?.fn, 'newSession');
    assert.equal(captured[1]?.id, 'wi-new');
    assert.equal(captured[1]?.req, 'uuid-2', 'confirmed-completed failure must generate a fresh UUID for retry');
  });


  for (const status of ['pending', 'uncertain'] as const) {
    it(`pins ${status} endpoint/body/UUID despite edits, navigation and later rejection`, async () => {
      const state = new AppState({ onInvalidate() {} });
      state.applyDashboardResponse(dash());
      const exact = '  original\n\n  ';
      state.setDraft({ text: exact });
      const captured: Array<{ prompt: string; requestId?: string }> = [];
      let seq = 0;
      const client = {
        quickStart: async (prompt: string, _jira?: string, _agent?: unknown, _o?: unknown, requestId?: string) => {
          captured.push({ prompt, requestId });
          if (captured.length === 2) throw new ApiError(409, 'fixture rejection');
          return {
            details: detailsOf('persisted'), launch: { ok: false, error: 'Inspect existing sessions' },
            operation: { requestId: requestId!, status },
          } satisfies QuickStartResponse;
        },
        newSession: async () => { assert.fail('must not roll endpoint'); },
      } as unknown as import('@lovelace/client').LovelaceClient;
      const deps = { client, refreshDashboard: () => {}, newRequestId: () => `uuid-${++seq}` };
      await submitLaunch(state, deps, exact);
      assert.equal(state.draft.uncertain, true);
      state.setDraft({ text: 'edited' });
      state.navigateToWorkItem('other');
      state.navigateToDashboard();
      await submitLaunch(state, deps, 'edited');
      assert.equal(state.draft.pendingLaunch?.requestId, 'uuid-1', 'rejection cannot abandon unresolved operation implicitly');
      state.setDraft({ text: '' });
      await submitLaunch(state, deps, '');
      assert.deepEqual(captured, Array(3).fill({ prompt: exact, requestId: 'uuid-1' }));
      assert.equal(seq, 1);
    });
  }

  it('abandonLaunchIntent clears the stored requestId and draft text', () => {
    const state = new AppState({ onInvalidate() {} });
    state.applyDashboardResponse(dash());
    state.setDraft({
      text: 'stuck', uncertain: true, retryWorkId: 'wi-x',
      pendingLaunch: { endpoint: 'newSession', workItemId: 'wi-x', prompt: 'stuck', requestId: 'uuid-abc' },
    });
    abandonLaunchIntent(state);
    assert.equal(state.draft.text, '');
    assert.equal(state.draft.pendingLaunch, undefined);
    assert.equal(state.draft.retryWorkId, undefined);
    assert.equal(state.draft.uncertain, false);
  });

  it('passes the exact prompt (including trailing whitespace) through to the server', async () => {
    const state = new AppState({ onInvalidate() {} });
    state.applyDashboardResponse(dash());
    const exact = '  do a thing\n\n  ';
    state.setDraft({ text: exact });
    const sent: string[] = [];
    const client = {
      quickStart: async (prompt: string) => {
        sent.push(prompt);
        return { details: detailsOf('wi-new'), launch: { ok: true, error: null } } satisfies QuickStartResponse;
      },
    } as unknown as import('@lovelace/client').LovelaceClient;
    await submitLaunch(state, {
      client, refreshDashboard: () => {}, newRequestId: () => 'uuid-x',
    }, exact);
    assert.deepEqual(sent, [exact]);
  });
});
