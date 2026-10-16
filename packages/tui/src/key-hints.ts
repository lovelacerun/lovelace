import { accent, muted, reset } from './theme.js';
import { clickable } from './clickable.js';

/** Input each single-key label replays when clicked. */
const KEY_DATA: Record<string, string> = {
  y: 'y', x: 'x', q: 'q', r: 'r', n: 'n', Esc: '\x1b', Enter: '\r', 'Tab/⇧Tab': '\t',
};

/** Make `text` press `key` (a label from KEY_DATA) when clicked; unknown keys stay plain. */
export function keyHint(text: string, key: string): string {
  const data = KEY_DATA[key];
  return data ? clickable(text, { kind: 'key', data }) : text;
}

/** A highlighted key and its quiet label, e.g. `q quit`, that presses the key when clicked. */
export function keyChip(key: string, label: string): string {
  return keyHint(accent + key + reset + ' ' + muted + label + reset, key);
}
