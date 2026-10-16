import assert from 'node:assert/strict';
import test from 'node:test';
import { getOsc8LinkAtColumn, stripTerminalSequences, type TuiAltScreen, type TuiMouseEvent } from '@earendil-works/pi-tui';
import type { LovelaceClient } from '@lovelace/client';
import { CODING_HARNESSES, type AvailableHarness, type DashboardJiraIssue, type PromptTemplate, type RepoRecord } from '@lovelace/core';
import { AppState } from './state.js';
import { JiraStartModal } from './jira-start-modal.js';
import { parseClickTarget } from './clickable.js';
import { visibleWidth } from '@earendil-works/pi-tui';
import { safeText } from '@lovelace/tui-components';

const issue: DashboardJiraIssue = { id: '42', key: 'PROJ-42', title: 'Fix sync', url: 'https://jira.invalid/42', status: 'To Do', issueType: 'Task', updatedAt: '' };
const repositories: RepoRecord[] = ['sync', 'client', 'old'].map((name, index) => ({
  id: String(index), provider: 'github', externalId: String(index), name, fullName: `org/${name}`,
  cloneUrl: '', defaultBranch: 'main', isArchived: index === 2,
  topics: [index ? 'examplecom' : 'infra'], lastSyncedAt: '',
}));
const templates: PromptTemplate[] = ['implement', 'refine'].map(id => ({ id, title: id === 'implement' ? 'Implement' : 'Refine', content: '{{title}}', builtIn: true, overridden: id === 'refine' }));
const tools: AvailableHarness[] = (['pi', 'claude'] as const).map((id, index) => ({
  id, title: id === 'pi' ? 'Pi' : 'Claude Code', thinkingLevels: CODING_HARNESSES.find(entry => entry.id === id)!.thinkingLevels,
  executablePath: `/fixture/${id}`, defaultSelected: index === 0, models: id === 'claude' ? [{ id: 'opus' }, { id: 'sonnet' }] : [],
}));
function api(overrides: Partial<LovelaceClient> = {}): LovelaceClient {
  return {
    getRepositories: async () => repositories,
    getPromptTemplates: async () => templates,
    getJiraIssues: async () => [{ ...issue, descriptionText: 'Full description' }],
    renderPrompt: async input => ({ promptId: input.promptId, content: `  ${input.promptId} prompt\n` }),
    syncRepositories: async () => ({ ok: true, repoCount: repositories.length, repos: repositories }),
    getTools: async () => tools,
    ...overrides,
  } as LovelaceClient;
}
function fixture(client = api(), text = '', repositoryTopics = ['infra', 'examplecom']) {
  const state = new AppState({ onInvalidate() {} });
  state.applyDashboardResponse({
    activeWorkItems: [], pendingJiraIssues: [issue],
    recent: { since: '', workItems: [], sessionCount: 0, completedCount: 0, activityCount: 0 },
    settings: { defaultAgent: 'pi', sidebarSide: 'right', repositoryTopics },
    freshness: { jiraFetchedAt: null, githubFetchedAt: null, jiraStale: false, githubStale: false },
  });
  state.view = 'jira'; state.selectedJira = issue;
  state.setDraft({ text });
  const terminal = { columns: 120, rows: 36 };
  const tui = { terminal, requestRender() {} } as unknown as TuiAltScreen;
  const lifetime = new AbortController();
  const starts: string[] = [];
  let closes = 0;
  const modal = new JiraStartModal({
    tui, state, client, signal: lifetime.signal, onClose: () => { closes++; },
    onStart: async prompt => { starts.push(prompt); },
  });
  return { modal, state, terminal, lifetime, starts, closes: () => closes };
}

test('loads full Jira context and a default template in the same dialog; selections survive separate filters', async () => {
  const f = fixture(api({ renderPrompt: async input => {
    assert.equal(input.title, 'PROJ-42: Fix sync');
    assert.equal((input.sources![0]!.payload as { descriptionText: string }).descriptionText, 'Full description');
    return { promptId: input.promptId, content: '  Editable preview\n' };
  } }));
  await f.modal.load();
  assert.equal(f.state.view, 'jira');
  assert.equal(f.state.draft.promptId, 'implement');
  assert.equal(f.state.draft.text, '  Editable preview\n');
  assert.equal(f.modal.focus, 'repositories');
  assert.deepEqual(f.modal.visibleRepositories.map(repo => repo.id), ['0', '1']);
  f.modal.handleInput(' ');
  f.modal.handleInput('/'); f.modal.handleInput('client');
  f.modal.handleInput('\r'); f.modal.handleInput('t'); f.modal.handleInput('\x15'); f.modal.handleInput('examplecom');
  f.modal.handleInput('\r'); f.modal.handleInput('\x1b[32u');
  assert.deepEqual(f.state.draft.repoIds, ['0', '1']);
  assert.equal(f.modal.visibleRepositories.length, 1);
  assert.equal(f.modal.visibleRepositories[0]!.name, 'client');
  f.modal.nameFilter.setValue(''); f.modal.topicFilter.setValue('');
  f.modal.handleInput('a');
  assert.equal(f.modal.visibleRepositories.length, 3, 'archived repos can explicitly be included');
  await f.modal.chooseTemplate('refine');
  assert.deepEqual(f.state.draft.repoIds, ['0', '1']);
  await f.modal.chooseTemplate();
  assert.equal(f.state.draft.promptId, undefined);
  assert.equal(f.state.draft.text, '  Editable preview\n', 'manual prompt preserves edits');
  f.modal.dispose();
});

test('topic defaults come from server settings and remain editable, including an empty default', async () => {
  for (const defaults of [['infra'], ['examplecom'], []]) {
    const f = fixture(api(), 'Draft', defaults);
    await f.modal.load();
    assert.equal(f.modal.topicFilter.getValue(), defaults.join(', '));
    assert.deepEqual(f.modal.visibleRepositories.map(repo => repo.id), defaults.length ? [defaults[0] === 'infra' ? '0' : '1'] : ['0', '1']);
    f.modal.focus = 'topics';
    f.modal.handleInput('\x15'); // Native input clears the topic filter.
    assert.equal(f.modal.topicFilter.getValue(), '');
    assert.equal(f.modal.visibleRepositories.length, 2);
    f.modal.dispose();
  }
});

test('bulk controls select all filtered matches, preserve hidden selections, and unselect everything', async () => {
  const f = fixture(api(), 'Draft', ['infra']);
  await f.modal.load();
  f.modal.repositories = Array.from({ length: 18 }, (_, i) => ({
    ...repositories[i % 3]!, id: String(i), name: `repo-${i}`, fullName: `org/repo-${i}`,
  }));
  f.modal.toggleRepository('1'); // Hidden by the configured topic filter.
  f.terminal.rows = 12;
  assert.match(f.modal.render(64).map(line => safeText(line)).join('\n'), /\[All\] \[None\]/);
  // Narrow dialogs show the focused repository pane alone, at full width.
  const narrow = f.modal.render(48).map(line => safeText(line)).join('\n');
  assert.match(narrow, /\[ Select all \] \[ Unselect all \]/);
  assert.doesNotMatch(narrow, /Template:/);
  f.modal.handleInput('\x01'); // Ctrl+A includes matches outside the viewport.
  assert.deepEqual(f.state.draft.repoIds, ['1', '0', '3', '6', '9', '12', '15']);
  f.modal.handleInput('\x01');
  assert.equal(f.state.draft.repoIds!.length, 7, 'bulk selection does not duplicate IDs');
  f.modal.topicFilter.setValue('');
  f.modal.nameFilter.setValue('repo-2');
  f.modal.handleInput('\x01');
  assert.equal(f.state.draft.repoIds!.length, 7, 'archived matches remain excluded');
  f.modal.handleInput('a');
  f.modal.focus = 'topics';
  f.modal.handleInput('\t');
  assert.equal(f.modal.focus, 'selection');
  f.modal.handleInput('\r');
  assert.ok(f.state.draft.repoIds!.includes('2'));
  f.modal.handleInput('\x1b[C');
  f.modal.handleInput(' ');
  assert.deepEqual(f.state.draft.repoIds, [], 'Unselect all also clears hidden selections');
  f.modal.focus = 'repositories';
  f.modal.handleInput('\x01');
  f.modal.handleInput('\x15');
  assert.deepEqual(f.state.draft.repoIds, []);
  f.modal.dispose();
});

test('bulk selection rejects more than 100 atomically and cannot mutate frozen launch selections', async () => {
  const f = fixture(api(), 'Draft', []);
  await f.modal.load();
  f.modal.repositories = Array.from({ length: 101 }, (_, i) => ({ ...repositories[0]!, id: String(i) }));
  f.modal.toggleRepository('0');
  f.modal.selectAll();
  assert.deepEqual(f.state.draft.repoIds, ['0']);
  assert.match(f.modal.error!, /at most 100/);
  f.modal.repositories.pop();
  f.modal.selectAll();
  assert.equal(f.state.draft.repoIds!.length, 100);
  const selected = [...f.state.draft.repoIds!];
  f.state.setDraft({ pendingLaunch: { endpoint: 'quickStart', prompt: 'Draft', requestId: 'frozen', repoIds: selected } });
  f.modal.unselectAll();
  f.modal.selectAll();
  assert.deepEqual(f.state.draft.repoIds, selected);
  f.modal.dispose();
});

test('Enter edits a multiline prompt; launch requires Start work or an explicit start shortcut', async () => {
  const f = fixture(api(), 'Exact text');
  await f.modal.load();
  f.modal.focus = 'prompt';
  f.modal.handleInput('\r'); f.modal.handleInput('q');
  assert.equal(f.state.draft.text, 'Exact text\nq');
  assert.deepEqual(f.starts, []);
  f.modal.handleInput('\x1b[200~\n  Pasted text\r\t\x1b[201~');
  const exact = f.modal.editor.getExpandedText();
  f.modal.handleInput('\x13');
  await Promise.resolve();
  assert.deepEqual(f.starts, [exact]);
  f.modal.handleInput('\x1b');
  assert.equal(f.closes(), 1);
  assert.equal(f.state.draft.text, exact);
  assert.equal(f.state.view, 'jira');
});

test('template changes cannot overwrite newer choices or subsequent manual editing', async () => {
  const pending: Array<(value: { promptId: string; content: string }) => void> = [];
  const f = fixture(api({ renderPrompt: () => new Promise(resolve => pending.push(resolve)) }), 'Existing draft');
  await f.modal.load();
  f.modal.focus = 'template';
  for (const key of ['\r', '\x1b[B', '\r']) f.modal.handleInput(key); // implement, rendering pending
  for (const key of ['\r', '\x1b[B', '\r']) f.modal.handleInput(key); // refine immediately, not implement again
  assert.equal(pending.length, 2);
  assert.match(f.modal.render(100).join('\n'), /Refine/);
  pending[1]!({ promptId: 'refine', content: 'Newer preview' }); await Promise.resolve();
  pending[0]!({ promptId: 'implement', content: 'Old preview' }); await Promise.resolve();
  assert.equal(f.state.draft.text, 'Newer preview');
  const third = f.modal.chooseTemplate('implement');
  f.modal.focus = 'prompt'; f.modal.handleInput('Edited');
  const edited = f.state.draft.text;
  pending[2]!({ promptId: 'implement', content: 'Late preview' }); await third;
  assert.equal(f.state.draft.text, edited);
  assert.equal(f.modal.renderingPrompt, false);
  f.modal.dispose();
});

test('close and abort ignore late catalog/template replies and never clobber another draft', async () => {
  let resolve!: (value: RepoRecord[]) => void;
  const f = fixture(api({ getRepositories: () => new Promise(finish => { resolve = finish; }) }));
  const loading = f.modal.load();
  f.modal.close(); f.state.navigateToDashboard(); f.state.setDraft({ text: 'Home draft' });
  resolve(repositories); await loading;
  assert.equal(f.state.repositories, null);
  assert.equal(f.state.draft.text, 'Home draft');
  assert.equal(f.closes(), 1);
  let render!: (value: { promptId: string; content: string }) => void;
  const g = fixture(api({ renderPrompt: () => new Promise(resolve => { render = resolve; }) }), 'Existing draft');
  await g.modal.load();
  const choosing = g.modal.chooseTemplate('refine');
  g.lifetime.abort();
  render({ promptId: 'refine', content: 'Late text' }); await choosing;
  assert.equal(g.state.draft.text, 'Existing draft');
  g.modal.dispose();
});

test('catalog failures retain last-good data and prompt preview; explicit refresh replaces the catalog only on success', async () => {
  let fail = true;
  const f = fixture(api({
    getRepositories: async () => { throw new Error('catalog read failed'); },
    syncRepositories: async () => {
      if (fail) throw new Error('GitHub refresh failed');
      return { ok: true, repoCount: 801, repos: Array.from({ length: 801 }, (_, i) => ({ ...repositories[0]!, id: String(i), fullName: `org/service-${i}` })) };
    },
  }));
  f.state.repositories = f.modal.repositories = repositories;
  await f.modal.load();
  assert.equal(f.state.draft.promptId, 'implement');
  assert.match(f.modal.error!, /catalog read failed/);
  await f.modal.refreshRepositories();
  assert.equal(f.modal.repositories, repositories);
  assert.match(f.modal.error!, /GitHub refresh failed/);
  fail = false;
  await f.modal.refreshRepositories();
  assert.equal(f.modal.repositories.length, 801);
  assert.equal(f.state.repositories!.length, 801);
  f.modal.dispose();
});

test('the large prompt box uses its available viewport; narrow renders fit and catalog text is sanitized', async () => {
  const prompt = Array.from({ length: 24 }, (_, i) => `Prompt line ${i + 1}: 日報`).join('\n');
  const f = fixture(api(), prompt);
  await f.modal.load();
  f.modal.repositories = [{ ...repositories[0]!, name: '\x1b[2Jsync', fullName: 'org/\x1b[2Jsync', topics: ['infra\x1b[2J'] }];
  for (const [columns, rows] of [[50, 12], [80, 24], [120, 36]]) {
    f.terminal.columns = columns!; f.terminal.rows = rows!;
    const lines = f.modal.render(columns! - 2);
    assert.ok(lines.length <= rows! - 2);
    assert.ok(lines.every(line => visibleWidth(line) <= columns! - 2));
    assert.ok(lines.every(line => !line.includes('\x1b[2J')));
    if (rows! >= 24) assert.match(lines.map(line => safeText(line)).join('\n'), /Prompt line 9/);
  }
  f.modal.focus = 'prompt';
  f.modal.editor.handleInput('\x1b[1;5H');
  const expanded = f.modal.render(118).map(line => safeText(line)).join('\n');
  assert.match(expanded, /Prompt line 15/, 'native editor is not capped to the dashboard-sized seven-line viewport');
  f.modal.dispose();
});

test('column separators connect to the frame and align with the body divider after resize and focus changes', async () => {
  const f = fixture(api(), 'Prompt with 日報 and e\u0301');
  await f.modal.load();
  f.modal.repositories = [{ ...repositories[0]!, name: '日報'.repeat(80), topics: ['infra'.repeat(80)] }];
  for (const [columns, rows] of [[80, 24], [120, 36], [50, 12], [81, 25]]) {
    f.terminal.columns = columns!; f.terminal.rows = rows!;
    const width = columns! - 2;
    for (const focus of ['repositories', 'name', 'topics', 'selection', 'template', 'prompt', 'actions'] as const) {
      f.modal.focus = focus;
      const rendered = f.modal.render(width);
      assert.ok(rendered.every(line => visibleWidth(line) === width));
      const lines = rendered.map(line => safeText(line));
      assert.equal(lines[0], '╭' + '─'.repeat(width - 2) + '╮');
      assert.equal(lines.at(-1), '╰' + '─'.repeat(width - 2) + '╯');
      assert.ok(lines.slice(1, -1).every(line => line.startsWith('│') && line.endsWith('│') || line.startsWith('├') && line.endsWith('┤')));
      const top = lines.findIndex(line => line.includes('┬'));
      if (top < 0) continue; // Short terminals omit the separator rows.
      const bottom = lines.findIndex(line => line.includes('┴'));
      const dividerColumn = lines[top]!.indexOf('┬');
      assert.equal(lines[bottom]!.indexOf('┴'), dividerColumn);
      assert.match(lines[top]!, /^├─+┬─+┤$/);
      assert.match(lines[bottom]!, /^├─+┴─+┤$/);
      for (const line of lines.slice(top + 1, bottom)) {
        // Measure terminal columns, not code units (repository names can be wide).
        const divider = line.indexOf(' │ ');
        assert.ok(divider >= 0);
        assert.equal(visibleWidth(line.slice(0, divider + 1)), dividerColumn);
      }
    }
  }
  f.modal.dispose();
});

test('failed template rendering keeps the edited prompt and empty prompts never launch', async () => {
  const f = fixture(api({ renderPrompt: async () => { throw new Error('render failed'); } }), '  Keep text\n');
  await f.modal.load();
  await f.modal.chooseTemplate('refine');
  assert.equal(f.state.draft.text, '  Keep text\n');
  assert.match(f.modal.error!, /render failed/);
  f.modal.editor.setText('   ');
  await f.modal.start();
  assert.deepEqual(f.starts, []);
  assert.equal(f.modal.focus, 'prompt');
  f.modal.dispose();
});

test('mouse: clicked controls toggle repositories, pick templates, focus fields and start', async () => {
  const f = fixture();
  await f.modal.load();
  const click = (text: string) => {
    const line = f.modal.render(120).find(line => stripTerminalSequences(line).includes(text));
    const url = line && getOsc8LinkAtColumn(line, stripTerminalSequences(line).indexOf(text));
    const link = url ? parseClickTarget(url) : undefined;
    assert.ok(link, `no control under ${text}`);
    f.modal.openLink(link);
  };
  click('client');
  assert.deepEqual(f.state.draft.repoIds, ['1']);
  click('Select all');
  assert.deepEqual(f.state.draft.repoIds, ['1', '0']);
  click('Unselect all');
  assert.deepEqual(f.state.draft.repoIds, []);
  click('Implement ▾');
  assert.equal(f.modal.focus, 'template');
  click('Refine');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.draft.promptId, 'refine');
  click('Pi ▾');
  assert.equal(f.modal.focus, 'agent');
  click('Claude Code');
  assert.equal(f.state.launchAgent, 'claude');
  click('Name:');
  assert.equal(f.modal.focus, 'name');
  click('refine prompt');
  assert.equal(f.modal.focus, 'prompt');
  click('Start work ]');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.starts, ['  refine prompt\n']);
  click('Cancel');
  assert.equal(f.closes(), 1);
});

test('mouse: clicks move keyboard focus and provider prompts cannot forge controls', async () => {
  const f = fixture(api({ renderPrompt: async input => ({ promptId: input.promptId, content: 'x \x1b]8;;lovelace:modal:start\x1b\\click\x1b]8;;\x1b\\ y\n' }) }));
  await f.modal.load();
  assert.equal(f.state.draft.text, 'x click y\n');
  f.modal.openLink({ kind: 'modal', data: 'none' });
  f.modal.handleInput('\r');
  assert.deepEqual(f.state.draft.repoIds, [], 'Enter repeats the clicked Unselect all');
  f.modal.openLink({ kind: 'modal', data: 'template:toggle' });
  assert.equal(f.modal.focus, 'template');
});

test('the wheel scrolls the pane under the pointer', async () => {
  const f = fixture();
  await f.modal.load();
  f.modal.showArchived = true;
  const wheel = (x: number): TuiMouseEvent => ({
    type: 'wheel', button: 'none', x, y: 10, screenX: x, screenY: 10, width: 118, height: 30,
    shift: false, alt: false, ctrl: false, wheelDelta: 1,
  });
  f.modal.render(118);
  assert.equal(f.modal.handleMouse(wheel(5))?.handled, true);
  assert.equal(f.modal.selectedIndex, 1);
  f.modal.focus = 'prompt';
  f.modal.handleMouse(wheel(100));
  assert.equal(f.modal.selectedIndex, 1, 'the prompt pane does not move the repository list');
  f.modal.dispose();
});
