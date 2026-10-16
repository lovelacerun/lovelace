import type { AppState } from '../state.js';
import { accent, bold, faint, heading, icons, keyColor, muted, reset } from '../theme.js';
import { browserUrl } from '../browser.js';
import { hyperlink } from '@earendil-works/pi-tui';
import { safeText, wrap } from '@lovelace/tui-components';
import { DocumentBuilder, meta, type Document } from './common.js';

export function renderJira(state: AppState, width: number): Document {
  const b = new DocumentBuilder(state, width);
  const issue = state.jiraDetails ?? state.selectedJira;
  if (!issue) {
    b.line('Issue unavailable. Refresh the dashboard.');
    return b.build();
  }
  const gap = () => { if (!state.layout.compact) b.line(); };
  b.line(keyColor + bold + safeText(issue.key) + reset);
  for (const line of wrap(issue.title, width)) b.line(bold + line + reset);
  b.line(muted + meta([accent + icons.active + reset + muted + ' ' + safeText(issue.status ?? 'unknown'),
    'issueType' in issue && issue.issueType && safeText(issue.issueType)]) + reset);
  const url = browserUrl(issue.url);
  b.line(url ? hyperlink(faint + safeText(issue.url) + reset, url) : faint + safeText(issue.url) + reset);
  b.line();
  gap();
  if (state.draft.pendingLaunch) b.action(accent + icons.retry + reset + '  Retry exact saved launch', { kind: 'launch-retry' });
  else b.action(accent + icons.start + reset + '  Start work', { kind: 'jira-setup' }, faint + 'Enter' + reset);
  if (url) b.action(accent + icons.link + reset + '  Open in browser', { kind: 'open-url', url });
  if (state.draft.promptId || state.draft.repoIds?.length) b.line();
  if (state.draft.promptId) b.line(muted + '  Template  ' + reset + safeText(state.draft.promptId));
  if (state.draft.repoIds?.length) {
    b.line(muted + '  Repositories  ' + reset + state.draft.repoIds.map(id => safeText(state.repositories?.find(repo => repo.id === id)?.fullName ?? id)).join(', '));
  }
  b.line();
  gap();
  b.line(heading('Description', '', icons.description));
  gap();
  const description = state.jiraDetails?.descriptionText;
  for (const line of wrap(description ?? 'No cached description. Press r to refresh.', width)) {
    b.line(description ? line : muted + line + reset);
  }
  b.line();
  b.line(faint + 'Start work opens repository selection and the editable prompt.' + reset);
  return b.build();
}
