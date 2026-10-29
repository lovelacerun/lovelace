import type { AppState } from '../state.js';
import type { Document } from './common.js';
import { renderDashboard } from './dashboard.js';
import { renderJira } from './jira.js';
import { renderReview } from './review.js';
import { renderWorkItem } from './work-item.js';

/** The current route's page. Offline, it keeps the last-known one; the help bar says so. */
export function renderPage(state: AppState, width: number): Document {
  const route = state.route;
  if (route.kind === 'work') return renderWorkItem(state, route, width);
  if (route.kind === 'jira') return renderJira(state, route, width);
  if (route.kind === 'review') return renderReview(state, route, width);
  return renderDashboard(state, width);
}
