import assert from 'node:assert/strict';
import { it } from 'node:test';
import { AppState } from './state.js';
import { decode } from './keymap.js';

it('tabs through detail actions before sidebar, and reverses with Shift+Tab', () => {
  const state = new AppState({ onInvalidate() {} });
  state.navigateToWorkItem('work');
  const stops: Array<[string, number]> = [];
  for (let i = 0; i < 5; i++) {
    stops.push([state.focus, state.contentSelectedIndex]);
    state.toggleFocus(4);
  }
  assert.deepEqual(stops, [['content', 0], ['content', 1], ['content', 2], ['content', 3], ['sidebar', 3]]);
  assert.equal(state.focus, 'content');
  assert.equal(state.contentSelectedIndex, 0);
  for (const [focus, index] of stops.slice(1).reverse()) {
    state.toggleFocus(4, -1);
    assert.equal(state.focus, focus);
    if (focus === 'content') assert.equal(state.contentSelectedIndex, index);
  }
});

it('Jira details tab through actions and sidebar without a hidden editor', () => {
  const state = new AppState({ onInvalidate() {} });
  state.view = 'jira';
  state.toggleFocus(2);
  assert.equal(state.contentSelectedIndex, 1);
  state.toggleFocus(2);
  assert.equal(state.focus, 'sidebar');
  state.toggleFocus(2);
  assert.equal(state.focus, 'content');
  assert.equal(state.contentSelectedIndex, 0);
});

it('Home preserves focus-group navigation; empty detail views and stale indices stay bounded', () => {
  const state = new AppState({ onInvalidate() {} });
  state.toggleFocus(5);
  assert.equal(state.focus, 'sidebar');
  state.toggleFocus(5, -1);
  assert.equal(state.focus, 'content');
  state.navigateToWorkItem('work');
  state.contentSelectedIndex = 99;
  state.toggleFocus(2);
  assert.equal(state.focus, 'sidebar');
  state.toggleFocus(0, -1);
  assert.equal(state.focus, 'content');
  assert.equal(state.contentSelectedIndex, 0);
  state.pendingConfirm = { kind: 'state', state: 'done' };
  state.toggleFocus(0);
  assert.equal(state.pendingConfirm, null);
});

it('decodes Shift+Tab in content, sidebar and editor without stealing pasted text', () => {
  for (const focus of ['content', 'sidebar', 'editor'] as const) {
    assert.deepEqual(decode('\x1b[Z', { focus }), { kind: 'tab', direction: -1 });
    assert.deepEqual(decode('\t', { focus }), { kind: 'tab' });
  }
});
