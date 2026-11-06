import { wrap } from '@lovelace/tui-components';
import { muted, reset } from '../theme.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'always' });
const absolute = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Use elapsed time through seven days, then the local date and time. */
export function formatTimestamp(value: string | null | undefined, now = Date.now()): string {
  const time = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) return 'Unknown';
  const elapsed = now - time;
  if (Math.abs(elapsed) > 7 * DAY) return absolute.format(time);
  const magnitude = Math.abs(elapsed);
  const [size, unit]: [number, Intl.RelativeTimeFormatUnit] = magnitude >= DAY ? [DAY, 'day']
    : magnitude >= HOUR ? [HOUR, 'hour'] : magnitude >= MINUTE ? [MINUTE, 'minute'] : [1_000, 'second'];
  return relative.format(Math.trunc(-elapsed / size), unit);
}

export function timestampLines(
  record: { createdAt?: string | null; updatedAt?: string | null }, width: number, now = Date.now(),
): string[] {
  return [
    'Created ' + formatTimestamp(record.createdAt, now),
    'Updated ' + formatTimestamp(record.updatedAt, now),
  ].flatMap(line => wrap(line, width).map(part => muted + part + reset));
}
