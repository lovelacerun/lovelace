import assert from 'node:assert/strict';
import { it } from 'node:test';
import { stripTerminalSequences, Text, visibleWidth } from '@earendil-works/pi-tui';
import { Card } from './card.js';

const reset = '\x1b[0m';
const green = '\x1b[32m';
const bg = '\x1b[48;5;236m';
const card = (child: Text) => {
  const card = new Card({ background: text => bg + text + reset });
  card.addChild(child);
  return card;
};

it('paints only the padded surface, not the outside margins', () => {
  const lines = card(new Text(green + '✓ Passed' + reset, 0, 0)).render(30);
  assert.equal(lines.length, 3);
  assert.equal(Card.contentWidth(30), 24);
  assert.equal(stripTerminalSequences(lines[1]!), '   ✓ Passed' + ' '.repeat(19));
  for (const line of lines) {
    assert.equal(visibleWidth(line), 30);
    assert.ok(line.startsWith(' ' + bg + '  '));
    assert.ok(line.endsWith(reset + ' '));
  }
  // The surface resumes after the child's own reset.
  assert.ok(lines[1]!.includes(reset + bg));
});

it('wraps styled Unicode text within the inset without outlines', () => {
  const lines = card(new Text(green + 'テスト 🚀 '.repeat(10) + reset, 0, 0)).render(31);
  assert.ok(lines.length > 3);
  for (const line of lines) assert.equal(visibleWidth(line), 31);
  assert.ok(!lines.map(stripTerminalSequences).join('').match(/[│─╭╮╰╯]/));
});
