import assert from 'node:assert/strict';
import test from 'node:test';
import { getOsc8LinkAtColumn } from '@earendil-works/pi-tui';
import { clickable, parseClickTarget, type ClickTarget } from './clickable.js';

test('app links round-trip through the OSC 8 hit test', () => {
  const links: ClickTarget[] = [
    { kind: 'action', index: 3 }, { kind: 'nav', index: 0 },
    { kind: 'key', data: '\x1b' }, { kind: 'modal', data: 'repo:2' },
  ];
  for (const link of links) {
    const url = getOsc8LinkAtColumn('ab' + clickable('cell', link), 3);
    assert.deepEqual(parseClickTarget(url!), link);
  }
});

test('only well-formed lovelace links are app links', () => {
  for (const url of ['https://example.com', 'lovelace:action:-1', 'lovelace:nav:x', 'lovelace:other:1', 'lovelace:key:%E0']) {
    assert.equal(parseClickTarget(url), undefined, url);
  }
});
