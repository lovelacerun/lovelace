import { CURSOR_MARKER, type Editor } from '@earendil-works/pi-tui';

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * Fit rendered `Editor` lines to exactly `rows`, keeping both borders: pad
 * above the bottom border, or crop from the hardware cursor (near the end
 * when unfocused).
 */
export function fitEditorLines(lines: string[], rows: number): string[] {
  if (lines.length <= rows) return [...lines.slice(0, -1), ...Array<string>(rows - lines.length).fill(''), lines.at(-1)!];
  const cursor = lines.findIndex(line => line.includes(CURSOR_MARKER));
  const start = Math.max(1, Math.min(cursor < 0 ? lines.length - rows : cursor, lines.length - rows + 1));
  return [lines[0]!, ...lines.slice(start, start + rows - 2), lines.at(-1)!];
}

/**
 * Replace an `Editor`'s text without firing `onChange`. `asPaste` inserts it
 * as a bracketed paste, so large text keeps native paste markers.
 */
export function replaceEditorText(editor: Editor, text: string, asPaste = false): void {
  const onChange = editor.onChange;
  editor.onChange = undefined;
  try {
    editor.setText(asPaste ? '' : text);
    if (asPaste && text) editor.handleInput(PASTE_START + text + PASTE_END);
  } finally {
    editor.onChange = onChange;
  }
}

/** Follows bracketed paste across input chunks, so pasted Enter/Esc/Tab stay text. */
export class PasteTracker {
  private pasting = false;

  /** Whether `data` belongs to a paste. */
  feed(data: string): boolean {
    if (!this.pasting && !data.includes(PASTE_START)) return false;
    this.pasting = !data.includes(PASTE_END);
    return true;
  }
}
