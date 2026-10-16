import assert from 'node:assert/strict';
import test from 'node:test';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import type { LovelaceClient } from '@lovelace/client';
import { CODING_HARNESSES, type AvailableHarness, type DashboardResponse, type ToolLaunchOptionsById } from '@lovelace/core';
import { AppState } from './state.js';
import { LaunchOptionsRow, type LaunchField } from './launch-options.js';
import { submitLaunch } from './controller.js';

const tools: AvailableHarness[] = (['pi', 'claude'] as const).map((id, index) => ({
  id, title: id === 'pi' ? 'Pi' : 'Claude Code', thinkingLevels: CODING_HARNESSES.find(entry => entry.id === id)!.thinkingLevels,
  executablePath: `/fixture/${id}`, defaultSelected: index === 0, models: id === 'claude' ? [{ id: 'opus' }, { id: 'sonnet' }] : [],
}));

function stateWith(defaultAgent: 'pi' | 'codex' = 'pi', detected: AvailableHarness[] | null = tools): AppState {
  const state = new AppState({ onInvalidate() {} });
  state.applyDashboardResponse({
    activeWorkItems: [], pendingJiraIssues: [],
    recent: { since: '', workItems: [], sessionCount: 0, completedCount: 0, activityCount: 0 },
    settings: { defaultAgent, sidebarSide: 'right', repositoryTopics: [] },
    freshness: { jiraFetchedAt: null, githubFetchedAt: null, jiraStale: false, githubStale: false },
  } satisfies DashboardResponse);
  if (detected) state.setTools(detected);
  return state;
}

const plain = (text: string) => stripTerminalSequences(text);

test('defaults to the configured agent when detected, else the first detected harness', () => {
  assert.equal(stateWith('pi').launchAgent, 'pi');
  assert.equal(stateWith('codex').launchAgent, 'pi', 'codex is not installed');
  assert.equal(stateWith('codex', null).launchAgent, 'codex', 'before detection the server default applies');
  assert.equal(stateWith('pi').launchToolOptions, undefined, 'harness defaults send no overrides');
});

const type = (row: LaunchOptionsRow, field: LaunchField, keys: string[]) => { for (const key of keys) row.handleInput(field, key); };
const ENTER = '\r', DOWN = '\x1b[B', UP = '\x1b[A', ESC = '\x1b';

test('each field expands into a list; Enter picks, and overrides are kept per harness', () => {
  const state = stateWith();
  const row = new LaunchOptionsRow(state);
  assert.match(plain(row.render(120)[0]!), /Agent\s+Pi ▾\s+Thinking\s+default ▾\s+Model\s+default ▾/);
  type(row, 'agent', [ENTER]);
  assert.deepEqual(plain(row.render(120, 'agent').join('\n')).split('\n').slice(2).map(line => line.trim()), ['• Pi', 'Claude Code']);
  type(row, 'agent', [DOWN, ENTER]);
  assert.equal(state.launchAgent, 'claude');
  assert.equal(row.openField, undefined);
  type(row, 'thinking', [ENTER, DOWN, ENTER]);
  // Models come from the harness catalog; typing filters them.
  type(row, 'model', [...'opu', ENTER]);
  assert.deepEqual(state.launchToolOptions, { claude: { thinkingLevel: 'low', model: 'opus' } });
  assert.match(plain(row.render(120)[0]!), /Claude Code ▾\s+Thinking\s+low ▾\s+Model\s+opus ▾/);

  type(row, 'agent', [ENTER, UP, ENTER]); // back to Pi, which keeps its own defaults
  assert.equal(state.launchAgent, 'pi');
  assert.equal(state.launchToolOptions, undefined);
  type(row, 'agent', [ENTER, DOWN, ENTER]);
  assert.deepEqual(state.launchToolOptions, { claude: { thinkingLevel: 'low', model: 'opus' } });
});

test('a model the catalog does not list can be typed; Esc and Tab leave the choice alone', () => {
  const state = stateWith();
  const row = new LaunchOptionsRow(state);
  type(row, 'model', [...'my-model']);
  assert.match(plain(row.render(120, 'model').join('\n')), /my-model\s+use as typed/);
  type(row, 'model', [ENTER]);
  assert.deepEqual(state.launchToolOptions, { pi: { model: 'my-model' } });
  type(row, 'model', [ENTER, UP]);
  assert.equal(row.handleInput('model', ESC), true, 'Esc closes the list');
  assert.equal(row.handleInput('model', ESC), false, 'a closed field leaves Esc to the host');
  type(row, 'model', [ENTER, UP]);
  assert.equal(row.handleInput('model', '\t'), false);
  assert.equal(row.openField, undefined);
  assert.deepEqual(state.launchToolOptions, { pi: { model: 'my-model' } });
  assert.equal(row.handleInput('model', '\x1b[C'), false, 'arrows no longer cycle');
});

test('clicks open a field and pick from its list; other links are not claimed', () => {
  const state = stateWith();
  const row = new LaunchOptionsRow(state);
  assert.equal(row.openLink('launch:agent:toggle'), 'agent');
  assert.equal(row.openField, 'agent');
  assert.equal(row.openLink('launch:agent:pick:1'), 'agent');
  assert.equal(state.launchAgent, 'claude');
  assert.equal(row.openLink('launch:thinking:toggle'), 'thinking');
  assert.equal(row.openLink('template:toggle'), undefined);
});

test('without detected harnesses the row says so and has nothing to open', () => {
  const state = stateWith('pi', []);
  const row = new LaunchOptionsRow(state);
  assert.equal(row.handleInput('agent', ENTER), false);
  assert.match(plain(row.render(80, 'agent')[0]!), /No coding harness detected/);
});

test('launches send the chosen harness and overrides, and the choice outlives the launch', async () => {
  const state = stateWith();
  new LaunchOptionsRow(state).openLink('launch:agent:pick:1');
  state.setLaunchOverrides({ thinkingLevel: 'high' });
  const calls: Array<{ agentId?: string; overrides?: ToolLaunchOptionsById }> = [];
  const client = {
    quickStart: async (_prompt: string, _jira?: string, agentId?: string, overrides?: ToolLaunchOptionsById) => {
      calls.push({ agentId, overrides });
      return { details: { workItem: { id: 'work' }, metas: [] }, launch: { ok: true, error: null } };
    },
  } as unknown as LovelaceClient;
  await submitLaunch(state, { client, refreshDashboard() {}, newRequestId: () => 'id-1' }, 'Do it');
  state.navigateToDashboard();
  await submitLaunch(state, { client, refreshDashboard() {}, newRequestId: () => 'id-2' }, 'Again');
  assert.deepEqual(calls, [
    { agentId: 'claude', overrides: { claude: { thinkingLevel: 'high' } } },
    { agentId: 'claude', overrides: { claude: { thinkingLevel: 'high' } } },
  ]);
});
