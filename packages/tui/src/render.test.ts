import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import type { DashboardResponse, WorkItemDetails } from '@lovelace/core';
import { AppState } from './state.js';
import { renderDashboard } from './views/dashboard.js';
import { renderWorkItem } from './views/work-item.js';
import { renderJira } from './views/jira.js';

function makeDashboard(overrides: Partial<DashboardResponse> = {}): DashboardResponse {
  return {
    activeWorkItems: [
      {
        id: 'wi-1', title: 'Fix 🚀 render issue', state: 'active', notes: null,
        createdAt: '', updatedAt: '', startedAt: null, completedAt: null,
        sessionCount: 1, repositoryCount: 1, trackerIssueKeys: [], pullRequestRefs: [],
      },
    ],
    pendingJiraIssues: [
      { id: 'J-1', key: 'PROJ-九', title: 'テスト Issue', url: 'https://x', status: 'open', issueType: 'Task', updatedAt: '' },
    ],
    recent: {
      since: '2026-10-06T00:00:00.000Z',
      workItems: [
        {
          id: 'wi-y', title: 'done thing', state: 'done', notes: null,
          createdAt: '', updatedAt: '', startedAt: null, completedAt: null,
          sessionCount: 0, repositoryCount: 0, trackerIssueKeys: [], pullRequestRefs: [],
        },
      ],
      sessionCount: 1, completedCount: 1, activityCount: 2,
    },
    settings: { defaultAgent: 'pi', sidebarSide: 'right', repositoryTopics: [] },
    freshness: { jiraFetchedAt: null, githubFetchedAt: null, jiraStale: false, githubStale: false },
    ...overrides,
  };
}

function checkWidth(lines: string[], width: number): void {
  for (const [i, line] of lines.entries()) {
    assert.ok(
      visibleWidth(line) <= width,
      `line ${i} visible width ${visibleWidth(line)} exceeds ${width}: ${JSON.stringify(line)}`,
    );
  }
}

describe('renderDashboard', () => {
  const widths = [50, 80, 120];
  for (const w of widths) {
    it(`fits width ${w} with CJK and emoji input`, () => {
      const state = new AppState({ onInvalidate() {} });
      state.applyDashboardResponse(makeDashboard());
      const doc = renderDashboard(state, w);
      assert.ok(doc.lines.length > 0);
      checkWidth(doc.lines, w);
    });
  }

  it('sanitizes control characters out of titles', () => {
    const nasty = makeDashboard({
      activeWorkItems: [{
        id: 'wi-nasty', title: 'bad\x1b[31mred\x1b[0m title', state: 'active', notes: null,
        createdAt: '', updatedAt: '', startedAt: null, completedAt: null,
        sessionCount: 0, repositoryCount: 0, trackerIssueKeys: [], pullRequestRefs: [],
      }],
    });
    const state = new AppState({ onInvalidate() {} });
    state.applyDashboardResponse(nasty);
    const doc = renderDashboard(state, 80);
    for (const line of doc.lines) {
      // No ESC-bracketed red (31m) from the input survives sanitization.
      assert.ok(!line.includes('red\x1b[0m title'), 'leaked escape sequences');
    }
  });
});

describe('renderWorkItem', () => {
  it('renders sessions, PRs and jira attachments without overflow', () => {
    const details: WorkItemDetails = {
      workItem: {
        id: 'wi-1', title: 'Big change', state: 'active', notes: 'important notes',
        createdAt: '', updatedAt: '', startedAt: null, completedAt: null,
      },
      metas: [
        {
          id: 'm-session', workItemId: 'wi-1', metaType: 'session', externalId: 'sess-1',
          payloadJson: JSON.stringify({
            title: 'Claude session',
            agentState: 'blocked',
          }),
          createdAt: '', updatedAt: '', provider: null,
        },
        {
          id: 'm-pr', workItemId: 'wi-1', metaType: 'pull-request', externalId: '12',
          payloadJson: JSON.stringify({
            repoFullName: 'examplecom/api', number: 12, status: 'open',
            reviewDecision: 'approved', buildStatus: 'success',
          }),
          createdAt: '', updatedAt: '', provider: null,
        },
        {
          id: 'm-ji', workItemId: 'wi-1', metaType: 'tracker-item', externalId: 'PROJ-1',
          payloadJson: JSON.stringify({ key: 'PROJ-1', status: 'In Progress', title: 'Fix bug' }),
          createdAt: '', updatedAt: '', provider: null,
        },
      ],
    };
    const state = new AppState({ onInvalidate() {} });
    state.navigateToWorkItem('wi-1');
    state.setWorkItemData(details);
    for (const w of [50, 80, 120]) {
      const doc = renderWorkItem(state, w);
      assert.ok(doc.lines.length > 0);
      for (const line of doc.lines) {
        assert.ok(visibleWidth(line) <= w, `line width ${visibleWidth(line)} > ${w}`);
      }
    }
  });
});

describe('renderJira', () => {
  it('renders issue description and a start-work action', () => {
    const state = new AppState({ onInvalidate() {} });
    state.applyDashboardResponse(makeDashboard());
    state.navigate({ kind: 'jira', id: 'J-1' });
    const doc = renderJira(state, 80);
    assert.deepEqual(doc.actions, [{ kind: 'jira-setup' }, { kind: 'open-url', url: 'https://x/' }]);
    state.setDraft({ pendingLaunch: { endpoint: 'quickStart', prompt: 'saved prompt', requestId: 'retry-id' } });
    assert.deepEqual(renderJira(state, 80).actions, [{ kind: 'launch-retry' }, { kind: 'open-url', url: 'https://x/' }]);
    checkWidth(doc.lines, 80);
  });
});

describe('dashboard columns', () => {
  it('lists recent work and Jira side by side as selectable items with the selection row tracked', () => {
    const state = new AppState({ onInvalidate() {} });
    state.applyDashboardResponse(makeDashboard());
    state.focus = 'content';
    const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, '');
    for (const [index, text] of [[0, 'done thing'], [1, 'テスト Issue']] as const) {
      state.contentSelectedIndex = index;
      const doc = renderDashboard(state, 110);
      checkWidth(doc.lines, 110);
      assert.equal(doc.actions.length, 3);
      assert.match(strip(doc.lines[doc.selectedRow]!), new RegExp('▌ [^│]*' + text));
      // Both items share one row; the overview is not repeated as a second list.
      assert.equal(doc.lines.filter(line => strip(line).includes('done thing')).length, 1);
    }
    state.contentSelectedIndex = 2;
    const doc = renderDashboard(state, 110);
    assert.match(strip(doc.lines[doc.selectedRow]!), /▌ \+  New repository-free work/);
  });
});
