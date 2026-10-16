import type { WorkItemState } from '@lovelace/core';
import { visibleWidth } from '@earendil-works/pi-tui';
import type { AppState, NavigationEntry } from '../state.js';
import { accent, band, cardBg, danger, faint, icons, keyColor, muted, reset, selectedBand, selectedBg, success } from '../theme.js';
import { padRight, safeText, truncate } from '@lovelace/tui-components';
import { clickable } from '../clickable.js';

export type Action = { kind: 'navigate'; entry: NavigationEntry } | { kind: 'session'; metaId: string } |
  { kind: 'jira-setup' } | { kind: 'launch-retry'; requestId?: string } | { kind: 'open-url'; url: string } |
  { kind: 'edit' } | { kind: 'state'; state: WorkItemState };

export interface Document { lines: string[]; actions: Action[]; selectedRow: number }

export class DocumentBuilder {
  readonly lines: string[] = [];
  readonly actions: Action[] = [];
  selectedRow = 0;

  constructor(private readonly state: AppState, private readonly width: number) {}

  line(text = ''): void { this.lines.push(truncate(text, this.width)); }

  /** A one-row action; `aside` sits at the right edge, e.g. a status. */
  action(label: string, action: Action, aside = ''): void {
    this.line(this.item(label, action, this.width, aside));
  }

  /** Register any selectable component at its actual row, including multi-line column cells. */
  register(action: Action, row = this.lines.length): boolean {
    const selected = this.actions.length === this.state.contentSelectedIndex;
    if (selected) this.selectedRow = row;
    this.actions.push(action);
    return selected;
  }

  get focused(): boolean { return this.state.focus === 'content'; }

  /** Register an action and return its rendered cell; callers place it (e.g. in a column). */
  item(label: string, action: Action, width: number, aside = ''): string {
    return this.entry([label], action, width, undefined, aside)[0]!;
  }

  /**
   * A selectable entry of a title row and quiet detail rows, selected and
   * clicked as one. `row` is where its first line lands in the document.
   */
  entry(rows: string[], action: Action, width: number, row = this.lines.length, aside = ''): string[] {
    const selected = this.register(action, row);
    const target = { kind: 'action', index: this.actions.length - 1 } as const;
    // Pad inside the link so the whole row is clickable.
    return rows.map((text, index) =>
      clickable(selectableRow(index ? text : withAside(text, aside, width - 2), width, selected, this.focused), target));
  }

  /**
   * A selectable card: `rows` on the card surface with one padding row above
   * and below; the selection recolours the whole card and adds the `▌` bar.
   * `row` is where the card's top padding lands in the document.
   */
  card(rows: string[], action: Action, width: number, row = this.lines.length): string[] {
    const selected = this.register(action, row + 1);
    const target = { kind: 'action', index: this.actions.length - 1 } as const;
    const surface = selected && this.focused ? selectedBg : cardBg;
    const bar = selected ? (this.focused ? accent : faint) + '▌' + reset : ' ';
    // Inset like the provider cards: three cells on the left, two on the right.
    return ['', ...rows, ''].map(text => clickable(band(bar + '  ' + truncate(text, width - 5), width, surface), target));
  }

  build(): Document { return { lines: this.lines, actions: this.actions, selectedRow: this.selectedRow }; }
}

/** A `▌` bar marks the selected row; it gets the band while its pane has focus. */
export function selectableRow(label: string, width: number, selected: boolean, focused: boolean): string {
  if (!selected) return padRight('  ' + label + reset, width);
  if (focused) return selectedBand(accent + '▌' + reset + ' ' + label + reset, width);
  return padRight(faint + '▌' + reset + ' ' + label + reset, width);
}

/** `label` with `aside` right-aligned within `width`, or just after it when space is short. */
export function withAside(label: string, aside: string, width: number): string {
  if (!aside) return label;
  const room = width - visibleWidth(aside) - 2;
  if (room < 8) return label + '  ' + aside;
  return padRight(truncate(label, room), room) + '  ' + aside;
}

const ISSUE_KEY = /^([A-Z][A-Z0-9]+-\d+)(?::\s*|\s+[-–—]\s+|\s+)(.+)$/;

/** Split a leading `PROJ-1: …` key off a title. */
export function splitIssueKey(title: string): { key?: string; title: string } {
  const match = ISSUE_KEY.exec(title);
  return match ? { key: match[1], title: match[2]! } : { title };
}

/** Untrusted title with its issue key tinted, e.g. `PROJ-1471  Regenerate audio`. */
export function keyedTitle(title: unknown, key?: unknown): string {
  const split = key ? { key: safeText(key), title: safeText(title) } : splitIssueKey(safeText(title));
  return split.key ? keyColor + split.key + reset + '  ' + split.title : split.title;
}

export function stateBadge(state: WorkItemState): string {
  const [glyph, color] = state === 'done' ? [icons.done, success] : state === 'cancelled' ? [icons.cancel, danger] : [icons.active, accent];
  return color + glyph + ' ' + state + reset;
}

/** Quiet `a · b · c` metadata, skipping empty parts. */
export function meta(parts: Array<string | 0 | false | undefined | null>): string {
  return parts.filter(Boolean).join(faint + '  ·  ' + reset + muted);
}

export function plural(count: number, noun: string): string { return count + ' ' + noun + (count === 1 ? '' : 's'); }

export function payload(meta: { payloadJson: string | null }): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(meta.payloadJson ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}
