import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DashboardResponse } from '@lovelace/core';
import { AppState } from './state.js';

function dashboard(overrides: Partial<DashboardResponse> = {}): DashboardResponse {
  return {
    activeWorkItems: [
      {
        id: 'wi-1', title: 'Active one', state: 'active', notes: null,
        createdAt: '', updatedAt: '', startedAt: null, completedAt: null,
        sessionCount: 1, repositoryCount: 1, trackerIssueKeys: [], pullRequestRefs: [],
      },
      {
        id: 'wi-2', title: 'Active two', state: 'active', notes: null,
        createdAt: '', updatedAt: '', startedAt: null, completedAt: null,
        sessionCount: 0, repositoryCount: 0, trackerIssueKeys: [], pullRequestRefs: [],
      },
    ],
    pendingJiraIssues: [
      { id: 'J-1', key: 'PROJ-100', title: 'Fix docs', url: 'https://x', status: 'open', issueType: 'Task', updatedAt: '' },
    ],
    recent: { since: '2026-10-06T00:00:00.000Z', workItems: [], sessionCount: 0, completedCount: 0, activityCount: 0 },
    settings: { defaultAgent: 'pi', sidebarSide: 'right', repositoryTopics: [] },
    freshness: { jiraFetchedAt: null, githubFetchedAt: null, jiraStale: false, githubStale: false },
    ...overrides,
  };
}

describe('AppState sidebar entries', () => {
  it('contains dashboard, active work, pending jira', () => {
    const state = new AppState({ onInvalidate() {} });
    state.applyDashboardResponse(dashboard());
    const entries = state.sidebarEntries;
    assert.equal(entries[0]?.kind, 'home');
    assert.equal(entries[1]?.id, 'wi-1');
    assert.equal(entries[2]?.id, 'wi-2');
    assert.equal(entries[3]?.kind, 'jira');
  });

  it('clamps sidebar selection when data shrinks', () => {
    const state = new AppState({ onInvalidate() {} });
    state.applyDashboardResponse(dashboard());
    state.sidebarSelectedIndex = 3;
    state.applyDashboardResponse(dashboard({ pendingJiraIssues: [], activeWorkItems: [] }));
    assert.ok(state.sidebarSelectedIndex < state.sidebarEntries.length);
    assert.ok(state.sidebarSelectedIndex >= 0);
  });
});

describe('AppState drafts', () => {
  it('keys drafts by current view', () => {
    const state = new AppState({ onInvalidate() {} });
    state.applyDashboardResponse(dashboard());
    state.setDraft({ text: 'home draft' });
    state.navigateToWorkItem('wi-1');
    assert.equal(state.draft.text, '');
    state.setDraft({ text: 'wi draft' });
    state.navigateToDashboard();
    assert.equal(state.draft.text, 'home draft');
  });

  it('tracks retryWorkId separately per draft', () => {
    const state = new AppState({ onInvalidate() {} });
    state.applyDashboardResponse(dashboard());
    state.setDraft({ text: 'try', retryWorkId: 'wi-1' });
    assert.equal(state.draft.retryWorkId, 'wi-1');
    state.navigateToWorkItem('wi-1');
    assert.equal(state.draft.retryWorkId, undefined);
  });
});

describe('AppState sidebar override', () => {
  it('CLI override takes precedence over server setting', () => {
    const state = new AppState({ onInvalidate() {}, sidebarSide: 'left' });
    state.applyDashboardResponse(dashboard({ settings: { defaultAgent: 'pi', sidebarSide: 'right', repositoryTopics: [] } }));
    assert.equal(state.sidebarSide, 'left');
  });

  it('server setting applies when no CLI override', () => {
    const state = new AppState({ onInvalidate() {} });
    state.applyDashboardResponse(dashboard({ settings: { defaultAgent: 'pi', sidebarSide: 'right', repositoryTopics: [] } }));
    assert.equal(state.sidebarSide, 'right');
  });
});
