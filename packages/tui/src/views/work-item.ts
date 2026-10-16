import type { AppState } from '../state.js';
import { keyColor, warning, bold, accent, muted, faint, success, heading, icons, reset, special } from '../theme.js';
import { safeText, wrap } from '@lovelace/tui-components';
import { renderLaunchProgress } from './launch-progress.js';
import { renderAttachments } from './work-attachments.js';
import { DocumentBuilder, meta, payload, plural, splitIssueKey, stateBadge, type Document } from './common.js';

/** Herdr's agent state: blocked needs input, done finished unseen work. */
function agentState(status: string): string {
  const [glyph, color] = status === 'blocked' ? [icons.warning, warning] : status === 'done' ? [icons.done, warning]
    : status === 'working' ? [icons.online, success] : [icons.todo, faint];
  return color + glyph + ' ' + (color === faint ? muted : '') + status + reset;
}

export function renderWorkItem(state: AppState, width: number): Document {
  const b = new DocumentBuilder(state, width);
  const details = state.selectedWorkItemData;
  if (!details) { b.line(state.offline || state.error ? 'Work item unavailable.' : 'Loading work item…'); b.line(muted + 'Press r to retry if unavailable.' + reset); return b.build(); }
  const { workItem, metas } = details;
  const sessions = metas.filter(meta => meta.metaType === 'session');
  const repositories = metas.filter(meta => meta.metaType === 'repository').length;
  const { key, title } = splitIssueKey(safeText(workItem.title));
  const gap = () => { if (!state.layout.compact) b.line(); };

  if (key) b.line(keyColor + bold + key + reset);
  for (const line of wrap(title, width)) b.line(bold + line + reset);
  b.line(muted + meta([stateBadge(workItem.state) + muted, sessions.length && plural(sessions.length, 'session'),
    repositories && plural(repositories, 'repo')]) + reset);
  b.line();
  gap();

  b.line(heading('Agent sessions', sessions.length || '', icons.session));
  gap();
  for (const sessionMeta of sessions) {
    const session = payload(sessionMeta);
    const status = safeText(session.agentState ?? session.status ?? 'unknown');
    const harness = safeText(session.toolId);
    b.action(special + icons.session + reset + '  ' + safeText(session.title ?? (harness || 'Session')), { kind: 'session', metaId: sessionMeta.id }, agentState(status));
  }
  const hasLaunchProgress = renderLaunchProgress(state, b, width);
  if (!sessions.length && !hasLaunchProgress) b.line(muted + '  No sessions yet.' + reset);
  if (workItem.state !== 'active') b.line(warning + '  Resume local work before launching or attaching.' + reset);
  b.line();
  gap();
  for (const line of renderAttachments(metas, width, b)) b.line(line);
  b.line();
  gap();

  b.line(heading('Local state', '', icons.state));
  b.line(muted + 'Independent of Jira and GitHub.' + reset);
  gap();
  if (workItem.notes) { for (const line of wrap(workItem.notes, width)) b.line(line); gap(); }
  if (workItem.state !== 'active') b.action(accent + icons.resume + reset + '  Resume local work', { kind: 'state', state: 'active' }, faint + 'a' + reset);
  if (workItem.state !== 'done') b.action(accent + icons.done + reset + '  Mark done', { kind: 'state', state: 'done' }, faint + 'd' + reset);
  if (workItem.state !== 'cancelled') b.action(accent + icons.cancel + reset + '  Cancel local work', { kind: 'state', state: 'cancelled' }, faint + 'c' + reset);
  return b.build();
}
