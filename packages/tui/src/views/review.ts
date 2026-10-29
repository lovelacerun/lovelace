import type { AppState } from '../state.js';
import { accent, bold, faint, icons, keyColor, muted, reset } from '../theme.js';
import { browserUrl } from '../browser.js';
import { hyperlink } from '@earendil-works/pi-tui';
import { safeText, wrap } from '@lovelace/tui-components';
import { DocumentBuilder, meta, type Document } from './common.js';

export function renderReview(state: AppState, width: number): Document {
  const b = new DocumentBuilder(state, width);
  const review = state.selectedReview;
  if (!review) {
    b.line('Review request unavailable. Refresh the dashboard.');
    return b.build();
  }
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
  else if (review.repoId) b.action(accent + icons.start + reset + '  Start review', { kind: 'review-start' }, faint + 'Enter' + reset);
  else b.line(muted + '  ' + safeText(review.repository) + ' is not in the repository catalog.' + reset);
  if (url) b.action(accent + icons.link + reset + '  Open in browser', { kind: 'open-url', url });
  b.line();
  b.line(faint + 'Start review checks out the pull request branch and starts an agent with the review template.' + reset);
  return b.build();
}
