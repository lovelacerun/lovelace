import { randomUUID } from 'node:crypto';
import type { LovelaceClient } from '@lovelace/client';
import type { LaunchResponse, WorkItemState } from '@lovelace/core';
import type { AppState } from './state.js';
import type { Action } from './views/common.js';
import type { KeyIntent } from './keymap.js';
import { errorMessage, errorStatus, isAborted, isOffline } from './errors.js';

export interface ControllerDeps {
  client: LovelaceClient;
  signal?: AbortSignal;
  /** Called after state mutations when the AppRoot should also re-fetch details. */
  refreshDetails: () => void;
  refreshDashboard: () => void;
  /** Open the launch dialog for the current page, without navigating. */
  openLaunchDialog: () => void;
  /** Submit a prompt for the current draft; true once the server accepted it. */
  submitLaunch: (prompt: string) => Promise<boolean>;
  /** Open a provider link using the client machine's default browser. */
  openUrl: (url: string) => Promise<void>;
  /** Request a re-render after mutations. */
  invalidate: () => void;
  /** Request a shutdown of the application. */
  quit: () => void;
}

/** Enter and `n` are routed by the AppRoot before commands reach here. */
type CommandIntent = Exclude<KeyIntent, { kind: 'ignored' | 'enter' | 'new' }>;

export function handleKey(state: AppState, intent: CommandIntent, deps: ControllerDeps, contentCount: number): void {
  switch (intent.kind) {
    case 'quit':
      deps.quit();
      return;

    case 'refresh':
      deps.refreshDashboard();
      if (state.route.kind !== 'home') deps.refreshDetails();
      return;

    case 'tab':
      state.toggleFocus(contentCount, intent.direction);
      return;

    case 'escape':
      if (state.pendingConfirm) {
        state.pendingConfirm = null;
        state.setNotice(null);
      } else if (state.route.kind !== 'home') {
        state.navigateHome();
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
      if (state.route.kind === 'work') {
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

    case 'launch':
      deps.openLaunchDialog();
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
      await openSession(state, deps, action.sessionId);
      return;

    case 'state':
      await changeWorkItemState(state, deps, action.state);
      return;
  }
}

async function changeWorkItemState(state: AppState, deps: ControllerDeps, target: WorkItemState): Promise<void> {
  if (state.route.kind !== 'work' || state.mutationInFlight) return;
  const workItemId = state.route.id;
  state.mutationInFlight = true;
  state.setNotice(`Updating state → ${target}…`);
  try {
    await deps.client.workItems.setState.mutate({ id: workItemId, state: target }, { signal: deps.signal });
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
    const response = await deps.client.launches.retry.mutate({ id: launchId }, { signal: deps.signal });
    if (deps.signal?.aborted) return;
    state.setWorkItemData(response.details);
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
 * Herdr focuses the session's live pane, or continues its exact native
 * conversation when the agent ended. Selecting the session is the request.
 */
async function openSession(state: AppState, deps: ControllerDeps, sessionId: string): Promise<void> {
  const route = state.route;
  if (route.kind !== 'work' || deps.signal?.aborted || state.openingSession) return;
  if (route.details && route.details.workItem.state !== 'active') {
    state.setError('Reactivate local work explicitly (press a, then y) before opening or continuing this session.');
    return;
  }
  const draftKey = state.draftKey;
  state.openingSession = true;
  state.setError(null);
  state.setNotice('Opening session in Herdr…');
  try {
    const response = await deps.client.sessions.open.mutate({ workItemId: route.id, sessionId }, { signal: deps.signal });
    if (deps.signal?.aborted || state.draftKey !== draftKey) return;
    state.setWorkItemData(response.details);
    state.setNotice(response.action === 'continued' ? 'Continued the conversation in Herdr.' : null);
    deps.refreshDashboard();
  } catch (error) {
    if (deps.signal?.aborted || state.draftKey !== draftKey) return;
    state.setNotice(null);
    if (isOffline(error)) state.setOffline();
    else state.setError(errorMessage(error, 'Opening the session failed'));
  } finally {
    state.openingSession = false;
  }
}

/**
 * Shared launch flow of Home, Jira, review and new-session drafts.
 *
 * - The exact prompt string (including trailing whitespace) is forwarded; only
 *   emptiness is checked via trim.
 * - The request ID is saved on the draft before sending. Until the server
 *   answers, submitting again first looks the request ID up, so an edited
 *   draft cannot turn a recorded launch into a conflict; an unknown ID is sent.
 * - Any answer hands the launch to the server: the draft is cleared and the
 *   work item shows its progress, failure and retry.
 *
 * Resolves true once the server accepted the launch.
 */
export async function submitLaunch(
  state: AppState,
  deps: Pick<ControllerDeps, 'client' | 'signal' | 'refreshDashboard'> & {
    /** Injectable UUID source — tests supply deterministic ids. */
    newRequestId?: () => string;
  },
  prompt: string,
): Promise<boolean> {
  if (state.mutationInFlight) return false;
  if (!prompt.trim()) {
    state.setError('Prompt is empty.');
    return false;
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

  const route = state.route;
  try {
    const launch = {
      prompt, agentId: state.launchAgent, options: state.launchToolOptions, requestId,
      repoIds: draft.repoIds, promptId: draft.promptId, wait: false,
    };
    const request = { signal: deps.signal };
    // A resent request the server already recorded is answered by its launch, whatever the draft says now.
    const response = (resend ? await recordedLaunch(deps.client, requestId, deps.signal) : null) ?? (route.kind === 'work'
      ? await deps.client.launches.newSession.mutate({ workItemId: route.id, ...launch }, request)
      : await deps.client.launches.quickStart.mutate({
        ...launch,
        trackerIssueId: route.kind === 'jira' ? route.issue.id : undefined,
        reviewRequestId: route.kind === 'review' ? route.review.id : undefined,
      }, request));
    deps.signal?.throwIfAborted();
    const currentText = state.drafts.get(draftKey)?.text ?? '';
    setDraft({ text: currentText === prompt ? '' : currentText, repoIds: undefined, promptId: undefined, requestId: undefined });
    setNotice(null);
    deps.refreshDashboard();
    if (state.draftKey === draftKey) {
      state.navigateToWorkItem(response.details.workItem.id);
      state.setWorkItemData(response.details);
    }
    return true;
  } catch (error) {
    setNotice(null);
    if (isOffline(error) || isAborted(error)) {
      setError('No reply from the server — reconnect and press Enter to resend; it never launches twice.');
    } else if (errorStatus(error) >= 500) {
      setError(`${errorMessage(error, 'Server error') || 'Server error'} — press Enter to resend; it never launches twice.`);
    } else {
      // A rejection of a resend cannot abandon the launch it might have started.
      if (!resend) setDraft({ requestId: undefined });
      setError(errorMessage(error, 'Launch failed'));
    }
    return false;
  } finally {
    state.mutationInFlight = false;
    state.changed();
  }
}

async function recordedLaunch(client: ControllerDeps['client'], requestId: string, signal?: AbortSignal): Promise<LaunchResponse | null> {
  try {
    return await client.launches.get.query({ id: requestId }, { signal });
  } catch (error) {
    if (errorStatus(error) === 404) return null;
    throw error;
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
