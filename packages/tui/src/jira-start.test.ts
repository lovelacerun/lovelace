import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, type LovelaceClient } from '@lovelace/client';
import type { DashboardJiraIssue, RepoRecord } from '@lovelace/core';
import { AppState } from './state.js';
import { filterRepositories } from './jira-start.js';
import { submitLaunch } from './controller.js';

const issue: DashboardJiraIssue = { id: '42', key: 'PROJ-42', title: 'Fix sync', url: 'https://jira.invalid/42', status: 'To Do', issueType: 'Task', updatedAt: '' };
const repositories: RepoRecord[] = [
  { id: '1', provider: 'github', externalId: '1', name: 'sync', fullName: 'org/sync', cloneUrl: '', defaultBranch: 'main', isArchived: false, topics: ['infra', 'typescript'], lastSyncedAt: '' },
  { id: '2', provider: 'github', externalId: '2', name: 'sync-client', fullName: 'other/sync-client', cloneUrl: '', defaultBranch: 'main', isArchived: false, topics: ['examplecom'], lastSyncedAt: '' },
  { id: '3', provider: 'github', externalId: '3', name: 'website', fullName: 'org/website', cloneUrl: '', defaultBranch: 'main', isArchived: true, topics: [], lastSyncedAt: '' },
];
const templates = [{ id: 'refine', title: 'Refine', content: 'Refine {{title}}', builtIn: true, overridden: true }];
function stateForIssue() {
  const state = new AppState({ onInvalidate() {} });
  state.view = 'jira';
  state.selectedJira = issue;
  return state;
}
function client(overrides: Partial<LovelaceClient> = {}): LovelaceClient {
  return {
    getRepositories: async () => repositories,
    getPromptTemplates: async () => templates,
    getJiraIssues: async () => [{ ...issue, descriptionText: 'Full description' }],
    renderPrompt: async () => ({ promptId: 'refine', content: 'Rendered prompt' }),
    ...overrides,
  } as unknown as LovelaceClient;
}

test('repository name/topic filters combine and never exclude topic-free or archived repositories by default', () => {
  const ids = (query: string) => filterRepositories(repositories, query).map(repo => repo.id);
  assert.deepEqual(ids(''), ['1', '2', '3']);
  assert.deepEqual(ids('SYNC'), ['1', '2']);
  assert.deepEqual(ids('sync topic:INFRA,examplecom'), ['1', '2']);
  assert.deepEqual(ids('topic:infra topic:typescript'), ['1']);
  assert.deepEqual(ids('other/ topic:examplecom'), ['2']);
  assert.deepEqual(ids('website'), ['3']);
  assert.deepEqual(ids('topic:core'), []);
  assert.deepEqual(ids('topic:missing'), []);
});

test('a lost reply resends the Jira request with its repositories and template; any answer hands it to the server', async () => {
  const state = stateForIssue();
  const key = state.draftKey;
  const jiraIssueId = state.selectedJira!.id;
  state.setDraft({ text: '  Edited\n', repoIds: ['1', '2'], promptId: 'refine' });
  const calls: unknown[] = [];
  let attempt = 0;
  const api = client({
    quickStart: async (prompt, jiraIssueId, _agent, _overrides, requestId, options) => {
      calls.push({ prompt, jiraIssueId, requestId, repoIds: options?.repoIds, promptId: options?.promptId });
      if (++attempt === 1) throw new ApiError(0, 'lost reply');
      return { details: { workItem: { id: 'work' }, attachments: [], launches: [] }, launch: { state: 'failed', error: 'install failed' } } as never;
    },
  });
  const deps = { client: api, refreshDashboard() {}, newRequestId: () => String(attempt) };
  await submitLaunch(state, deps, state.draft.text);
  assert.equal(state.draft.requestId, '0');
  await submitLaunch(state, deps, state.draft.text);
  assert.deepEqual(calls[1], calls[0]);
  assert.deepEqual(calls[0], { prompt: '  Edited\n', jiraIssueId, requestId: '0', repoIds: ['1', '2'], promptId: 'refine' });
  assert.equal(state.view, 'work-item');
  assert.equal(state.selectedWorkItemId, 'work');
  assert.deepEqual(state.drafts.get(key), { text: '', repoIds: undefined, promptId: undefined, requestId: undefined });
});
