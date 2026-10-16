import type { WorkItemDetails } from '@lovelace/core';
import { visibleWidth } from '@earendil-works/pi-tui';
import { Card, columns, columnWidths, COLUMNS_MIN_WIDTH, LinkCard, safeText, type LinkCardTheme } from '@lovelace/tui-components';
import { warning, bold, accent, muted, success, heading, icons, jiraCardTheme, prCardTheme, danger, reset, special } from '../theme.js';
import { browserUrl } from '../browser.js';
import { payload, type DocumentBuilder } from './common.js';

type Status = [glyph: string, label: string, color: string];

// Built per render: the icon set is chosen at startup.
const prStatus = (): Record<string, Status> => ({
  open: [icons.open, 'Open', success], draft: [icons.draft, 'Draft', muted], merged: [icons.merged, 'Merged', special],
  closed: [icons.closed, 'Closed', muted],
});
const reviewStatus = (): Record<string, Status> => ({
  APPROVED: [icons.check, 'Approved', success],
  CHANGES_REQUESTED: [icons.warning, 'Changes requested', warning],
  REVIEW_REQUIRED: [icons.waiting, 'Review required', warning],
});
const buildStatus = (): Record<string, Status> => ({
  success: [icons.check, 'Build passed', success], failure: [icons.cross, 'Build failed', danger], error: [icons.cross, 'Build failed', danger],
  pending: [icons.waiting, 'Build pending', warning],
});
const JIRA_DONE = ['done', 'closed', 'resolved'];
const JIRA_ACTIVE = ['in progress', 'in review'];

const indicator = ([glyph, label, color]: Status): string => color + glyph + ' ' + label + reset;
/** Known statuses from `table`; anything else is a quiet `?` with the `unknown` label. */
const lookup = (table: Record<string, Status>, status: string, unknown: string): string =>
  indicator(Object.hasOwn(table, status) ? table[status]! : [icons.unknown, unknown, muted]);

function jiraStatus(value: unknown): string {
  const label = safeText(value) || 'Unknown';
  const status = label.toLowerCase();
  return indicator(JIRA_DONE.includes(status) ? [icons.done, label, success] : JIRA_ACTIVE.includes(status) ? [icons.active, label, accent] : [icons.todo, label, muted]);
}

/** A card is selectable only when its cached URL is safe to open; `row` is its top padding row. */
function linkCard(lines: string[], width: number, theme: LinkCardTheme, url: unknown, row: number, document?: DocumentBuilder): string[] {
  const link = browserUrl(url) ?? undefined;
  const selected = link && document?.register({ kind: 'open-url', url: link }, row + 1);
  const card = new LinkCard(lines, link, theme);
  card.setSelected(Boolean(selected && document?.focused));
  return card.render(width);
}

export function renderAttachments(metas: WorkItemDetails['metas'], width: number, document?: DocumentBuilder): string[] {
  const startRow = document?.lines.length ?? 0;
  const [leftWidth, rightWidth] = columnWidths(width);
  const issues = metas.filter(meta => meta.metaType === 'tracker-item');
  const requests = metas.filter(meta => meta.metaType === 'pull-request' || meta.metaType === 'change-request');
  const jira = [heading('Attached Jira', issues.length, icons.jira), ''];
  const prs = [heading('Pull requests', requests.length, icons.pr), ''];
  for (const [index, meta] of issues.entries()) {
    const data = payload(meta);
    if (index) jira.push('');
    jira.push(...linkCard([
      accent + bold + safeText(data.key ?? meta.externalId) + reset,
      safeText(data.title, true),
      jiraStatus(data.status),
    ], leftWidth, jiraCardTheme, data.url, startRow + jira.length, document));
  }
  if (!issues.length) jira.push(muted + '  None attached.' + reset);
  const prStartRow = startRow + (width < COLUMNS_MIN_WIDTH ? jira.length + 1 : 0);
  for (const [index, meta] of requests.entries()) {
    const data = payload(meta);
    if (index) prs.push('');
    const review = safeText(data.reviewDecision).toUpperCase();
    const reviewLabel = lookup(reviewStatus(), review,
      review && review !== 'UNKNOWN' ? 'Review: ' + safeText(data.reviewDecision) : 'Review unknown');
    const build = safeText(data.buildStatus).toLowerCase();
    const buildLabel = lookup(buildStatus(), build, build && build !== 'unknown' ? 'Build: ' + build : 'Build unknown');
    const status = safeText(data.status).toLowerCase();
    const checks = reviewLabel + '  ' + buildLabel;
    prs.push(...linkCard([
      bold + '#' + safeText(String(data.number ?? meta.externalId ?? '')) + reset + '  ' + lookup(prStatus(), status, status || 'Unknown'),
      muted + safeText(data.repoFullName) + reset,
      ...(visibleWidth(checks) <= Card.contentWidth(rightWidth) ? [checks] : [reviewLabel, buildLabel]),
    ], rightWidth, prCardTheme, data.url, prStartRow + prs.length, document));
  }
  if (!requests.length) prs.push(muted + '  None attached.' + reset);
  return columns(jira, prs, width);
}
