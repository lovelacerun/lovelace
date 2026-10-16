import assert from 'node:assert/strict';
import test from 'node:test';
import { hyperlink, stripTerminalSequences, visibleWidth, type Component, type TuiMouseEvent } from '@earendil-works/pi-tui';
import { SplitPane } from './split-pane.js';

const event = (type: TuiMouseEvent['type'], x: number, extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent => ({
  type, button: 'left', x, y: 0, screenX: x, screenY: 0, width: 40, height: 3,
  shift: false, alt: false, ctrl: false, ...extra,
});

class Pane implements Component {
  events: TuiMouseEvent[] = [];
  constructor(private readonly lines: string[]) {}
  render(): string[] { return this.lines; }
  handleMouse(event: TuiMouseEvent) { this.events.push(event); return { handled: true }; }
  invalidate(): void {}
}

test('places the secondary pane on either side and pads the shorter pane', () => {
  const split = new SplitPane(new Pane(['main', 'more']), new Pane(['side']), { divider: text => text }, { size: () => 10 });
  let lines = split.render(40).map(stripTerminalSequences);
  assert.deepEqual(lines, ['main'.padEnd(29) + '│' + 'side'.padEnd(10), 'more'.padEnd(29) + '│' + ' '.repeat(10)]);
  split.setSide('start');
  lines = split.render(40).map(stripTerminalSequences);
  assert.equal(lines[0], 'side'.padEnd(10) + '│' + 'main'.padEnd(29));
});

test('fences links per cell and hides the secondary pane at size 0', () => {
  const split = new SplitPane(new Pane([hyperlink('x'.repeat(50), 'https://example.com')]), new Pane(['side']),
    { divider: text => text }, { size: width => width > 30 ? 8 : 0, gap: 1 });
  const [line] = split.render(40);
  assert.equal(visibleWidth(line!), 40);
  assert.ok(stripTerminalSequences(line!).includes('… │ side'));
  assert.deepEqual(split.render(30).map(line => visibleWidth(line)), [30]);
});

test('forwards mouse events to the pane under the pointer in local coordinates', () => {
  const main = new Pane([]), side = new Pane([]);
  const split = new SplitPane(main, side, { divider: text => text }, { size: () => 10, side: 'start' });
  split.handleMouse(event('click', 3));
  split.handleMouse(event('click', 15));
  assert.equal(split.handleMouse(event('click', 10)), undefined, 'the divider itself is inert unless resizable');
  assert.deepEqual(side.events.map(e => [e.x, e.width]), [[3, 10]]);
  assert.deepEqual(main.events.map(e => [e.x, e.width]), [[4, 29]]);
});

test('drags a resizable divider within bounds and double-click restores the default', () => {
  const split = new SplitPane(new Pane(['main']), new Pane(['side']), { divider: text => text, dragging: text => '*' + text },
    { size: () => 10, resizable: true, minSize: 5, minPrimarySize: 20 });
  assert.equal(split.layout(40).dividerX, 29);
  assert.equal(split.handleMouse(event('press', 29))?.capture, true);
  assert.ok(split.render(40)[0]!.includes('*│'));
  split.handleMouse(event('drag', 2));
  split.handleMouse(event('release', 2));
  assert.equal(split.layout(40).secondaryWidth, 40 - 20 - 1);
  split.handleMouse(event('drag', 30));
  assert.equal(split.layout(40).secondaryWidth, 40 - 20 - 1, 'a released divider ignores later drags');
  split.handleMouse(event('press', split.layout(40).dividerX));
  split.handleMouse(event('click', split.layout(40).dividerX, { clickCount: 2 }));
  assert.equal(split.layout(40).secondaryWidth, 10);
});
