import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { formatTimestamp, timestampLines } from './timestamps.js';

const now = Date.parse('2026-10-07T12:00:00Z');
const DAY = 86_400_000;
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'always' });
const absolute = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const ago = (elapsed: number) => new Date(now - elapsed).toISOString();

test('recent timestamps use native relative seconds, minutes, hours and elapsed days', () => {
  for (const [elapsed, count, unit] of [
    [0, -0, 'second'], [59_000, -59, 'second'], [60_000, -1, 'minute'],
    [3_600_000, -1, 'hour'], [DAY, -1, 'day'], [7 * DAY, -7, 'day'],
  ] as const) assert.equal(formatTimestamp(ago(elapsed), now), relative.format(count, unit));
  assert.equal(formatTimestamp(ago(-3_600_000), now), relative.format(1, 'hour'));
});

test('older than exactly seven days uses the local date and time, independently per timestamp', () => {
  const old = ago(7 * DAY + 1);
  assert.equal(formatTimestamp(old, now), absolute.format(Date.parse(old)));
  assert.deepEqual(timestampLines({ createdAt: old, updatedAt: ago(3_600_000) }, 80, now).map(stripTerminalSequences), [
    'Created ' + absolute.format(Date.parse(old)), 'Updated ' + relative.format(-1, 'hour'),
  ]);
});

test('offsets, including a daylight-saving boundary, compare instants rather than calendar dates', () => {
  assert.equal(formatTimestamp('2026-10-07T14:00:00+0200', now), relative.format(-0, 'second'));
  const afterDst = Date.parse('2026-10-26T12:00:00+01:00');
  const beforeDst = '2026-10-19T12:00:00+02:00';
  assert.equal(formatTimestamp(beforeDst, afterDst), absolute.format(Date.parse(beforeDst)));
});

test('missing and invalid timestamps are unknown, never replaced with the current or attachment time', () => {
  for (const value of [undefined, null, '', 'invalid']) assert.equal(formatTimestamp(value, now), 'Unknown');
});

test('timestamp labels and full absolute dates wrap at narrow detail/card widths', () => {
  const lines = timestampLines({ createdAt: ago(8 * DAY), updatedAt: ago(9 * DAY) }, 16, now);
  for (const line of lines) assert.ok(visibleWidth(line) <= 16);
  const text = lines.map(stripTerminalSequences).join(' ');
  assert.ok(text.includes('Created ' + absolute.format(Date.parse(ago(8 * DAY)))));
  assert.ok(text.includes('Updated ' + absolute.format(Date.parse(ago(9 * DAY)))));
});
