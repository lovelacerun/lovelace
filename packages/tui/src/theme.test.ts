import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import * as theme from './theme.js';

afterEach(() => theme.useTheme('dark'));

it('defaults to Gruvbox dark and switches palettes through live bindings', () => {
  assert.equal(theme.appBg, '\x1b[48;2;40;40;40m');
  assert.equal(theme.accent, '\x1b[38;2;131;165;152m');
  theme.useTheme('light');
  assert.equal(theme.appBg, '\x1b[48;2;251;241;199m');
  assert.equal(theme.appFg, '\x1b[38;2;60;56;54m');
});

it('applies known overrides, `none` as the terminal default, and ignores unknown tokens', () => {
  theme.useTheme('light', { accent: '#102030', background: 'none', bogus: '#ffffff' });
  assert.equal(theme.accent, '\x1b[38;2;16;32;48m');
  assert.equal(theme.appBg, '\x1b[49m');
});

it('paints the canvas across the width and restores it after full and partial resets', () => {
  const line = theme.canvas(theme.accent + 'a' + theme.reset + 'b\x1b[39mc\x1b[49md', 10);
  assert.equal(visibleWidth(line), 10);
  assert.ok(line.includes(theme.reset + theme.appBg + theme.appFg + 'b'));
  assert.ok(line.includes(theme.appFg + 'c'));
  assert.ok(line.includes(theme.appBg + 'd'));
});
