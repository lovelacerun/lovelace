import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decode } from './keymap.js';

describe('keymap.decode', () => {
  it('returns editor-input for ordinary characters when editor is focused', () => {
    const intent = decode('q', { focus: 'editor' });
    assert.deepEqual(intent, { kind: 'editor-input', data: 'q' });
  });

  it('returns editor-input for j and n when editor is focused', () => {
    assert.deepEqual(decode('j', { focus: 'editor' }), { kind: 'editor-input', data: 'j' });
    assert.deepEqual(decode('n', { focus: 'editor' }), { kind: 'editor-input', data: 'n' });
  });

  it('quits on q when editor is not focused', () => {
    assert.deepEqual(decode('q', { focus: 'content' }), { kind: 'quit' });
    assert.deepEqual(decode('q', { focus: 'sidebar' }), { kind: 'quit' });
  });

  it('quits on Ctrl+C regardless of focus', () => {
    assert.deepEqual(decode('\x03', { focus: 'editor' }), { kind: 'quit' });
    assert.deepEqual(decode('\x03', { focus: 'content' }), { kind: 'quit' });
  });

  it('maps j/k and arrow keys to down/up when not editing', () => {
    assert.deepEqual(decode('j', { focus: 'content' }), { kind: 'down' });
    assert.deepEqual(decode('k', { focus: 'content' }), { kind: 'up' });
    assert.deepEqual(decode('\x1b[A', { focus: 'content' }), { kind: 'up' });
    assert.deepEqual(decode('\x1b[B', { focus: 'content' }), { kind: 'down' });
  });

  it('decodes Tab, Enter and Escape', () => {
    assert.deepEqual(decode('\t', { focus: 'content' }), { kind: 'tab' });
    assert.deepEqual(decode('\r', { focus: 'content' }), { kind: 'enter' });
    assert.deepEqual(decode('\x1b', { focus: 'content' }), { kind: 'escape' });
  });

  it('maps r to refresh and n to focus-editor', () => {
    assert.deepEqual(decode('r', { focus: 'content' }), { kind: 'refresh' });
    assert.deepEqual(decode('n', { focus: 'content' }), { kind: 'focus-editor' });
  });

  it('maps d/a/c to state shortcuts', () => {
    assert.deepEqual(decode('d', { focus: 'content' }), { kind: 'state-shortcut', target: 'done' });
    assert.deepEqual(decode('a', { focus: 'content' }), { kind: 'state-shortcut', target: 'active' });
    assert.deepEqual(decode('c', { focus: 'content' }), { kind: 'state-shortcut', target: 'cancelled' });
  });

  it('returns confirm-y only when confirmation is pending', () => {
    assert.deepEqual(decode('y', { focus: 'content', pendingConfirm: true }), { kind: 'confirm-y' });
    assert.deepEqual(decode('y', { focus: 'content' }), { kind: 'ignored' });
  });

  it('accepts only y, n and Esc while confirmation is pending', () => {
    const pending = { focus: 'content' as const, pendingConfirm: true };
    assert.deepEqual(decode('n', pending), { kind: 'escape' });
    assert.deepEqual(decode('\x1b', pending), { kind: 'escape' });
    for (const key of ['q', 'd', 'j', '\r', '\t']) assert.deepEqual(decode(key, pending), { kind: 'ignored' });
    assert.deepEqual(decode('\x03', pending), { kind: 'quit' });
  });

  it('intercepts Esc even when editor is focused', () => {
    assert.deepEqual(decode('\x1b', { focus: 'editor' }), { kind: 'escape' });
  });
});
