import { attachmentsOfType, isLaunchInProgress, type LaunchState } from '@lovelace/core';
import { safeText, wrap } from '@lovelace/tui-components';
import type { AppState } from '../state.js';
import { accent, danger, icons, muted, reset, success, warning } from '../theme.js';
import type { DocumentBuilder } from './common.js';

export function launchStateLabel(state: LaunchState): string {
  return {
    accepted: 'Launch queued', preparing: 'Preparing repositories', starting: 'Starting agent',
    started: 'Agent started', failed: 'Launch failed', uncertain: 'Launch uncertain',
  }[state];
}

export function launchStateBadge(state: LaunchState, iconOnly = false): string {
  const color = state === 'failed' ? danger : state === 'uncertain' ? warning : state === 'started' ? success : accent;
  const glyph = state === 'failed' ? icons.cross : state === 'uncertain' ? icons.warning : state === 'started' ? icons.check : icons.waiting;
  return color + glyph + (iconOnly ? '' : ' ' + launchStateLabel(state)) + reset;
}

/** Progress belongs to the work item, never to a modal or the current global notice. */
export function renderLaunchProgress(state: AppState, b: DocumentBuilder, width: number): boolean {
  const details = state.selectedWorkItemData;
  const launches = details?.launches ?? [];
  const latest = launches.at(-1);
  const visible = launches.filter(launch => isLaunchInProgress(launch.state) ||
    (launch === latest && (launch.state === 'failed' || launch.state === 'uncertain')));
  for (const launch of visible) {
    b.line('  ' + launchStateBadge(launch.state));
    if (launch.state === 'preparing' || launch.state === 'failed') {
      for (const { payload: workspace } of attachmentsOfType(details?.attachments ?? [], 'worktree')) {
        if (!launch.repoIds.includes(workspace.repoId) || workspace.status === 'cleaned') continue;
        const color = workspace.status === 'ready' ? success : workspace.status === 'failed' ? danger : muted;
        const step = workspace.preparationStep ? ` — ${safeText(workspace.preparationStep)}` : '';
        const error = workspace.status === 'failed' && workspace.errorMessage ? ` — ${safeText(workspace.errorMessage, true)}` : '';
        for (const line of wrap(`${safeText(workspace.repoName)}: ${safeText(workspace.status)}${step}${error}`, Math.max(1, width - 4))) {
          b.line('    ' + color + line + reset);
        }
      }
    }
    if (launch.error) {
      for (const line of wrap(safeText(launch.error, true), Math.max(1, width - 4))) b.line('    ' + danger + line + reset);
    }
    if (launch.state === 'failed' && details?.workItem.state === 'active') {
      b.action(accent + icons.retry + reset + '  Retry saved prompt', { kind: 'launch-retry', launchId: launch.id });
    } else if (launch.state === 'uncertain') {
      for (const line of wrap('Inspect Herdr before starting another session; the saved launch is not replayed.', Math.max(1, width - 4))) {
        b.line('    ' + warning + line + reset);
      }
    }
  }
  return visible.length > 0;
}
