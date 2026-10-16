import { decodeKittyPrintable, fuzzyFilter, Input, matchesKey } from '@earendil-works/pi-tui';
import { padRight, safeText, truncate } from './text.js';

export interface DropdownItem {
  value: string;
  label: string;
  /** Secondary text after the label, e.g. the raw value behind a display name. */
  hint?: string;
}

export interface DropdownTheme {
  /** The closed field, already padded; `focused` while it has the keyboard. */
  field: (text: string, focused: boolean) => string;
  /** The highlighted list row, padded to the list width. */
  selected: (text: string) => string;
  /** Hints, the filter prompt and the scroll position. */
  muted: (text: string) => string;
  /** Makes a region clickable; `action` is `toggle` or `pick:<row>`. Default: plain text. */
  link?: (text: string, action: string) => string;
}

export interface DropdownOptions {
  /** Offer the typed filter itself as a choice, for values the list does not know. */
  allowCustom?: boolean;
  /** List rows shown at once. Default 8. */
  maxVisible?: number;
}

/** A single printable character or a bracketed paste: filter text, not a command. */
function isText(data: string): boolean {
  if (data.startsWith('\x1b[200~')) return true;
  const text = decodeKittyPrintable(data) ?? data;
  return [...text].length === 1 && text >= ' ' && text !== '\x7f';
}

/**
 * A select field that expands into a filterable list below it. Closed, Enter,
 * Space or ↓ opens it and typing opens it filtered. Open, ↑/↓ move, Enter
 * picks and Esc closes. Tab closes it without consuming the key, so the host
 * still moves focus.
 */
export class Dropdown {
  open = false;
  private items: DropdownItem[] = [];
  private value = '';
  private highlighted = 0;
  private readonly filter = new Input({ prompt: '', placeholder: 'type to filter' });

  constructor(
    private readonly theme: DropdownTheme,
    private readonly onPick: (value: string) => void,
    private readonly options: DropdownOptions = {},
  ) {}

  setItems(items: DropdownItem[], value: string): void {
    this.items = items;
    this.value = value;
  }

  /** The current value's label; a custom value is its own label. */
  get label(): string {
    return this.items.find(item => item.value === this.value)?.label ?? this.value;
  }

  /** True when the key was used. */
  handleInput(data: string): boolean {
    if (!this.open) {
      if (matchesKey(data, 'enter') || matchesKey(data, 'space') || matchesKey(data, 'down')) this.expand();
      else if (isText(data)) {
        this.expand();
        this.type(data);
      } else return false;
      return true;
    }
    if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
      this.close();
      return false;
    }
    const visible = this.visibleItems();
    const page = this.options.maxVisible ?? 8;
    if (matchesKey(data, 'escape')) this.close();
    else if (matchesKey(data, 'up')) this.highlighted = Math.max(0, this.highlighted - 1);
    else if (matchesKey(data, 'down')) this.highlighted = Math.min(visible.length - 1, this.highlighted + 1);
    else if (matchesKey(data, 'pageUp')) this.highlighted = Math.max(0, this.highlighted - page);
    else if (matchesKey(data, 'pageDown')) this.highlighted = Math.min(visible.length - 1, this.highlighted + page);
    else if (matchesKey(data, 'enter')) this.pick(visible[this.highlighted]);
    else this.type(data);
    return true;
  }

  /** Target of a clicked `link` region. */
  openLink(action: string): void {
    if (action === 'toggle') {
      if (this.open) this.close();
      else this.expand();
    } else if (action.startsWith('pick:')) this.pick(this.visibleItems()[Number(action.slice(5))]);
  }

  close(): void {
    this.open = false;
    this.filter.setValue('');
  }

  /** `label ▾` (or `placeholder ▾` for an empty value), truncated to `width`. */
  renderField(width: number, focused: boolean, placeholder?: string): string {
    const label = !this.value && placeholder ? placeholder : this.label;
    const text = ' ' + truncate(safeText(label), Math.max(1, width - 4)) + ' ▾ ';
    return this.link(this.theme.field(text, focused), 'toggle');
  }

  /** The filter line and visible rows while open; nothing while closed. */
  renderList(width: number): string[] {
    if (!this.open) return [];
    const visible = this.visibleItems();
    this.highlighted = Math.max(0, Math.min(this.highlighted, visible.length - 1));
    const rows = this.options.maxVisible ?? 8;
    const start = Math.max(0, Math.min(this.highlighted - Math.floor(rows / 2), visible.length - rows));
    this.filter.focused = true;
    const lines = [this.theme.muted('/ ') + (this.filter.render(Math.max(1, width - 2))[0] ?? '')];
    for (const [offset, item] of visible.slice(start, start + rows).entries()) {
      const index = start + offset;
      const marker = item.value === this.value ? '• ' : '  ';
      const hint = item.hint ? '  ' + this.theme.muted(safeText(item.hint)) : '';
      const text = padRight(truncate(marker + safeText(item.label) + hint, width), width);
      lines.push(this.link(index === this.highlighted ? this.theme.selected(text) : text, `pick:${index}`));
    }
    if (!visible.length) lines.push(this.theme.muted(truncate('No matches', width)));
    else if (visible.length > rows) lines.push(this.theme.muted(truncate(`${start + 1}–${Math.min(start + rows, visible.length)} of ${visible.length}`, width)));
    return lines;
  }

  private visibleItems(): DropdownItem[] {
    const query = this.filter.getValue().trim();
    if (!query) return this.items;
    const matches = fuzzyFilter(this.items, query, item => `${item.value} ${item.label}`);
    const custom = this.options.allowCustom && !this.items.some(item => item.value === query);
    return custom ? [...matches, { value: query, label: query, hint: 'use as typed' }] : matches;
  }

  private expand(): void {
    this.open = true;
    this.filter.setValue('');
    this.highlighted = Math.max(0, this.items.findIndex(item => item.value === this.value));
  }

  private type(data: string): void {
    this.filter.handleInput(data);
    this.highlighted = 0;
  }

  private pick(item: DropdownItem | undefined): void {
    if (!item) return;
    this.value = item.value;
    this.close();
    this.onPick(item.value);
  }

  private link(text: string, action: string): string {
    return this.theme.link ? this.theme.link(text, action) : text;
  }
}
