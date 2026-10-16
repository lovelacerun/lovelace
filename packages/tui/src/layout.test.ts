import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  contentGutter, MIN_WIDTH, responsiveSidebarWidth, SIDEBAR_MIN_COLS, SIDEBAR_WIDE_COLS,
  SIDEBAR_WIDTH_FULL, SIDEBAR_WIDTH_NARROW, SIDEBAR_WIDTH_WIDE,
} from './layout.js';

describe('responsiveSidebarWidth', () => {
  it('widens the sidebar with the terminal and hides it on narrow terminals', () => {
    assert.equal(responsiveSidebarWidth(SIDEBAR_WIDE_COLS), SIDEBAR_WIDTH_WIDE);
    assert.equal(responsiveSidebarWidth(120), SIDEBAR_WIDTH_FULL);
    assert.equal(responsiveSidebarWidth(SIDEBAR_MIN_COLS), SIDEBAR_WIDTH_NARROW);
    assert.equal(responsiveSidebarWidth(SIDEBAR_MIN_COLS - 1), 0);
    assert.equal(responsiveSidebarWidth(MIN_WIDTH), 0);
  });

  it('narrows the content gutter before the content', () => {
    assert.equal(contentGutter(MIN_WIDTH), 1);
    assert.ok(contentGutter(120) > contentGutter(50));
  });
});
