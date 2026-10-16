import { randomUUID } from 'node:crypto';
import type { LovelaceClient } from '@lovelace/client';
import { ApiError } from '@lovelace/client';
import { isCodingHarnessId, type ToolLaunchDraftPayload, type WorkItemState } from '@lovelace/core';
import { isLaunchFocus, type AppState, type PendingLaunch } from './state.js';
import type { Action } from './views/common.js';
import type { KeyIntent } from './keymap.js';
import { errorMessage, isOffline } from './errors.js';

export interface ControllerDeps {
  client: LovelaceClient;
  signal?: AbortSignal;
  /** Called after state mutations when the AppRoot should also re-fetch details. */
  refreshDetails: () => void;
  refreshDashboard: () => void;
  /** Open the single Jira start-work overlay without navigating. */
  startJiraWork: () => void;
  /** Submit the current editor text as a launch request. */
  submitLaunch: (prompt: string) => Promise<void>;
  /** Focus a session's Herdr pane, or continue its ended conversation (meta id). */
  openSession: (metaId: string) => Promise<void>;
  /** Open a provider link using the client machine's default browser. */
  openUrl: (url: string) => Promise<void>;
  /** Clear editor contents + focus elsewhere. */
  resetEditor: () => void;
  /** Focus the Editor component. */
  focusEditor: () => void;
  /** Request a re-render after mutations. */
  invalidate: () => void;
  /** Request a shutdown of the application. */
  quit: () => void;
}

/** Editor input, Enter and `n` are routed by the AppRoot before commands reach here. */
type CommandIntent = Exclude<KeyIntent, { kind: 'editor-input' | 'ignored' | 'enter' | 'focus-editor' }>;

export function handleKey(state: AppState, intent: CommandIntent, deps: ControllerDeps, contentCount: number): void {
  switch (intent.kind) {
    case 'quit':
      deps.quit();
      return;

    case 'refresh':
      deps.refreshDashboard();
      if (state.view !== 'dashboard') deps.refreshDetails();
      return;

    case 'tab':
      state.toggleFocus(contentCount, intent.direction);
      return;

    case 'escape':
      if (state.pendingConfirm) {
        state.pendingConfirm = null;
        state.setNotice(null);
      } else if (state.focus === 'editor' || isLaunchFocus(state.focus)) {
        state.setFocus('content');
      } else if (state.view !== 'dashboard') {
        state.navigateToDashboard();
      } else {
        state.setNotice(null);
        state.setError(null);
      }
      return;

    case 'up':
    case 'down':
      state.move(intent.kind === 'up' ? -1 : 1, contentCount);
      return;

    // A centred dialog asks the confirmation question while one is pending.
    case 'abandon-launch':
      if (state.draft.pendingLaunch && !state.mutationInFlight) {
        state.pendingConfirm = { kind: 'launch-abandon', draftKey: state.draftKey };
        state.changed();
      }
      return;

    case 'state-shortcut':
      if (state.view === 'work-item' && state.selectedWorkItemId) {
        state.pendingConfirm = { kind: 'state', state: intent.target };
        state.changed();
      }
      return;

    case 'confirm-y': {
      const confirm = state.pendingConfirm;
      if (!confirm) return;
      state.pendingConfirm = null;
      state.setNotice(null);
      if (confirm.kind === 'state') {
        void changeWorkItemState(state, deps, confirm.state);
      } else if (state.draftKey === confirm.draftKey && !state.mutationInFlight) {
        abandonLaunchIntent(state);
        deps.resetEditor();
        deps.focusEditor();
      }
      return;
    }
  }
}

export async function handleAction(state: AppState, action: Action, deps: ControllerDeps): Promise<void> {
  switch (action.kind) {
    case 'navigate':
      state.navigate(action.entry);
      deps.refreshDetails();
      return;

    case 'jira-setup':
      deps.startJiraWork();
      return;

    case 'launch-retry': {
      if (state.mutationInFlight) return;
      if (action.requestId) {
        // A completed failure retries the exact server-owned draft on its item,
        // with a new UUID. Never infer a prompt or retry an uncertain launch.
        const operation = state.selectedWorkItemData?.launchOperations?.find(operation => operation.requestId === action.requestId);
        if (!operation || operation.status !== 'completed' || operation.launch.ok) return;
        const meta = state.selectedWorkItemData?.metas.find(meta => meta.id === operation.draftMetaId);
        if (!meta?.payloadJson) return;
        const draft = JSON.parse(meta.payloadJson) as ToolLaunchDraftPayload;
        if (!draft.prompt || !state.selectedWorkItemId || !isCodingHarnessId(draft.toolIds[0])) return;
        state.setDraft({
          text: draft.prompt, repoIds: draft.repoIds ?? undefined, promptId: draft.promptId ?? undefined,
          agentId: draft.toolIds[0], toolOptions: draft.toolOptions, retryWorkId: state.selectedWorkItemId,
          pendingLaunch: undefined, uncertain: false,
        });
        await deps.submitLaunch(draft.prompt);
      } else if (state.draft.pendingLaunch) {
        await deps.submitLaunch(state.draft.pendingLaunch.prompt);
      }
      return;
    }

    case 'open-url':
      if (deps.signal?.aborted) return;
      state.setError(null);
      try {
        await deps.openUrl(action.url);
      } catch (error) {
        if (!deps.signal?.aborted) state.setError(errorMessage(error, 'Opening the browser failed'));
      }
      return;

    case 'session':
      await deps.openSession(action.metaId);
      return;

    case 'edit':
      deps.focusEditor();
      return;

    case 'state':
      await changeWorkItemState(state, deps, action.state);
      return;
  }
}

async function changeWorkItemState(state: AppState, deps: ControllerDeps, target: WorkItemState): Promise<void> {
  const workItemId = state.selectedWorkItemId;
  if (!workItemId) return;
  if (state.mutationInFlight) return;
  state.mutationInFlight = true;
  state.setNotice(`Updating state → ${target}…`);
  try {
    await deps.client.setWorkItemState(workItemId, target, { signal: deps.signal });
    if (deps.signal?.aborted) return;
    state.setNotice(null);
    deps.refreshDetails();
    deps.refreshDashboard();
  } catch (error) {
    if (deps.signal?.aborted) return;
    if (isOffline(error)) state.setOffline();
    else state.setError(errorMessage(error, 'State change failed'));
  } finally {
    state.mutationInFlight = false;
    deps.invalidate();
  }
}

/** Confirmed rejections: the current intent cannot succeed as-is. */
const REJECTED: Record<number, string> = {
  400: 'Launch rejected.',
  404: 'Work item not found.',
  409: 'Work item is not active. Resume it before launching.',
};

/**
 * Shared launch flow used by both quick-start and new-session.
 *
 * - The exact prompt string (including trailing whitespace) is forwarded; only
 *   emptiness is checked via trim. The server is contract-bound to preserve
 *   whitespace verbatim before launch.
 * - The retryWorkId invariant holds: once a work item exists, retries target
 *   the same id via `newSession` to avoid creating duplicates on partial
 *   launch failure.
 * - A stable requestId is pinned with its endpoint and body in
 *   `pendingLaunch`. It is retained across uncertain-outcome retries
 *   (network, timeouts, 5xx) so a lost reply can be safely replayed
 *   server-side; it is cleared only on confirmed success, on authoritative
 *   failure or explicit abandonment. Navigation and editing do not change an
 *   unresolved intent.
 */
export async function submitLaunch(
  state: AppState,
  deps: Pick<ControllerDeps, 'client' | 'signal' | 'refreshDashboard'> & {
    /** Injectable UUID source — tests supply deterministic ids. */
    newRequestId?: () => string;
  },
  prompt: string,
): Promise<void> {
  if (state.mutationInFlight) return;
  if (!(state.draft.pendingLaunch?.prompt ?? prompt).trim()) {
    state.setError('Prompt is empty.');
    return;
  }
  state.mutationInFlight = true;
  const draftKey = state.draftKey;
  const setError = (message: string | null) => { if (state.draftKey === draftKey) state.setError(message); };
  const setNotice = (message: string | null) => { if (state.draftKey === draftKey) state.setNotice(message); };
  const setDraft = (patch: Parameters<AppState['setDraft']>[0]) => state.setDraftForKey(draftKey, patch);
  setError(null);
  setNotice('Launching session…');
  const draft = state.draft;

  // Replay an unresolved launch verbatim, even across navigation: same
  // endpoint, ids, prompt and requestId. Otherwise derive it from the view.
  const target = draft.retryWorkId || (state.view === 'work-item' ? state.selectedWorkItemId ?? undefined : undefined);
  const pendingLaunch: PendingLaunch = draft.pendingLaunch ?? {
    endpoint: target ? 'newSession' : 'quickStart',
    workItemId: target,
    jiraIssueId: !target && state.view === 'jira' ? state.selectedJira?.id : undefined,
    prompt,
    requestId: (deps.newRequestId ?? randomUUID)(),
    repoIds: draft.repoIds ? [...draft.repoIds] : undefined,
    promptId: draft.promptId,
    // A retried server draft keeps its own harness; otherwise use the picker's choice.
    agentId: draft.agentId ?? state.launchAgent,
    toolOptions: draft.agentId ? draft.toolOptions : state.launchToolOptions,
  };
  // Pin pendingLaunch BEFORE firing so a crash in flight is replayable.
  setDraft({ pendingLaunch });

  try {
    const { requestId, repoIds, promptId } = pendingLaunch;
    const options = { signal: deps.signal, repoIds, promptId, wait: false };
    const response = pendingLaunch.endpoint === 'newSession'
      ? await deps.client.newSession(pendingLaunch.workItemId!, pendingLaunch.prompt, pendingLaunch.agentId, pendingLaunch.toolOptions, requestId, options)
      : await deps.client.quickStart(pendingLaunch.prompt, pendingLaunch.jiraIssueId, pendingLaunch.agentId, pendingLaunch.toolOptions, requestId, options);

    const resolvedWorkItemId = response.details.workItem.id;
    setDraft({ retryWorkId: resolvedWorkItemId });
    deps.signal?.throwIfAborted();
    if (state.draftKey === draftKey && state.selectedWorkItemId === resolvedWorkItemId) {
      state.setWorkItemData(response.details);
    }
    deps.refreshDashboard();
    setNotice(null);

    // Durable acceptance hands ownership to the server. Free the originating
    // Home/Jira draft so another task can start while this one provisions.
    if (response.operation?.status === 'pending' && ['accepted', 'preparing', 'starting'].includes(response.launch.phase ?? '')) {
      const currentText = state.drafts.get(draftKey)?.text ?? '';
      setDraft({
        text: currentText === pendingLaunch.prompt ? '' : currentText,
        repoIds: undefined, promptId: undefined, agentId: undefined, toolOptions: undefined,
        retryWorkId: undefined, uncertain: false, pendingLaunch: undefined,
      });
      if (state.draftKey === draftKey) {
        state.navigateToWorkItem(resolvedWorkItemId);
        state.setWorkItemData(response.details);
      }
      return;
    }

    // An absent operation is authoritative ('completed'). Any other outcome
    // keeps pendingLaunch, so the user can inspect sessions or replay it.
    if (response.launch.phase === 'uncertain' || (response.operation?.status ?? 'completed') !== 'completed') {
      setDraft({ uncertain: true, pendingLaunch });
      if (response.launch.ok) setNotice('Launch pending — awaiting confirmation.');
      setError(response.launch.ok ? null : response.launch.error
        ? `Launch outcome uncertain: ${response.launch.error}. Inspect existing sessions or retry.`
        : 'Launch outcome uncertain — inspect existing sessions or retry.');
    } else if (!response.launch.ok) {
      // Confirmed failure: an explicit retry targets newSession on the same
      // work item with a fresh UUID.
      setDraft({ uncertain: false, pendingLaunch: undefined });
      setError(response.launch.error ?? 'Launch failed. Press Enter to retry on this work item.');
    } else {
      // Confirmed success: clear the intent and draft, navigate.
      setDraft({ text: '', repoIds: undefined, promptId: undefined, agentId: undefined, toolOptions: undefined, retryWorkId: undefined, uncertain: false, pendingLaunch: undefined });
      if (state.draftKey === draftKey) {
        state.navigateToWorkItem(resolvedWorkItemId);
        state.setWorkItemData(response.details);
      }
    }
  } catch (error) {
    setNotice(null);
    if (isOffline(error) || (error instanceof Error && error.name === 'AbortError')) {
      setDraft({ uncertain: true, pendingLaunch });
      setError('Launch outcome uncertain — reconnect and inspect existing work before retry.');
    } else if (error instanceof ApiError && error.status >= 500 && error.status < 600) {
      setDraft({ uncertain: true, pendingLaunch });
      setError(error.message || 'Server error — outcome uncertain. Inspect existing work before retry.');
    } else if (error instanceof ApiError && REJECTED[error.status]) {
      // A rejection cannot implicitly abandon an unresolved operation.
      if (!draft.uncertain) setDraft({ pendingLaunch: undefined });
      setError(error.message || REJECTED[error.status]!);
    } else {
      setError(errorMessage(error, 'Launch failed'));
    }
  } finally {
    state.mutationInFlight = false;
    state.changed();
  }
}

/**
 * Explicit abandonment: clears the current draft intent, including its
 * pinned request. Use when the user chooses to discard a stuck launch rather
 * than retry it. Does not touch other drafts.
 */
export function abandonLaunchIntent(state: AppState): void {
  state.setDraft({ text: '', retryWorkId: undefined, uncertain: false, pendingLaunch: undefined });
  state.setError(null);
  state.setNotice(null);
}
