import {
  isCodingHarnessId, isLaunchInProgress, isToolLaunchOptionsById, type CodingHarnessId, type DashboardResponse, type Launch,
  type LaunchResponse, type NewSessionRequest, type QuickStartRequest, type SessionOpenResponse,
} from '@lovelace/core';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { buildDashboard } from '../services/dashboard-service.js';
import { launchSessions, openSession, SessionRequestError } from '../services/session-service.js';
import { getWorkItemDetails, createActiveWorkItem } from '../repositories/work-item-repository.js';
import { getLaunchResponse, LaunchRequestError, retryLaunch, startLaunch } from '../services/launch-service.js';
import { UUID } from '../helpers.js';
import { refreshTools as discoverTools } from '../tools/tool-loader.js';
import type { RouteDeps } from './deps.js';
import { attachRepositoriesToExistingWorkItem } from '../services/work-start-service.js';
import { listPromptTemplates } from '../services/prompt-service.js';

export function registerDashboardRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { database, github, jira, config, tools, herdr } = deps;
  const refreshTools = deps.refreshTools ?? discoverTools;
  const sessionDeps = { database, herdr, tools, logger: app.log, config };
  app.get('/dashboard', async (): Promise<DashboardResponse> => buildDashboard({
    database, github, jira, settings: {
      defaultAgent: config.defaultAgent, sidebarSide: config.tui.sidebarSide,
      repositoryTopics: config.github?.repositoryTopics ?? [],
    }, syncIntervalMs: config.syncIntervalMs,
  }));

  async function runLaunch(launch: Launch): Promise<void> {
    if (launch.repoIds.length) {
      database.setLaunchState(launch.id, 'preparing');
      const details = await attachRepositoriesToExistingWorkItem({ ...deps, logger: app.log }, launch.workItemId,
        launch.repoIds.map((repoId, index) => {
          // A repository with an attached pull request is checked out at its branch.
          const review = reviewSourceFor(launch.workItemId, repoId);
          return { repoId, role: index === 0 ? 'primary' : 'secondary', workspaceMode: review ? 'change-request' : 'fresh', sourceExternalId: review?.externalId ?? null };
        }));
      const failed = (details?.attachments ?? [])
        .filter(attachment => attachment.type === 'worktree' && launch.repoIds.includes(attachment.payload.repoId) && attachment.payload.status !== 'ready');
      if (failed.length) throw new Error('Repository preparation failed. Retry to prepare the selected repositories again.');
    }
    database.setLaunchState(launch.id, 'starting');
    refreshTools(tools);
    const sessions = await launchSessions(sessionDeps, launch.workItemId, {
      toolIds: [launch.harness], toolOptions: launch.options, repoIds: launch.repoIds, promptId: launch.promptId, prompt: launch.prompt,
    });
    if (!sessions.length) throw new Error('launch produced no sessions');
  }

  const onError = (error: unknown) => app.log.error({ err: error }, 'Background launch failed');

  function launchFields(intent: QuickStartRequest | NewSessionRequest) {
    return {
      harness: intent.agentId ?? config.defaultAgent, options: intent.options, repoIds: intent.repoIds ?? [],
      promptId: intent.promptId ?? null, prompt: intent.prompt,
    };
  }

  async function sendLaunch(reply: FastifyReply, launch: () => Promise<LaunchResponse> | LaunchResponse) {
    try {
      const response = await launch();
      if (isLaunchInProgress(response.launch.state)) reply.code(202);
      return response;
    } catch (error) {
      if (error instanceof LaunchRequestError) return reply.code(error.status).send({ ok: false, error: error.message });
      throw error;
    }
  }

  function reviewSourceFor(workItemId: string, repoId: string) {
    const fullName = database.listRepos().find(repo => repo.id === repoId)?.fullName.toLowerCase();
    return database.listAttachmentsOfType('change-request', workItemId)
      .find(attachment => attachment.payload.repoFullName.toLowerCase() === fullName);
  }

  function validateSelection(input: QuickStartRequest | NewSessionRequest): void {
    const repositoryIds = new Set(database.listRepos().map(repo => repo.id));
    for (const id of input.repoIds ?? []) {
      if (!repositoryIds.has(id)) throw new LaunchRequestError(400, `Unknown repository: ${id}`);
    }
    if (input.promptId && !listPromptTemplates(config.lovelaceDir).some(prompt => prompt.id === input.promptId)) {
      throw new LaunchRequestError(400, 'Unknown prompt template');
    }
  }

  app.post('/work-items/quick-start', async (request, reply) => {
    const body = parseQuickStartRequest(request.body);
    if (!body.ok) return reply.code(400).send({ ok: false, error: body.error });
    const { requestId, wait, ...intent } = body.value;
    return sendLaunch(reply, () => startLaunch(database, {
      id: requestId, wait, kind: 'quick-start', request: intent, run: runLaunch, onError,
      prepare() {
        const issue = intent.jiraIssueId ? jira.peekAssignedIssues()?.value.find((entry) => entry.id === intent.jiraIssueId) : null;
        if (intent.jiraIssueId && !issue) throw new LaunchRequestError(400, 'jiraIssueId not found in cached Jira issues');
        const review = intent.reviewRequestId ? github.peekReviewRequests()?.value.find((entry) => entry.id === intent.reviewRequestId) : null;
        if (intent.reviewRequestId && !review) throw new LaunchRequestError(400, 'reviewRequestId not found in cached review requests');
        validateSelection(intent);
        if (review && !database.listRepos().some(repo => intent.repoIds?.includes(repo.id) && repo.fullName.toLowerCase() === review.repoFullName.toLowerCase())) {
          throw new LaunchRequestError(400, `Select ${review.repoFullName} to review its pull request`);
        }
        const work = createActiveWorkItem(database, {
          title: issue ? `${issue.key}: ${issue.title}` : review ? `${review.repoFullName}#${review.number}: ${review.title}` : deriveTitleFromPrompt(intent.prompt),
          attachments: [
            ...issue ? [{ type: 'tracker-item' as const, provider: 'jira', externalId: issue.id, payload: issue }] : [],
            ...review ? [{ type: 'change-request' as const, provider: 'github', externalId: review.id, payload: review }] : [],
          ],
        });
        return { workItemId: work.id, ...launchFields(intent) };
      },
    }));
  });

  app.post('/work-items/:id/new-session', async (request, reply) => {
    const params = request.params as { id: string };
    const body = parseNewSessionRequest(request.body);
    if (!body.ok) return reply.code(400).send({ ok: false, error: body.error });
    const { requestId, wait, ...intent } = body.value;
    return sendLaunch(reply, () => startLaunch(database, {
      id: requestId, wait, kind: 'new-session', request: { workItemId: params.id, ...intent }, run: runLaunch, onError,
      prepare() {
        const details = getWorkItemDetails(database, params.id);
        if (!details) throw new LaunchRequestError(404, 'work item not found');
        if (details.workItem.state !== 'active') throw new LaunchRequestError(409, 'work item not active');
        validateSelection(intent);
        database.touchWorkItem(params.id);
        return { workItemId: params.id, ...launchFields(intent) };
      },
    }));
  });

  app.get('/launches/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ ok: false, error: 'launch ID must be a UUID' });
    const response = getLaunchResponse(database, id.toLowerCase());
    if (!response) return reply.code(404).send({ ok: false, error: 'launch not found' });
    return response;
  });

  app.post('/launches/:id/retry', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ ok: false, error: 'launch ID must be a UUID' });
    return sendLaunch(reply, () => retryLaunch(database, id.toLowerCase(), { run: runLaunch, onError }));
  });

  app.post('/work-items/:id/sessions/:sessionId/open', async (request, reply): Promise<SessionOpenResponse | void> => {
    const params = request.params as { id: string; sessionId: string };
    try {
      refreshTools(tools);
      const action = await openSession(sessionDeps, params.id, params.sessionId);
      return { action, details: getWorkItemDetails(database, params.id)! };
    } catch (error) {
      if (error instanceof SessionRequestError) return reply.code(error.status).send({ ok: false, error: error.message });
      app.log.error({ err: error, workItemId: params.id, sessionId: params.sessionId }, 'Failed to open session');
      return reply.code(502).send({ ok: false, error: error instanceof Error ? error.message : 'failed to open session' });
    }
  });
}

interface ParsedRequest<T> {
  ok: true;
  value: T;
}
interface ParseError {
  ok: false;
  error: string;
}

function parseQuickStartRequest(input: unknown): ParsedRequest<QuickStartRequest> | ParseError {
  if (!input || typeof input !== 'object') return { ok: false, error: 'request body required' };
  const record = input as Record<string, unknown>;
  const prompt = typeof record.prompt === 'string' ? record.prompt : '';
  if (!prompt.trim() || prompt.includes('\0')) return { ok: false, error: 'prompt is required and must not contain NUL' };
  if (record.requestId !== undefined && (typeof record.requestId !== 'string' || !UUID.test(record.requestId))) return { ok: false, error: 'requestId must be a UUID' };
  const jiraIssueId = normalizeOptionalString(record.jiraIssueId);
  if (jiraIssueId === undefined && record.jiraIssueId !== undefined && record.jiraIssueId !== null) {
    return { ok: false, error: 'jiraIssueId must be a string' };
  }
  const reviewRequestId = normalizeOptionalString(record.reviewRequestId);
  if (reviewRequestId === undefined && record.reviewRequestId !== undefined && record.reviewRequestId !== null) {
    return { ok: false, error: 'reviewRequestId must be a string' };
  }
  const agentId = parseAgentIdField(record.agentId);
  if (agentId === 'invalid') return { ok: false, error: 'agentId must be pi, claude, or codex' };
  if (record.options !== undefined && !isToolLaunchOptionsById(record.options)) {
    return { ok: false, error: 'invalid harness options' };
  }
  if (record.wait !== undefined && typeof record.wait !== 'boolean') return { ok: false, error: 'wait must be a boolean' };
  const selection = parseSelection(record);
  if (!selection.ok) return selection;
  return { ok: true, value: { ...selection.value, wait: record.wait as boolean | undefined, requestId: record.requestId as string | undefined, prompt, jiraIssueId: jiraIssueId ?? null, reviewRequestId: reviewRequestId ?? null, agentId: agentId ?? undefined, options: record.options as QuickStartRequest['options'] } };
}

function parseNewSessionRequest(input: unknown): ParsedRequest<NewSessionRequest> | ParseError {
  if (!input || typeof input !== 'object') return { ok: false, error: 'request body required' };
  const record = input as Record<string, unknown>;
  const prompt = typeof record.prompt === 'string' ? record.prompt : '';
  if (!prompt.trim() || prompt.includes('\0')) return { ok: false, error: 'prompt is required and must not contain NUL' };
  const agentId = parseAgentIdField(record.agentId);
  if (agentId === 'invalid') return { ok: false, error: 'agentId must be pi, claude, or codex' };
  if (record.options !== undefined && !isToolLaunchOptionsById(record.options)) {
    return { ok: false, error: 'invalid harness options' };
  }
  if (record.requestId !== undefined && (typeof record.requestId !== 'string' || !UUID.test(record.requestId))) return { ok: false, error: 'requestId must be a UUID' };
  if (record.wait !== undefined && typeof record.wait !== 'boolean') return { ok: false, error: 'wait must be a boolean' };
  const selection = parseSelection(record);
  if (!selection.ok) return selection;
  return { ok: true, value: { ...selection.value, wait: record.wait as boolean | undefined, requestId: record.requestId as string | undefined, prompt, agentId: agentId ?? undefined, options: record.options as NewSessionRequest['options'] } };
}

function parseSelection(record: Record<string, unknown>): ParsedRequest<Pick<QuickStartRequest, 'repoIds' | 'promptId'>> | ParseError {
  if (record.repoIds !== undefined && (!Array.isArray(record.repoIds) || record.repoIds.length > 100 ||
    !record.repoIds.every(id => typeof id === 'string' && id.trim() && !id.includes('\0')) ||
    new Set(record.repoIds).size !== record.repoIds.length)) return { ok: false, error: 'repoIds must contain unique repository IDs (at most 100)' };
  if (record.promptId !== undefined && (typeof record.promptId !== 'string' || !record.promptId.trim())) {
    return { ok: false, error: 'promptId must be a nonempty string' };
  }
  return { ok: true, value: { repoIds: record.repoIds as string[] | undefined, promptId: record.promptId as string | undefined } };
}

function parseAgentIdField(value: unknown): CodingHarnessId | undefined | 'invalid' {
  if (value === undefined) return undefined;
  return isCodingHarnessId(value) ? value : 'invalid';
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function deriveTitleFromPrompt(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? 'Quick start';
  return firstLine.length > 120 ? `${firstLine.slice(0, 119)}…` : firstLine;
}
