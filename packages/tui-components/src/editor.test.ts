import assert from 'node:assert/strict';
import test from 'node:test';
import { CURSOR_MARKER } from '@earendil-works/pi-tui';
import { fitEditorLines, PasteTracker } from './editor.js';

test('pads short editors above the bottom border and crops long ones around the cursor', () => {
  assert.deepEqual(fitEditorLines(['top', 'a', 'bottom'], 5), ['top', 'a', '', '', 'bottom']);
  const lines = ['top', ...Array.from({ length: 8 }, (_, row) => 'row' + row), 'bottom'];
  assert.deepEqual(fitEditorLines(lines, 4), ['top', 'row5', 'row6', 'bottom'], 'unfocused stays near the end');
  lines[3] += CURSOR_MARKER;
  assert.deepEqual(fitEditorLines(lines, 4), ['top', lines[3], 'row3', 'bottom']);
});

test('tracks a bracketed paste across chunks', () => {
  const paste = new PasteTracker();
  assert.equal(paste.feed('\r'), false);
  assert.equal(paste.feed('\x1b[200~one'), true);
  assert.equal(paste.feed('\r'), true);
  assert.equal(paste.feed('two\x1b[201~'), true);
  assert.equal(paste.feed('\r'), false);
});
