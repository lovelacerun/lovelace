import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';

/** External text is data, never terminal instructions. Keep newlines only on request. */
export function safeText(value: unknown, multiline = false): string {
  const plain = stripTerminalSequences(typeof value === 'string' ? value : '');
  return plain.replace(multiline ? /[\x00-\x09\x0b-\x1f\x7f-\x9f]/g : /[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/[‪-‮⁦-⁩]/g, '');
}

export function truncate(text: string, width: number): string { return width < 1 ? '' : truncateToWidth(text, width, '…'); }

export function padRight(text: string, width: number): string {
  const line = truncate(text, width);
  return line + ' '.repeat(Math.max(0, width - visibleWidth(line)));
}

/** Wrap untrusted text, keeping its newlines. */
export function wrap(value: unknown, width: number): string[] {
  return wrapTextWithAnsi(safeText(value, true), Math.max(1, width));
}

/** Narrowest width at which `columns` places its columns side by side. */
export const COLUMNS_MIN_WIDTH = 64;

/** Widths of the left and right `columns` cells; each spans `width` when stacked. */
export function columnWidths(width: number): [left: number, right: number] {
  if (width < COLUMNS_MIN_WIDTH) return [width, width];
  const left = Math.floor((width - 3) / 2);
  return [left, width - left - 3];
}

/** Two columns side by side with a three-cell gutter, stacked when narrow. */
export function columns(left: string[], right: string[], width: number): string[] {
  if (width < COLUMNS_MIN_WIDTH) return [...left, '', ...right];
  const [leftWidth, rightWidth] = columnWidths(width);
  const lines: string[] = [];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    lines.push(padRight(left[i] ?? '', leftWidth) + '   ' + truncate(right[i] ?? '', rightWidth));
  }
  return lines;
}

/** Closes any OSC 8 hyperlink a truncated cell left open. */
export const LINK_END = '\x1b]8;;\x1b\\';

/** Pad a column cell and fence it, so a hyperlink cannot bleed into its neighbour. */
export function linkCell(text: string, width: number): string {
  return padRight(text, width) + LINK_END;
}
