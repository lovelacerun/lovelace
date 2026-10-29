import type { DashboardIssue, DashboardReview, WorkItemSummary } from '@lovelace/core';
import type { AppState } from '../state.js';
import { muted, faint, heading, icons, reset } from '../theme.js';
import { columnWidths, columns, safeText } from '@lovelace/tui-components';
import { launchStateBadge } from './launch-progress.js';
import { DocumentBuilder, keyedTitle, meta, plural, stateBadge, type Document } from './common.js';

/** Two-row entries need wider columns than the shared column helper allows. */
const SPLIT_MIN_WIDTH = 96;

const workDetail = (item: WorkItemSummary): string => muted + meta([
  (item.launchState ? launchStateBadge(item.launchState) : stateBadge(item.state)) + muted,
  item.sessionCount && plural(item.sessionCount, 'session'),
  item.repositoryCount && plural(item.repositoryCount, 'repo'),
  item.changeRequestRefs.length && plural(item.changeRequestRefs.length, 'PR'),
]) + reset;

const jiraDetail = (issue: DashboardIssue): string =>
  muted + meta([issue.status && safeText(issue.status), issue.issueType && safeText(issue.issueType)]) + reset;

const reviewDetail = (review: DashboardReview): string =>
  muted + meta([safeText(`${review.repository}#${review.number}`), review.author && safeText(review.author)]) + reset;

/**
 * Home: recorded work from yesterday and today beside pending Jira and reviews, two columns when
 * wide. Without the sidebar, active work leads so every item stays reachable.
 */
export function renderDashboard(state: AppState, width: number): Document {
  const b = new DocumentBuilder(state, width);
  const { compact, sidebar } = state.layout;
  const unavailable = state.offline || state.error;
  const loaded = Boolean(state.dashboardData);
  const recent = state.dashboardData?.recent;

  /** Section header, its quiet subtitle and a gap; entries add a gap between them unless compact. */
  const section = (lines: string[], title: string, count: string | number, subtitle: string, glyph: string) => {
    lines.push(heading(title, count, glyph), muted + subtitle + reset);
    if (!compact) lines.push('');
  };
  const entries = <T>(lines: string[], items: T[], cellWidth: number, base: number,
    render: (item: T) => { rows: string[]; entry: Parameters<DocumentBuilder['entry']>[1] }) => {
    for (const [index, item] of items.entries()) {
      if (index && !compact) lines.push('');
      const { rows, entry } = render(item);
      // Roomy layouts show cards; compact ones a single row per entry.
      lines.push(...compact ? b.entry(rows.slice(0, 1), entry, cellWidth, base + lines.length)
        : b.card(rows, entry, cellWidth, base + lines.length));
    }
  };
  const work = (item: WorkItemSummary) => ({
    rows: [(compact && item.launchState ? launchStateBadge(item.launchState, true) + ' ' : '') + keyedTitle(item.title), workDetail(item)],
    entry: { kind: 'navigate', entry: { kind: 'work', id: item.id } } as const,
  });

  if (!sidebar) {
    const active = state.activeWorkItems;
    const lines: string[] = [];
    section(lines, 'Active work', loaded ? active.length : '', loaded ? 'In progress locally'
      : unavailable ? 'Work unavailable' : 'Loading work…', icons.work);
    entries(lines, active, width, b.lines.length, work);
    if (loaded && !active.length) lines.push(muted + '  No active work.' + reset);
    for (const line of lines) b.line(line);
    b.line();
  }

  // Columns register left first, so ↑/↓ walks recent work, then Jira and reviews.
  const split = width >= SPLIT_MIN_WIDTH;
  const cell = split ? columnWidths(width)[0] : width;
  const offset = b.lines.length;
  const left: string[] = [];
  section(left, 'Recent work', recent ? recent.workItems.length : '', recent
    ? plural(recent.sessionCount, 'session') + ' · ' + recent.completedCount + ' completed'
    : unavailable ? 'Recorded activity unavailable' : 'Loading recorded activity…', icons.recent);
  entries(left, recent?.workItems ?? [], cell, offset, work);
  if (recent && !recent.workItems.length) left.push(muted + '  No recorded work.' + reset);

  const right: string[] = [];
  section(right, 'Pending Jira', loaded ? state.pendingIssues.length : '', loaded ? 'Assigned and not started'
    : unavailable ? 'Issues unavailable' : 'Loading issues…', icons.pending);
  entries(right, state.pendingIssues, cell, split ? offset : offset + left.length + 1, issue => ({
    rows: [keyedTitle(issue.title, issue.key), jiraDetail(issue)],
    entry: { kind: 'navigate', entry: { kind: 'jira', id: issue.id } },
  }));
  if (loaded && !state.pendingIssues.length) right.push(muted + '  Nothing waiting.' + reset);
  // Reviews take room only when one is waiting; small screens keep their layout.
  if (state.pendingReviews.length) {
    right.push('');
    section(right, 'Reviews', state.pendingReviews.length, 'Requested from you', icons.pr);
    entries(right, state.pendingReviews, cell, split ? offset : offset + left.length + 1, review => ({
      rows: [safeText(review.title), reviewDetail(review)],
      entry: { kind: 'navigate', entry: { kind: 'review', id: review.id } },
    }));
  }

  for (const line of split ? columns(left, right, width) : [...left, '', ...right]) b.line(line);
  if (!compact) { b.line(); b.line(); }
  b.action(icons.new + '  New repository-free work  ' + faint + 'n' + reset, { kind: 'edit' });
  return b.build();
}
