import { attachmentsOfType, type ReleaseChecks, type WorkItemDetails } from '@lovelace/core';
import { visibleWidth } from '@earendil-works/pi-tui';
import { Card, columns, columnWidths, COLUMNS_MIN_WIDTH, LinkCard, safeText, type LinkCardTheme } from '@lovelace/tui-components';
import { warning, bold, accent, muted, success, heading, icons, jiraCardTheme, prCardTheme, danger, reset, special } from '../theme.js';
import { browserUrl } from '../browser.js';
import type { DocumentBuilder } from './common.js';

type Status = [glyph: string, label: string, color: string];

// Built per render: the icon set is chosen at startup.
const prStatus = (): Record<string, Status> => ({
  open: [icons.open, 'Open', success], draft: [icons.draft, 'Draft', muted], merged: [icons.merged, 'Merged', special],
  closed: [icons.closed, 'Closed', muted],
});
const reviewStatus = (): Record<string, Status> => ({
  'approved': [icons.check, 'Approved', success],
  'changes-requested': [icons.warning, 'Changes requested', warning],
  'required': [icons.waiting, 'Review required', warning],
});
const buildStatus = (): Record<string, Status> => ({
  success: [icons.check, 'Build passed', success], failure: [icons.cross, 'Build failed', danger], error: [icons.cross, 'Build failed', danger],
  pending: [icons.waiting, 'Build pending', warning],
});
const releaseStatus = (): Record<string, [glyph: string, color: string]> => ({
  done: [icons.check, success], pending: [icons.waiting, warning], unknown: [icons.unknown, muted],
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

/** One line of release targets, then why any is unknown and why the last check failed. */
function releaseLines(releaseChecks: ReleaseChecks | undefined): string[] {
  if (!releaseChecks) return [];
  const table = releaseStatus();
  const targets = releaseChecks.checks.map(({ name, state }) => {
    const [glyph, color] = table[state] ?? table.unknown!;
    return color + glyph + ' ' + safeText(name) + reset;
  });
  return [
    ...targets.length ? [targets.join('  ')] : [],
    ...releaseChecks.checks.filter(check => check.state === 'unknown' && check.detail)
      .map(check => muted + safeText(check.name) + ': ' + safeText(check.detail) + reset),
    ...releaseChecks.error ? [danger + 'Release check failed: ' + safeText(releaseChecks.error) + reset] : [],
  ];
}

/** A card is selectable only when its cached URL is safe to open; `row` is its top padding row. */
function linkCard(lines: string[], width: number, theme: LinkCardTheme, url: unknown, row: number, document?: DocumentBuilder): string[] {
  const link = browserUrl(url) ?? undefined;
  const selected = link && document?.register({ kind: 'open-url', url: link }, row + 1);
  const card = new LinkCard(lines, link, theme);
  card.setSelected(Boolean(selected && document?.focused));
  return card.render(width);
}

export function renderAttachments(attachments: WorkItemDetails['attachments'], width: number, document?: DocumentBuilder): string[] {
  const startRow = document?.lines.length ?? 0;
  const [leftWidth, rightWidth] = columnWidths(width);
  const issues = attachmentsOfType(attachments, 'tracker-item');
  const requests = [...attachmentsOfType(attachments, 'pull-request'), ...attachmentsOfType(attachments, 'change-request')]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const jira = [heading('Attached Jira', issues.length, icons.jira), ''];
  const prs = [heading('Pull requests', requests.length, icons.pr), ''];
  for (const [index, issue] of issues.entries()) {
    const data = issue.payload;
    if (index) jira.push('');
    jira.push(...linkCard([
      accent + bold + safeText(data.key || issue.externalId) + reset,
      safeText(data.title, true),
      jiraStatus(data.status),
    ], leftWidth, jiraCardTheme, data.url, startRow + jira.length, document));
  }
  if (!issues.length) jira.push(muted + '  None attached.' + reset);
  const prStartRow = startRow + (width < COLUMNS_MIN_WIDTH ? jira.length + 1 : 0);
  for (const [index, request] of requests.entries()) {
    const data = request.payload;
    if (index) prs.push('');
    const review = safeText(data.review).toLowerCase();
    const reviewLabel = lookup(reviewStatus(), review, review && review !== 'unknown' ? 'Review: ' + safeText(data.review) : 'Review unknown');
    const build = safeText(data.build).toLowerCase();
    const buildLabel = lookup(buildStatus(), build, build && build !== 'unknown' ? 'Build: ' + build : 'Build unknown');
    const status = safeText(data.status).toLowerCase();
    const checks = reviewLabel + '  ' + buildLabel;
    prs.push(...linkCard([
      bold + '#' + safeText(String(data.number ?? request.externalId)) + reset + '  ' + lookup(prStatus(), status, status || 'Unknown'),
      muted + safeText(data.repository) + reset,
      ...(visibleWidth(checks) <= Card.contentWidth(rightWidth) ? [checks] : [reviewLabel, buildLabel]),
      ...releaseLines('releaseChecks' in data ? data.releaseChecks : undefined),
    ], rightWidth, prCardTheme, data.url, prStartRow + prs.length, document));
  }
  if (!requests.length) prs.push(muted + '  None attached.' + reset);
  return columns(jira, prs, width);
}
