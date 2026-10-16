import {
  isCodingHarnessId, isToolLaunchOptionsById, type CodingHarnessId, type DashboardResponse,
  type NewSessionRequest, type QuickStartRequest, type QuickStartResponse, type SessionOpenResponse, type StartWorkLaunchInput,
} from '@lovelace/core';
import type { FastifyInstance } from 'fastify';
import { buildDashboard } from '../services/dashboard-service.js';
import { markToolLaunchDraftLaunched, saveToolLaunchDraft } from '../services/tool-launch-draft-service.js';
import { launchSessions, openSession, SessionRequestError } from '../services/session-service.js';
import { getWorkItemDetails, createActiveWorkItemFromMetas } from '../repositories/work-item-repository.js';
import { getLaunchOperationResponse, LaunchRequestError, performLaunchOperation } from '../services/launch-operation-service.js';
import { repositoryWorkspaces, UUID } from '../helpers.js';
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

  async function launchDraft(requestId: string, workItemId: string, draftMetaId: string, input: StartWorkLaunchInput): Promise<QuickStartResponse['launch']> {
    if (input.repoIds?.length) {
      database.updateLaunchOperationPhase(requestId, 'preparing');
      const details = await attachRepositoriesToExistingWorkItem({ ...deps, logger: app.log }, workItemId,
        input.repoIds.map((repoId, index) => ({ repoId, role: index === 0 ? 'primary' : 'secondary', workspaceMode: 'fresh' })));
      const failed = repositoryWorkspaces(details?.metas ?? [])
        .filter(({ payload }) => input.repoIds!.includes(payload.repoId) && payload.status !== 'ready');
      if (failed.length) throw new Error('Repository preparation failed. Retry on this work item to prepare the selected repositories again.');
    }
    database.updateLaunchOperationPhase(requestId, 'starting');
    refreshTools(tools);
    // Captured before launching: a prompt replaced meanwhile stays pending.
    const draft = database.listWorkItemMeta(workItemId).find((meta) => meta.id === draftMetaId);
    const metas = await launchSessions(sessionDeps, workItemId, input);
    if (!metas.length) return { ok: false, phase: 'failed', error: 'launch produced no sessions' };
    if (draft) markToolLaunchDraftLaunched(database, draft);
    return { ok: true, phase: 'started', error: null };
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
    const launchInput = { toolIds: [intent.agentId ?? config.defaultAgent], toolOptions: intent.options, prompt: intent.prompt, repoIds: intent.repoIds, promptId: intent.promptId };
    try {
      const response = await performLaunchOperation(database, {
        requestId, wait, kind: 'quick-start', input: intent,
        onError: error => app.log.error({ err: error, requestId }, 'Background launch operation failed'),
        prepare(id) {
          const issue = intent.jiraIssueId ? jira.peekAssignedIssues()?.value.find((entry) => entry.id === intent.jiraIssueId) : null;
          if (intent.jiraIssueId && !issue) throw new LaunchRequestError(400, 'jiraIssueId not found in cached Jira issues');
          validateSelection(intent);
          const work = createActiveWorkItemFromMetas(database, {
            title: issue ? `${issue.key}: ${issue.title}` : deriveTitleFromPrompt(intent.prompt),
            metas: issue ? [{ metaType: 'tracker-item', provider: 'jira', externalId: issue.id, payload: issue }] : [],
          });
          const draft = saveToolLaunchDraft(database, work.id, launchInput, id);
          return { workItemId: work.id, draftMetaId: draft.id };
        },
        launch: (operation) => launchDraft(operation.requestId, operation.workItemId, operation.draftMetaId, launchInput),
      });
      if (response.operation?.status === 'pending') reply.code(202);
      return response;
    } catch (error) {
      if (error instanceof LaunchRequestError) return reply.code(error.status).send({ ok: false, error: error.message });
      throw error;
    }
  });

  app.post('/work-items/:id/new-session', async (request, reply) => {
    const params = request.params as { id: string };
    const body = parseNewSessionRequest(request.body);
    if (!body.ok) return reply.code(400).send({ ok: false, error: body.error });
    const { requestId, wait, ...intent } = body.value;
    const launchInput = { toolIds: [intent.agentId ?? config.defaultAgent], toolOptions: intent.options, prompt: intent.prompt, repoIds: intent.repoIds, promptId: intent.promptId };
    try {
      const response = await performLaunchOperation(database, {
        requestId, wait, kind: 'new-session', input: { workItemId: params.id, ...intent },
        onError: error => app.log.error({ err: error, requestId }, 'Background launch operation failed'),
        prepare(id) {
          const details = getWorkItemDetails(database, params.id);
          if (!details) throw new LaunchRequestError(404, 'work item not found');
          if (details.workItem.state !== 'active') throw new LaunchRequestError(409, 'work item not active');
          validateSelection(intent);
          const draft = saveToolLaunchDraft(database, params.id, launchInput, id);
          return { workItemId: params.id, draftMetaId: draft.id };
        },
        launch: (operation) => launchDraft(operation.requestId, operation.workItemId, operation.draftMetaId, launchInput),
      });
      if (response.operation?.status === 'pending') reply.code(202);
      return response;
    } catch (error) {
      if (error instanceof LaunchRequestError) return reply.code(error.status).send({ ok: false, error: error.message });
      throw error;
    }
  });

  app.get('/launch-operations/:requestId', async (request, reply) => {
    const { requestId } = request.params as { requestId: string };
    if (!UUID.test(requestId)) return reply.code(400).send({ ok: false, error: 'requestId must be a UUID' });
    const response = getLaunchOperationResponse(database, requestId.toLowerCase());
    if (!response) return reply.code(404).send({ ok: false, error: 'launch operation not found' });
    return response;
  });

  app.post('/work-items/:id/sessions/:metaId/open', async (request, reply): Promise<SessionOpenResponse | void> => {
    const params = request.params as { id: string; metaId: string };
    try {
      refreshTools(tools);
      const action = await openSession(sessionDeps, params.id, params.metaId);
      return { action, details: getWorkItemDetails(database, params.id)! };
    } catch (error) {
      if (error instanceof SessionRequestError) return reply.code(error.status).send({ ok: false, error: error.message });
      app.log.error({ err: error, workItemId: params.id, sessionMetaId: params.metaId }, 'Failed to open session');
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
  const agentId = parseAgentIdField(record.agentId);
  if (agentId === 'invalid') return { ok: false, error: 'agentId must be pi, claude, or codex' };
  if (record.options !== undefined && !isToolLaunchOptionsById(record.options)) {
    return { ok: false, error: 'invalid harness options' };
  }
  if (record.wait !== undefined && typeof record.wait !== 'boolean') return { ok: false, error: 'wait must be a boolean' };
  const selection = parseSelection(record);
  if (!selection.ok) return selection;
  return { ok: true, value: { ...selection.value, wait: record.wait as boolean | undefined, requestId: record.requestId as string | undefined, prompt, jiraIssueId: jiraIssueId ?? null, agentId: agentId ?? undefined, options: record.options as QuickStartRequest['options'] } };
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
