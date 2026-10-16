import assert from 'node:assert/strict';
import { test } from 'node:test';
import { visibleWidth, stripTerminalSequences } from '@earendil-works/pi-tui';
import { AppState, type PendingConfirm } from './state.js';
import { renderConfirmDialog } from './compositor.js';

const fixtures: Array<{ confirm: PendingConfirm; question: RegExp }> = [
  { confirm: { kind: 'state', state: 'active' }, question: /Reactivate this work\?/ },
  { confirm: { kind: 'state', state: 'done' }, question: /Mark this work done\?/ },
  { confirm: { kind: 'state', state: 'cancelled' }, question: /Cancel this work\?/ },
  { confirm: { kind: 'launch-abandon', draftKey: 'home' }, question: /Discard the unresolved launch\?/ },
];
for (const fixture of fixtures) for (const cols of [50, 80, 120]) {
  test(`${fixture.confirm.kind} dialog keeps its question and keys at ${cols} columns`, () => {
    const state = new AppState({ onInvalidate() {} });
    state.pendingConfirm = fixture.confirm;
    const lines = renderConfirmDialog(state, cols);
    const width = visibleWidth(lines[0]!);
    assert.ok(width <= cols - 4);
    assert.ok(lines.every(line => visibleWidth(line) === width));
    const plain = lines.map(line => stripTerminalSequences(line)).join('\n');
    assert.match(plain.replace(/[│\s]+/g, ' '), fixture.question);
    assert.match(plain, /y confirm {3}Esc cancel/);
  });
}

test('no dialog without a pending confirmation', () => {
  assert.deepEqual(renderConfirmDialog(new AppState({ onInvalidate() {} }), 80), []);
});
