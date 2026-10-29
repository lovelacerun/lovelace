import { randomUUID } from 'node:crypto';
import type { LovelaceClient } from '@lovelace/client';
import { ApiError } from '@lovelace/client';
import type { WorkItemState } from '@lovelace/core';
import { isLaunchFocus, type AppState } from './state.js';
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
  /** Start the selected review request with the review template. */
  startReview: () => Promise<void>;
  /** Submit the current editor text as a launch request. */
  submitLaunch: (prompt: string) => Promise<void>;
  /** Focus a session's Herdr pane, or continue its ended conversation (meta id). */
  openSession: (sessionId: string) => Promise<void>;
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
      if (state.draft.requestId && !state.mutationInFlight) {
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

    case 'review-start':
      await deps.startReview();
      return;

    case 'launch-retry':
      if (action.launchId) await retryLaunch(state, deps, action.launchId);
      else if (state.draft.requestId) await deps.submitLaunch(state.draft.text);
      return;

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
      await deps.openSession(action.sessionId);
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

/** The server retries a failed launch with its saved prompt and selections. */
async function retryLaunch(state: AppState, deps: ControllerDeps, launchId: string): Promise<void> {
  if (state.mutationInFlight) return;
  state.mutationInFlight = true;
  state.setError(null);
  try {
    const response = await deps.client.retryLaunch(launchId, { signal: deps.signal });
    if (deps.signal?.aborted) return;
    if (state.selectedWorkItemId === response.details.workItem.id) state.setWorkItemData(response.details);
    deps.refreshDashboard();
  } catch (error) {
    if (deps.signal?.aborted) return;
    if (isOffline(error)) state.setOffline();
    else state.setError(errorMessage(error, 'Retry failed'));
  } finally {
    state.mutationInFlight = false;
    deps.invalidate();
  }
}

/**
 * Shared launch flow of Home, Jira, review and new-session drafts.
 *
 * - The exact prompt string (including trailing whitespace) is forwarded; only
 *   emptiness is checked via trim.
 * - The request ID is saved on the draft before sending. Until the server
 *   answers, submitting again resends it, and the server replays that launch
 *   instead of starting another one.
 * - Any answer hands the launch to the server: the draft is cleared and the
 *   work item shows its progress, failure and retry.
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
  if (!prompt.trim()) {
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
  const resend = Boolean(draft.requestId);
  const requestId = draft.requestId ?? (deps.newRequestId ?? randomUUID)();
  setDraft({ requestId });

  try {
    const workItemId = state.view === 'work-item' ? state.selectedWorkItemId ?? undefined : undefined;
    const options = {
      signal: deps.signal, repoIds: draft.repoIds, promptId: draft.promptId, wait: false,
      reviewRequestId: state.view === 'review' ? state.selectedReview?.id : undefined,
    };
    const response = workItemId
      ? await deps.client.newSession(workItemId, prompt, state.launchAgent, state.launchToolOptions, requestId, options)
      : await deps.client.quickStart(prompt, state.view === 'jira' ? state.selectedJira?.id : undefined, state.launchAgent, state.launchToolOptions, requestId, options);
    deps.signal?.throwIfAborted();
    const currentText = state.drafts.get(draftKey)?.text ?? '';
    setDraft({ text: currentText === prompt ? '' : currentText, repoIds: undefined, promptId: undefined, requestId: undefined });
    setNotice(null);
    deps.refreshDashboard();
    if (state.draftKey === draftKey) {
      state.navigateToWorkItem(response.details.workItem.id);
      state.setWorkItemData(response.details);
    }
  } catch (error) {
    setNotice(null);
    if (isOffline(error) || (error instanceof Error && error.name === 'AbortError')) {
      setError('No reply from the server — reconnect and press Enter to resend; it never launches twice.');
    } else if (error instanceof ApiError && error.status >= 500) {
      setError(`${error.message || 'Server error'} — press Enter to resend; it never launches twice.`);
    } else {
      // A rejection of a resend cannot abandon the launch it might have started.
      if (!resend) setDraft({ requestId: undefined });
      setError(errorMessage(error, 'Launch failed'));
    }
  } finally {
    state.mutationInFlight = false;
    state.changed();
  }
}

/**
 * Explicit abandonment: clears the current draft and its unanswered request.
 * Use when the user discards a launch rather than resending it. Does not
 * touch other drafts.
 */
export function abandonLaunchIntent(state: AppState): void {
  state.setDraft({ text: '', requestId: undefined });
  state.setError(null);
  state.setNotice(null);
}
