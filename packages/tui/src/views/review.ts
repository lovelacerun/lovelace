import type { AppState, Route } from '../state.js';
import { accent, bold, faint, icons, keyColor, muted, reset } from '../theme.js';
import { browserUrl } from '../browser.js';
import { hyperlink } from '@earendil-works/pi-tui';
import { safeText, wrap } from '@lovelace/tui-components';
import { DocumentBuilder, meta, type Document } from './common.js';

export function renderReview(state: AppState, { review }: Extract<Route, { kind: 'review' }>, width: number): Document {
  const b = new DocumentBuilder(state, width);
  const gap = () => { if (!state.layout.compact) b.line(); };
  b.line(keyColor + bold + safeText(`${review.repository}#${review.number}`) + reset);
  for (const line of wrap(review.title, width)) b.line(bold + line + reset);
  b.line(muted + meta([review.author && safeText(review.author),
    review.sourceBranch && safeText(review.sourceBranch) + (review.targetBranch ? ' → ' + safeText(review.targetBranch) : '')]) + reset);
  const url = browserUrl(review.url);
  b.line(url ? hyperlink(faint + safeText(review.url) + reset, url) : faint + safeText(review.url) + reset);
  b.line();
  gap();
  if (state.draft.requestId) b.action(accent + icons.retry + reset + '  Resend unanswered launch', { kind: 'launch-retry' });
  else if (review.repoId) b.action(accent + icons.start + reset + '  Start review', { kind: 'launch' }, faint + 'Enter' + reset);
  else b.line(muted + '  ' + safeText(review.repository) + ' is not in the repository catalog.' + reset);
  if (url) b.action(accent + icons.link + reset + '  Open in browser', { kind: 'open-url', url });
  b.line();
  b.line(faint + 'Start review opens the review template with the pull request\'s repository, checked out at its branch.' + reset);
  return b.build();
}
