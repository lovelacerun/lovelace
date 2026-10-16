import type { LaunchPhase, RepositoryWorkspaceMetaPayload, ToolLaunchDraftPayload } from '@lovelace/core';
import { safeText, wrap } from '@lovelace/tui-components';
import type { AppState } from '../state.js';
import { accent, danger, icons, muted, reset, success, warning } from '../theme.js';
import { payload, type DocumentBuilder } from './common.js';

export function launchPhaseLabel(phase: LaunchPhase): string {
  return {
    accepted: 'Launch queued', preparing: 'Preparing repositories', starting: 'Starting agent',
    started: 'Agent started', failed: 'Launch failed', uncertain: 'Launch uncertain',
  }[phase];
}

export function launchPhaseBadge(phase: LaunchPhase, iconOnly = false): string {
  const color = phase === 'failed' ? danger : phase === 'uncertain' ? warning : phase === 'started' ? success : accent;
  const glyph = phase === 'failed' ? icons.cross : phase === 'uncertain' ? icons.warning : phase === 'started' ? icons.check : icons.waiting;
  return color + glyph + (iconOnly ? '' : ' ' + launchPhaseLabel(phase)) + reset;
}

/** Progress belongs to the work item, never to a modal or the current global notice. */
export function renderLaunchProgress(state: AppState, b: DocumentBuilder, width: number): boolean {
  const details = state.selectedWorkItemData;
  const operations = details?.launchOperations ?? [];
  const latest = operations.at(-1);
  const visible = operations.filter(operation => operation.status === 'pending' ||
    (operation === latest && (operation.status === 'uncertain' || !operation.launch.ok)));
  for (const operation of visible) {
    const phase = operation.launch.phase ?? (operation.status === 'pending' ? 'accepted' : 'failed');
    b.line('  ' + launchPhaseBadge(phase));
    const draftMeta = details?.metas.find(meta => meta.id === operation.draftMetaId);
    const draft = draftMeta ? payload(draftMeta) as unknown as ToolLaunchDraftPayload : undefined;
    if ((phase === 'preparing' || phase === 'failed') && draft?.repoIds) {
      for (const meta of details?.metas ?? []) {
        if (meta.metaType !== 'repository') continue;
        const workspace = payload(meta) as unknown as RepositoryWorkspaceMetaPayload;
        if (!draft.repoIds.includes(workspace.repoId) || workspace.status === 'cleaned') continue;
        const color = workspace.status === 'ready' ? success : workspace.status === 'failed' ? danger : muted;
        const step = workspace.preparationStep ? ` — ${safeText(workspace.preparationStep)}` : '';
        const error = workspace.status === 'failed' && workspace.errorMessage ? ` — ${safeText(workspace.errorMessage, true)}` : '';
        for (const line of wrap(`${safeText(workspace.repoName)}: ${safeText(workspace.status)}${step}${error}`, Math.max(1, width - 4))) {
          b.line('    ' + color + line + reset);
        }
      }
    }
    if (operation.launch.error) {
      for (const line of wrap(safeText(operation.launch.error, true), Math.max(1, width - 4))) b.line('    ' + danger + line + reset);
    }
    if (operation.status === 'completed' && !operation.launch.ok && draft?.prompt && details?.workItem.state === 'active') {
      b.action(accent + icons.retry + reset + '  Retry saved prompt', { kind: 'launch-retry', requestId: operation.requestId });
    } else if (operation.status === 'uncertain') {
      for (const line of wrap('Inspect Herdr before starting another session; the saved launch is not replayed.', Math.max(1, width - 4))) {
        b.line('    ' + warning + line + reset);
      }
    }
  }
  return visible.length > 0;
}
