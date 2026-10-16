import assert from 'node:assert/strict';
import { it } from 'node:test';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import type { TuiAltScreen } from '@earendil-works/pi-tui';
import type { LovelaceClient } from '@lovelace/client';
import type { DashboardResponse, WorkItemDetails } from '@lovelace/core';
import { AppRoot } from './app.js';

const dashboard: DashboardResponse = {
  activeWorkItems: [], pendingJiraIssues: [],
  recent: { since: '', workItems: [], sessionCount: 0, completedCount: 0, activityCount: 0 },
  settings: { defaultAgent: 'pi', sidebarSide: 'right', repositoryTopics: [] },
  freshness: { jiraFetchedAt: null, githubFetchedAt: null, jiraStale: false, githubStale: false },
};
const details: WorkItemDetails = {
  workItem: { id: 'work', title: 'Linked work', state: 'active', notes: null, createdAt: '', updatedAt: '', startedAt: null, completedAt: null },
  metas: [
    { key: 'PROJ-1', title: 'A long Jira title '.repeat(8), url: 'https://jira.example/browse/PROJ-1' },
    { key: 'PROJ-2', title: 'Second ticket', url: 'https://jira.example/browse/PROJ-2' },
    { number: 12, repoFullName: 'example/service', url: 'https://github.com/example/service/pull/12' },
    { number: 13, repoFullName: 'example/service', url: 'https://github.com/example/service/pull/13' },
  ].map((data, index) => ({
    id: String(index), workItemId: 'work', metaType: index < 2 ? 'tracker-item' : 'pull-request', provider: index < 2 ? 'jira' : 'github',
    externalId: String(index), payloadJson: JSON.stringify(data), createdAt: '', updatedAt: '',
  })),
};

for (const columns of [50, 80, 120]) {
  it(`Tabs to Jira/PR cards, scrolls selection into view and opens only on Enter at ${columns} columns`, async t => {
    let input: (data: string) => unknown = () => {};
    const opened: string[] = [];
    const tui = {
      terminal: { columns, rows: 24 }, requestRender() {}, start() {}, stop() {}, setFocus() {},
      addInputListener(listener: (data: string) => unknown) { input = listener; return () => { input = () => {}; }; },
    } as unknown as TuiAltScreen;
    const client = { serverUrl: 'http://localhost:4747', getDashboard: async () => dashboard, getWorkItem: async () => details } as unknown as LovelaceClient;
    let fail = false;
    const root = new AppRoot({ tui, client, openUrl: async url => {
      if (fail) throw new Error('Browser unavailable');
      opened.push(url);
    } });
    root.state.navigateToWorkItem('work');
    const done = root.start();
    t.after(async () => { root.quit(); await done; });
    // Pollers use the fixture client only, never providers or live sessions.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(root.state.selectedWorkItemData?.workItem.id, 'work');
    for (const [index, label] of ['PROJ-1', 'PROJ-2', '#12', '#13'].entries()) {
      if (index > 0) input('\t');
      assert.equal(root.state.contentSelectedIndex, index);
      assert.equal(root.state.focus, 'content');
      const frame = root.render(columns).map(stripTerminalSequences).join('\n');
      assert.ok(frame.includes('› ' + label), frame);
      assert.equal(opened.length, index);
      input('\r');
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(opened.at(-1), JSON.parse(details.metas[index]!.payloadJson!).url);
    }
    input('\x1b[Z');
    assert.equal(root.state.contentSelectedIndex, 2);
    assert.ok(root.render(columns).map(stripTerminalSequences).join('\n').includes('› #12'));
    fail = true;
    input('\r');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(root.state.error, 'Browser unavailable');
    assert.equal(root.state.offline, false);
    assert.equal(opened.length, 4);
  });
}
