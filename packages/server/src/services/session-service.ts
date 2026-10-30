import { randomUUID } from 'node:crypto';
import { dirname, resolve, sep } from 'node:path';
import {
  CODING_HARNESSES, isCodingHarnessId,
  type AgentCli, type AgentSession, type AgentSessionState, type Attachment, type CodingHarnessId, type StartWorkLaunchInput,
  type WorkItemAttachment, type Worktree,
} from '@lovelace/core';
import type { DatabaseState } from '../database.js';
import { attachmentSources } from '../helpers.js';
import { HerdrError, type HerdrClient, type HerdrPane } from '../herdr/herdr-client.js';
import { openLaunchPane } from '../herdr/work-item-workspace.js';
import { addAttachments, getWorkItemDetails } from '../repositories/work-item-repository.js';
import { harnessArguments, isNativeSessionId } from '../tools/harness-arguments.js';
import type { LoadedTool } from '../tools/tool-loader.js';
import { emitActivity } from './activity-bus.js';
import { appendAgentContext } from './agent-context.js';
import { UncertainLaunchError } from './launch-service.js';
import { ensureTaskWorkspacePath } from './task-workspace-service.js';

interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

interface SessionServiceDeps {
  database: DatabaseState;
  herdr: HerdrClient;
  tools: LoadedTool[];
  logger: Logger;
  config: { configDir: string; dataDir: string; port: number; agentCli?: AgentCli };
}

export class SessionRequestError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

/**
 * Starts each requested harness in its own tab of the work item's Herdr
 * workspace and submits the prompt. A session is recorded only once Herdr
 * detected its agent; a failed start leaves its tab for inspection.
 */
export async function launchSessions(deps: SessionServiceDeps, workItemId: string, input: StartWorkLaunchInput): Promise<Array<Attachment<'session'>>> {
  const { database, logger } = deps;
  const details = getWorkItemDetails(database, workItemId);
  if (!details) throw new SessionRequestError(404, 'work item not found');
  if (details.workItem.state !== 'active') throw new SessionRequestError(409, 'work item not active');
  const allWorkspaces = readyWorkspaces(details.attachments);
  const selected = input.repoIds?.length ? allWorkspaces.filter(workspace => input.repoIds!.includes(workspace.repoId)) : allWorkspaces;
  if (selected.length === 0 && (allWorkspaces.length > 0 || input.repoIds?.length)) throw new Error('No ready repository workspaces match this launch');
  const harnesses = [...new Set(input.toolIds)].map(toolId => {
    if (!isCodingHarnessId(toolId) || !deps.tools.some(tool => tool.id === toolId)) {
      throw new Error(`Coding harness ${toolId} is not available. Refresh the tools list and select an installed harness.`);
    }
    return toolId;
  });
  if (harnesses.length === 0) return [];
  const workItem = details.workItem;
  const cwd = launchCwd(selected) ?? ensureTaskWorkspacePath(resolve(deps.config.dataDir, 'workspaces'), workItemId, attachmentSources(details.attachments), workItem.title);

  const created: Array<Attachment<'session'>> = [];
  const failures: string[] = [];
  let uncertain = false;
  for (const toolId of harnesses) {
    const title = harnessTitle(toolId);
    let stage: 'opening' | 'starting' | 'started' = 'opening';
    let paneId: string | undefined;
    try {
      emitActivity({ type: 'tool.launching', workItemId, message: `Launching ${title}` });
      const prompt = input.prompt ? appendAgentContext(input.prompt, deps.config, logger) : null;
      const options = input.toolOptions?.[toolId];
      const agentName = newAgentName();
      // Claude accepts a chosen conversation ID; the others report theirs through Herdr.
      const nativeSessionId = toolId === 'claude' ? randomUUID() : null;
      const pane = await openLaunchPane(database, deps.herdr, workItem, { cwd, label: title });
      paneId = pane.paneId;
      stage = 'starting';
      const ready = await startAgent(deps.herdr, { name: agentName, kind: toolId, paneId: pane.paneId,
        args: [...(nativeSessionId ? ['--session-id', nativeSessionId] : []), ...harnessArguments(toolId, options)] }, { freshPane: true });
      stage = 'started';
      const promptPending = Boolean(prompt) && !(ready && await submitPrompt(deps.herdr, agentName, prompt!));
      // Herdr's integration usually reports the conversation at startup; record it before the agent can exit.
      const reported = (await deps.herdr.listPanes()).find(entry => entry.paneId === pane.paneId && entry.agent === toolId)?.agentSession;
      const payload: AgentSession = {
        terminalRef: { workspaceId: pane.workspaceId, paneId: pane.paneId },
        agentName, nativeSessionId: nativeSessionId ?? reportedSessionId(toolId, reported), nativeSessionPath: reportedSessionPath(reported),
        toolId, options, promptId: input.promptId ?? null, prompt, ...(promptPending ? { promptPending } : {}), title, cwd,
        status: 'running', agentState: !ready ? 'blocked' : prompt && !promptPending ? 'working' : 'idle',
        metadata: { selectedRepoIds: selected.map(workspace => workspace.repoId) },
      };
      created.push(addAttachments(database, workItemId, [{ type: 'session', payload }])[0] as Attachment<'session'>);
      logger.info({ workItemId, toolId, agentName, paneId: pane.paneId }, 'Started agent session in Herdr');
      emitActivity({ type: 'tool.launched', workItemId, message: `${title} launched` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Only a refusal from Herdr proves the agent did not start; after that, it may be running unrecorded.
      const mayRun = stage === 'started' || (stage === 'starting' && !isHerdrRefusal(error));
      uncertain ||= mayRun;
      failures.push(`${title}: ${message}${mayRun ? ` (the agent may be running in Herdr pane ${paneId})` : ''}`);
      logger.error({ err: error, workItemId, toolId }, 'Agent launch failed');
      emitActivity({ type: 'tool.failed', workItemId, message: `${title} failed to launch: ${message}` });
    }
  }
  if (created.length === 0 && failures.length > 0) {
    const message = `Failed to launch ${failures.join('; ')}`;
    throw uncertain ? new UncertainLaunchError(message) : new Error(message);
  }
  return created;
}

const openQueues = new WeakMap<DatabaseState, Map<string, Promise<unknown>>>();

/**
 * Focuses the session's live Herdr pane, or continues its exact native
 * conversation when the agent has ended. Never starts a fresh conversation.
 */
export async function openSession(deps: SessionServiceDeps, workItemId: string, sessionId: string): Promise<'focused' | 'continued'> {
  let queues = openQueues.get(deps.database);
  if (!queues) { queues = new Map(); openQueues.set(deps.database, queues); }
  const previous = queues.get(sessionId);
  const task = (async () => {
    if (previous) await previous.catch(() => undefined);
    return openSessionUnlocked(deps, workItemId, sessionId);
  })();
  queues.set(sessionId, task);
  try { return await task; } finally { if (queues.get(sessionId) === task) queues.delete(sessionId); }
}

async function openSessionUnlocked(deps: SessionServiceDeps, workItemId: string, sessionId: string): Promise<'focused' | 'continued'> {
  const { database, herdr } = deps;
  const details = getWorkItemDetails(database, workItemId);
  if (!details) throw new SessionRequestError(404, 'work item not found');
  if (details.workItem.state !== 'active') throw new SessionRequestError(409, 'work item not active');
  const attachment = details.attachments.find((entry): entry is Attachment<'session'> => entry.id === sessionId && entry.type === 'session');
  if (!attachment || !isCodingHarnessId(attachment.payload.toolId)) throw new SessionRequestError(404, 'session not found');
  const session = attachment.payload;

  const panes = await herdr.listPanes();
  const current = applyObservation(database, attachment, panes);
  const pane = current.terminalRef ? panes.find(entry => entry.paneId === current.terminalRef!.paneId) : undefined;
  if (current.status === 'running' && pane) {
    await herdr.focusTab(pane.tabId);
    return 'focused';
  }

  const toolId = session.toolId as CodingHarnessId;
  const resume = toolId === 'pi' ? current.nativeSessionPath : current.nativeSessionId;
  if (!resume) throw new SessionRequestError(409, 'No native conversation was recorded for this session, so it cannot be continued. Start a new session instead.');
  const args = harnessArguments(toolId, current.options, resume);
  const cwd = current.cwd ?? launchCwd(readyWorkspaces(details.attachments));
  if (!cwd) throw new SessionRequestError(409, 'Session working directory is unknown.');

  let target: { workspaceId: string; tabId: string; paneId: string } | null = null;
  // Prefer the pane whose shell the ended agent left behind.
  if (pane && !pane.agent) {
    try {
      await startAgent(herdr, { name: current.agentName, kind: toolId, paneId: pane.paneId, args });
      target = { workspaceId: pane.workspaceId, tabId: pane.tabId, paneId: pane.paneId };
    } catch (error) {
      if (!(error instanceof HerdrError)) throw error;
      deps.logger.warn({ err: error, workItemId, sessionId }, 'Ended session pane is not an idle shell; continuing in a new tab');
    }
  }
  if (!target) {
    target = await openLaunchPane(database, herdr, details.workItem, { cwd, label: current.title ?? harnessTitle(toolId) });
    await startAgent(herdr, { name: current.agentName, kind: toolId, paneId: target.paneId, args }, { freshPane: true });
  }
  database.updateAttachment('session', attachment.id, {
    ...current, terminalRef: { workspaceId: target.workspaceId, paneId: target.paneId }, status: 'running', agentState: 'idle',
  });
  database.recordWorkActivity({ workItemId, kind: 'session.continued', payload: { metaId: attachment.id, provider: toolId } });
  await herdr.focusTab(target.tabId);
  return 'continued';
}

/**
 * Mirrors Herdr's view of every running session: agent state, the native
 * conversation identity its integration reported, and the end of the agent.
 */
export async function syncSessions(database: DatabaseState, herdr: HerdrClient, now = new Date()): Promise<void> {
  const running = database.listAttachmentsOfType('session').filter(attachment => attachment.payload.status === 'running');
  if (running.length === 0) return;
  const panes = await herdr.listPanes();
  for (const attachment of running) {
    const current = applyObservation(database, attachment, panes, now);
    // A prompt held back by a startup dialog goes out once the agent is ready for input.
    if (current.promptPending && current.prompt && current.status === 'running' && current.agentState === 'idle'
      && await submitPrompt(herdr, current.agentName, current.prompt)) {
      database.updateAttachment('session', attachment.id, { ...current, promptPending: false, agentState: 'working' });
    }
  }
}

/** Panes of sessions Lovelace still considers running, i.e. that Herdr listed at the last sync. */
export function runningSessionPanes(database: DatabaseState): string[] {
  return database.listAttachmentsOfType('session').flatMap(({ payload: session }) =>
    session.status === 'running' && session.terminalRef?.paneId ? [session.terminalRef.paneId] : []);
}

/**
 * Starts the harness; false when Herdr detected it but it opened blocked, for
 * example on a folder trust dialog the user has to answer in the pane.
 */
async function startAgent(herdr: HerdrClient, input: Parameters<HerdrClient['startAgent']>[0], options: { freshPane?: boolean } = {}): Promise<boolean> {
  // A new pane's shell needs a moment before Herdr accepts it as an available shell.
  for (let attempt = 0; ; attempt++) {
    try {
      await herdr.startAgent(input);
      return true;
    } catch (error) {
      if (error instanceof HerdrError && error.code === 'agent_not_ready') return false;
      if (!(options.freshPane && error instanceof HerdrError && error.code === 'agent_pane_busy' && attempt < FRESH_PANE_ATTEMPTS)) throw error;
      await new Promise(resolve => setTimeout(resolve, FRESH_PANE_RETRY_MS));
    }
  }
}

function isHerdrRefusal(error: unknown): boolean {
  return error instanceof HerdrError && error.code !== 'herdr_timeout' && error.code !== 'herdr_invalid_response';
}

const FRESH_PANE_ATTEMPTS = 40;
const FRESH_PANE_RETRY_MS = 250;

/** False when the agent is waiting on a dialog; the prompt is then retried by the sync. */
async function submitPrompt(herdr: HerdrClient, agentName: string, prompt: string): Promise<boolean> {
  try {
    await herdr.promptAgent(agentName, prompt);
    return true;
  } catch (error) {
    if (error instanceof HerdrError && error.code === 'agent_blocked') return false;
    throw error;
  }
}

function applyObservation(database: DatabaseState, attachment: Attachment<'session'>, panes: HerdrPane[], now = new Date()): AgentSession {
  const session = attachment.payload;
  if (session.status !== 'running') return session;
  const pane = session.terminalRef ? panes.find(entry => entry.paneId === session.terminalRef!.paneId) : undefined;
  // Another agent in the same pane is not this session.
  const live = pane?.agent === session.toolId ? pane : undefined;
  const agentState: AgentSessionState = live ? live.agentStatus : 'ended';
  const nativeSessionId = reportedSessionId(session.toolId, live?.agentSession) ?? session.nativeSessionId;
  const nativeSessionPath = reportedSessionPath(live?.agentSession) ?? session.nativeSessionPath;
  const next: AgentSession = { ...session, status: live ? 'running' : 'ended', agentState, nativeSessionId, nativeSessionPath };
  if (agentState === 'working') recordWorked(database, attachment, now);
  if (next.status === session.status && next.agentState === session.agentState
    && next.nativeSessionId === session.nativeSessionId && next.nativeSessionPath === session.nativeSessionPath) return session;
  database.updateAttachment('session', attachment.id, next);
  if (next.agentState !== session.agentState) {
    database.recordWorkActivity({ workItemId: attachment.workItemId, kind: 'session.state-changed', payload: { metaId: attachment.id, from: session.agentState, state: next.agentState } });
  }
  return next;
}

function reportedSessionId(toolId: string, reported: HerdrPane['agentSession'] | undefined): string | null {
  return reported?.kind === 'id' && (toolId === 'pi' || isNativeSessionId(reported.value)) ? reported.value : null;
}

function reportedSessionPath(reported: HerdrPane['agentSession'] | undefined): string | null {
  return reported?.kind === 'path' && reported.value.startsWith('/') ? reported.value : null;
}

/** At most one `session.worked` record per session and local calendar day. */
function recordWorked(database: DatabaseState, attachment: Attachment<'session'>, now: Date): void {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  database.recordWorkActivityOnce(`session-worked:${attachment.id}:${day}`, {
    workItemId: attachment.workItemId, kind: 'session.worked', occurredAt: now.toISOString(), payload: { metaId: attachment.id, date: day },
  });
}

/** Herdr agent names: `[a-z][a-z0-9_-]{0,31}`, unique among live agents. */
function newAgentName(): string {
  return `ll-${randomUUID().slice(0, 8)}`;
}

function harnessTitle(id: CodingHarnessId): string {
  return CODING_HARNESSES.find(harness => harness.id === id)!.title;
}

function readyWorkspaces(attachments: WorkItemAttachment[]): Worktree[] {
  const newest = new Map<string, Worktree>();
  for (const attachment of attachments) {
    if (attachment.type !== 'worktree' || attachment.payload.status !== 'ready') continue;
    const workspace = attachment.payload;
    const existing = newest.get(workspace.worktreePath);
    if (!existing || existing.preparedAt < workspace.preparedAt) newest.set(workspace.worktreePath, workspace);
  }
  return [...newest.values()];
}

/** Worktrees live under a per-task directory; agents start there so one session spans all of them. */
function launchCwd(workspaces: Worktree[]): string | null {
  if (workspaces.length === 0) return null;
  const parents = [...new Set(workspaces.map(workspace => dirname(workspace.worktreePath)))];
  if (parents.length === 1) return parents[0]!;
  const segments = workspaces.map(workspace => resolve(workspace.worktreePath).split(sep).filter(Boolean));
  const common: string[] = [];
  for (let index = 0; index < Math.min(...segments.map(parts => parts.length)); index++) {
    const value = segments[0]![index];
    if (!value || !segments.every(parts => parts[index] === value)) break;
    common.push(value);
  }
  return common.length ? `${sep}${common.join(sep)}` : null;
}

