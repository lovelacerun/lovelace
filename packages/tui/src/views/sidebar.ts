import type { AppState } from '../state.js';
import { accent, muted, groupLabel, icons, reset } from '../theme.js';
import { safeText, truncate } from '@lovelace/tui-components';
import { clickable } from '../clickable.js';
import { launchStateBadge } from './launch-progress.js';
import { keyedTitle, selectableRow } from './common.js';

const SECTIONS = [
  { kind: 'work', title: 'Active work', empty: 'No active work' },
  { kind: 'jira', title: 'Pending Jira', empty: 'No pending issues' },
  { kind: 'review', title: 'Reviews', empty: 'No pending reviews' },
] as const;

/** Home, then one section per entry kind, rendered from `state.sidebarEntries`. */
export function renderSidebar(state: AppState, width: number): { lines: string[]; selectedRow: number } {
  const lines: string[] = [''];
  let selectedRow = 0;
  // Labels align with the text after each row's two-cell selection marker.
  const inset = '  ';
  const entries = state.sidebarEntries;
  const row = (index: number, label: string) => {
    const selected = index === state.sidebarSelectedIndex;
    if (selected) selectedRow = lines.length;
    lines.push(clickable(selectableRow(label, Math.max(1, width - 1), selected, state.focus === 'sidebar'), { kind: 'nav', index }));
  };
  const unavailable = state.offline || state.error ? 'Unavailable' : 'Loading…';
  row(0, (state.view === 'dashboard' ? accent : muted) + icons.home + reset + '  Home');
  for (const { kind, title, empty } of SECTIONS) {
    const indexes = [...entries.keys()].filter(index => entries[index]!.kind === kind);
    lines.push('', inset + groupLabel(title, state.dashboardData ? indexes.length : ''), '');
    for (const index of indexes) {
      const launchState = kind === 'work' ? state.activeWorkItems.find(item => item.id === entries[index]!.id)?.launchState : undefined;
      row(index, (launchState && state.layout.compact ? launchStateBadge(launchState, true) + ' ' : '') + keyedTitle(safeText(entries[index]!.label)));
      if (launchState && !state.layout.compact) {
        lines.push(clickable(inset + '  ' + launchStateBadge(launchState), { kind: 'nav', index }));
      }
    }
    if (!indexes.length) lines.push(inset + muted + (state.dashboardData ? empty : unavailable) + reset);
  }
  return { lines: lines.map(line => truncate(line, width)), selectedRow };
}
