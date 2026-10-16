import assert from 'node:assert/strict';
import test from 'node:test';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { Dropdown } from './dropdown.js';

const theme = { field: (text: string, focused: boolean) => focused ? `[${text}]` : text, selected: (text: string) => `>${text}`, muted: (text: string) => text };
const plain = (lines: string[]) => lines.map(line => stripTerminalSequences(line).trimEnd());

function dropdown(allowCustom = false) {
  const picks: string[] = [];
  const menu = new Dropdown(theme, value => picks.push(value), { allowCustom, maxVisible: 3 });
  menu.setItems([{ value: '', label: 'default' }, { value: 'opus', label: 'opus' }, { value: 'sonnet', label: 'sonnet' }, { value: 'gpt', label: 'GPT', hint: 'gpt' }], 'opus');
  return { menu, picks };
}

test('Enter opens on the current value, arrows move and Enter picks', () => {
  const { menu, picks } = dropdown();
  assert.equal(stripTerminalSequences(menu.renderField(20, true)), '[ opus ▾ ]');
  assert.equal(menu.handleInput('\x1b[A'), false, 'closed fields leave other keys to the host');
  assert.equal(menu.handleInput('\r'), true);
  assert.deepEqual(plain(menu.renderList(20)).slice(1), ['  default', '>• opus', '  sonnet', '1–3 of 4']);
  menu.handleInput('\x1b[B');
  menu.handleInput('\r');
  assert.deepEqual(picks, ['sonnet']);
  assert.equal(menu.open, false);
  assert.equal(menu.label, 'sonnet');
});

test('typing opens a filtered list; Esc closes it and Tab passes through', () => {
  const { menu, picks } = dropdown();
  for (const key of 'gp') menu.handleInput(key);
  assert.deepEqual(plain(menu.renderList(20)).slice(1), ['>  GPT  gpt']);
  assert.equal(menu.handleInput('\x1b'), true);
  assert.equal(menu.open, false);
  menu.handleInput('z');
  assert.match(plain(menu.renderList(20))[1]!, /No matches/);
  assert.equal(menu.handleInput('\t'), false);
  assert.equal(menu.open, false);
  assert.deepEqual(picks, []);
});

test('custom values are offered as typed and keep their own label', () => {
  const { menu, picks } = dropdown(true);
  for (const key of 'haiku') menu.handleInput(key);
  assert.deepEqual(plain(menu.renderList(30)).slice(1), ['>  haiku  use as typed']);
  menu.handleInput('\r');
  assert.deepEqual(picks, ['haiku']);
  menu.setItems([{ value: '', label: 'default' }], 'haiku');
  assert.equal(menu.label, 'haiku');
});

test('clicked regions toggle and pick', () => {
  const links: string[] = [];
  const picks: string[] = [];
  const menu = new Dropdown({ ...theme, link: (text, action) => { links.push(action); return text; } }, value => picks.push(value));
  menu.setItems([{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], 'a');
  menu.renderField(10, false);
  menu.openLink('toggle');
  menu.renderList(10);
  assert.deepEqual(links, ['toggle', 'pick:0', 'pick:1']);
  menu.openLink('pick:1');
  assert.deepEqual(picks, ['b']);
});
