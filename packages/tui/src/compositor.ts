import { visibleWidth } from '@earendil-works/pi-tui';
import type { WorkItemState } from '@lovelace/core';
import { padRight, safeText, truncate, wrap } from '@lovelace/tui-components';
import { warning, accent, bold, canvas, cardBg, muted, faint, success, icons, reset, danger } from './theme.js';
import { isLaunchFocus, type AppState } from './state.js';
import { keyChip } from './key-hints.js';

const DIALOG_WIDTH = 56;

const STATE_QUESTIONS: Record<WorkItemState, string> = {
  active: 'Reactivate this work?',
  done: 'Mark this work done?',
  cancelled: 'Cancel this work?',
};

/**
 * The pending confirmation as a framed dialog, centred over the frame by the
 * caller. Every line is exactly the returned width; nothing when none is pending.
 */
export function renderConfirmDialog(state: AppState, cols: number): string[] {
  const confirm = state.pendingConfirm;
  if (!confirm) return [];
  const [question, detail] = confirm.kind === 'state'
    ? [STATE_QUESTIONS[confirm.state], 'Changes the local work state only; Jira and GitHub stay as they are.']
    : ['Discard the unresolved launch?', 'Its outcome is unknown. Discarding clears the prompt.'];
  const width = Math.min(DIALOG_WIDTH, cols - 4);
  const inner = width - 6;
  const buttons = keyChip('y', 'confirm') + '   ' + keyChip('Esc', 'cancel');
  const body = [
    '',
    ...wrap(question, inner - 2).map((line, i) => (i ? '  ' : warning + icons.warning + reset + ' ') + bold + line + reset),
    '',
    ...wrap(detail, inner).map(line => muted + line + reset),
    '',
    ' '.repeat(Math.max(0, inner - visibleWidth(buttons))) + buttons,
    '',
  ];
  const border = (text: string) => warning + text + reset;
  const row = (line: string) => border('│') + '  ' + padRight(line, inner) + '  ' + border('│');
  return [
    border('╭' + '─'.repeat(width - 2) + '╮'),
    ...body.map(row),
    border('╰' + '─'.repeat(width - 2) + '╯'),
  ].map(line => canvas(line, width, cardBg));
}

/**
 * Footer chips, most important first; the frame drops trailing chips that do
 * not fit. Notices and errors lead and are truncated instead.
 */
export function helpChips(state: AppState, launchMenuOpen = false): { status: string; chips: string[] } {
  const chips: string[] = [];
  const status = state.error ? danger + icons.warning + ' ' + safeText(state.error) + reset
    : state.notice ? accent + safeText(state.notice) + reset
    : state.mutationInFlight ? muted + 'launching…' + reset
    : '';

  const typing = state.focus === 'editor' || isLaunchFocus(state.focus);
  if (state.draft.pendingLaunch && !typing) chips.push(keyChip('x', 'discard intent'));
  if (isLaunchFocus(state.focus) && launchMenuOpen) {
    chips.push(keyChip('↑/↓', 'move'), keyChip('Enter', 'choose'), keyChip('type', 'filter'), keyChip('Esc', 'close'));
  } else if (isLaunchFocus(state.focus)) {
    chips.push(keyChip('Enter', 'open'), keyChip('type', 'search'), keyChip('Tab/⇧Tab', 'next/prev'), keyChip('Esc', 'leave'));
  } else if (state.focus === 'editor') {
    chips.push(keyChip('Enter', 'launch'), keyChip('Esc', 'leave editor'), keyChip('Shift+Enter', 'newline'));
  } else {
    chips.push(keyChip('Enter', 'open'));
    if (state.view !== 'dashboard') chips.push(keyChip('Esc', 'back'));
    if (state.view === 'work-item') chips.push(keyChip('d/a/c', 'state'));
    if (state.view !== 'work-item') chips.push(keyChip('n', 'new'));
    chips.push(keyChip('↑/↓', 'move'), keyChip('Tab/⇧Tab', state.view === 'dashboard' ? 'focus' : 'next/prev'),
      keyChip('r', 'refresh'), keyChip('q', 'quit'));
  }
  return { status, chips };
}

/** `status` then as many chips as fit in `width`. */
export function fitChips({ status, chips }: { status: string; chips: string[] }, width: number): string {
  const gap = '   ';
  let line = status;
  for (const chip of chips) {
    const next = line ? line + gap + chip : chip;
    if (visibleWidth(next) > width) break;
    line = next;
  }
  return truncate(line, width);
}

/** Connection and freshness, e.g. `● live` or `● Jira stale`. */
export function connectionStatus(state: AppState): string {
  if (state.offline) return danger + icons.offline + ' offline' + (state.dashboardData ? faint + ' · last-known' : '') + reset;
  const freshness = state.dashboardData?.freshness;
  const stale = [freshness?.jiraStale && 'Jira', freshness?.githubStale && 'GitHub'].filter(Boolean);
  if (stale.length) return warning + icons.online + ' ' + stale.join(' + ') + ' stale' + reset;
  if (!state.dashboardData) return faint + icons.online + ' connecting…' + reset;
  if (state.isLoading) return muted + icons.online + ' loading…' + reset;
  return success + icons.online + reset + muted + ' live' + reset;
}
