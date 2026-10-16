import assert from 'node:assert/strict';
import { it } from 'node:test';
import { getOsc8LinkAtColumn, stripTerminalSequences } from '@earendil-works/pi-tui';
import { LinkCard } from './link-card.js';

const reset = '\x1b[0m';
const bg = '\x1b[48;5;236m';
const selectedBg = '\x1b[48;5;24m';
const theme = {
  background: (text: string) => bg + text + reset,
  selectedBackground: (text: string) => selectedBg + text + reset,
  selectedMarker: (text: string) => '\x1b[36m' + text + reset,
};

it('links every row and swaps marker and surface when selected', () => {
  const card = new LinkCard(['PROJ-1', 'Description'], 'https://example.com/browse/PROJ-1', theme);
  let lines = card.render(40);
  assert.match(stripTerminalSequences(lines[1]!), /↗ PROJ-1/);
  for (const [row, line] of lines.entries()) {
    assert.equal(getOsc8LinkAtColumn(line, 5), 'https://example.com/browse/PROJ-1', `row ${row}`);
    assert.ok(line.includes(bg) && !line.includes(selectedBg));
  }
  card.setSelected(true);
  lines = card.render(40);
  assert.match(stripTerminalSequences(lines[1]!), /› PROJ-1/);
  for (const line of lines) assert.ok(line.includes(selectedBg));
});

it('renders a plain card without a URL', () => {
  const lines = new LinkCard(['No link'], undefined, theme).render(40);
  assert.equal(stripTerminalSequences(lines[1]!).trim(), 'No link');
  assert.equal(getOsc8LinkAtColumn(lines[1]!, 5), undefined);
});
