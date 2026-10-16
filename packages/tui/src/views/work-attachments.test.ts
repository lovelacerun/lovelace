import assert from 'node:assert/strict';
import { it } from 'node:test';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import type { WorkItemDetails } from '@lovelace/core';
import { AppState } from '../state.js';
import { DocumentBuilder } from './common.js';
import { jiraCardBg, prCardBg, success, danger, reset, selectedBg } from '../theme.js';
import { renderAttachments } from './work-attachments.js';

type Meta = WorkItemDetails['metas'][number];
function meta(metaType: Meta['metaType'], data: Record<string, unknown>): Meta {
  return { id: 'meta', workItemId: 'work', metaType, externalId: 'ref', payloadJson: JSON.stringify(data), provider: null, createdAt: '', updatedAt: '' };
}
const jira = meta('tracker-item', { key: 'PROJ-1471', title: 'Regenerate the audio narration', status: 'In Review' });
const pr = meta('pull-request', { repoFullName: 'examplecom/text-to-speech', number: 374, status: 'draft', reviewDecision: 'APPROVED', buildStatus: 'success' });
const plain = (lines: string[]) => lines.map(stripTerminalSequences).join('\n');

it('uses separate padded provider surfaces and space between entries', () => {
  const lines = renderAttachments([jira, jira, pr, pr], 100);
  assert.match(plain(lines), /◆  Attached Jira  2/);
  assert.match(plain(lines), /↗  Pull requests  2/);
  assert.match(plain(lines), /#374  ◇ Draft/);
  assert.match(plain(lines), /✓ Approved  ✓ Build passed/);
  assert.ok(!plain(lines).includes('Status:'));
  const bands = lines.filter(line => line.includes(jiraCardBg));
  assert.equal(bands.length, 10);
  for (const band of bands) {
    assert.ok(band.includes(prCardBg));
    assert.ok(band.endsWith(reset + ' '), 'outside margin must use the terminal background');
  }
  assert.ok(bands.some(line => line.includes(reset + jiraCardBg)), 'inline resets must restore the Jira surface');
  assert.ok(bands.some(line => line.includes(reset + prCardBg)), 'inline resets must restore the PR surface');
  const entries = lines.map((line, index) => line.includes('#374') ? index : -1).filter(index => index >= 0);
  assert.equal(lines[entries[1]! - 2]?.trim(), '');
  assert.ok(lines.some(line => line.includes(success + '✓ Approved')));
});

for (const width of [31, 50, 63, 64, 65, 80, 120]) {
  it(`fits ${width} columns with long Unicode input and all status labels preserved`, () => {
    const wideJira = meta('tracker-item', { key: 'PROJ-1', title: 'テスト 🚀 '.repeat(12), status: 'In Progress' });
    const widePr = meta('change-request', { repoFullName: 'examplecom/' + '長い名前'.repeat(6), number: 381, status: 'open', reviewDecision: 'CHANGES_REQUESTED', buildStatus: 'failure' });
    const lines = renderAttachments([wideJira, widePr], width);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, JSON.stringify(line));
    // Wrapping may split labels, but may not elide them.
    const compact = plain(lines).replace(/[\s│]/g, '');
    assert.ok(compact.includes('Changesrequested'));
    assert.ok(compact.includes('Buildfailed'));
    assert.ok(lines.some(line => line.includes(danger + '×')));
  });
}

it('keeps the padded square surfaces without any outlines', () => {
  const lines = renderAttachments([jira], 50).map(stripTerminalSequences);
  assert.equal(lines[2], ' '.repeat(50));
  assert.equal(lines[3], '   PROJ-1471' + ' '.repeat(38));
  assert.equal(lines[6], ' '.repeat(50));
  assert.ok(!plain(lines).match(/[╭╮╰╯│─]/));
});

it('stacks providers on narrow terminals and keeps empty states honest', () => {
  const lines = renderAttachments([jira, pr], 50);
  assert.ok(lines.findIndex(line => line.includes('#374')) > lines.findIndex(line => line.includes('PROJ-1471')));
  assert.equal(plain(renderAttachments([], 80)).match(/None attached\./g)?.length, 2);
  const unknown = plain(renderAttachments([meta('pull-request', {})], 80));
  assert.match(unknown, /Review unknown/);
  assert.match(unknown, /Build unknown/);
});

it('normalizes provider status casing without treating unknown as a warning', () => {
  const lines = renderAttachments([meta('pull-request', { ...JSON.parse(pr.payloadJson!), reviewDecision: 'approved', buildStatus: 'SUCCESS' })], 100);
  assert.match(plain(lines), /✓ Approved  ✓ Build passed/);
  assert.ok(lines.some(line => line.includes(success + '✓ Build passed')));
});

for (const width of [31, 50, 64, 80, 120]) {
  it(`tracks each linked card's actual row and focus at ${width} columns`, () => {
    const state = new AppState({ onInvalidate() {} });
    state.focus = 'content';
    const linked = [
      meta('tracker-item', { ...JSON.parse(jira.payloadJson!), url: 'https://jira.example/browse/PROJ-1471' }),
      meta('pull-request', { ...JSON.parse(pr.payloadJson!), url: 'https://github.com/example/service/pull/374' }),
    ];
    for (const selected of [0, 1]) {
      state.contentSelectedIndex = selected;
      const builder = new DocumentBuilder(state, width);
      builder.line('Header');
      for (const line of renderAttachments(linked, width, builder)) builder.line(line);
      const doc = builder.build();
      assert.deepEqual(doc.actions, linked.map(item => ({ kind: 'open-url', url: JSON.parse(item.payloadJson!).url })));
      assert.match(stripTerminalSequences(doc.lines[doc.selectedRow]!), selected === 0 ? /› PROJ-1471/ : /› #374/);
      assert.ok(doc.lines[doc.selectedRow]!.includes(selectedBg));
      for (const line of doc.lines) assert.ok(visibleWidth(line) <= width);
    }
  });
}

it('does not register missing or unsafe provider URLs', () => {
  const builder = new DocumentBuilder(new AppState({ onInvalidate() {} }), 80);
  renderAttachments([jira, meta('pull-request', { url: 'javascript:alert(1)' })], 80, builder);
  assert.deepEqual(builder.actions, []);
});

it('sanitizes provider text before applying styling', () => {
  const lines = renderAttachments([
    meta('tracker-item', { key: 'PROJ-1', title: 'bad\x1b[41mred\x1b[0m title', status: '\x1b[2JIn Review' }),
    meta('pull-request', { repoFullName: 'bad\x1b]0;title\x07/repo', reviewDecision: '\x1b[41mcustom', buildStatus: '\x1b[2Jcustom' }),
  ], 100);
  for (const line of lines) {
    assert.ok(!line.includes('\x1b[41m'));
    assert.ok(!line.includes('\x1b[2J'));
    assert.ok(!line.includes('\x1b]'));
  }
});
