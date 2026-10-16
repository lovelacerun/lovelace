import {
  isWorkspaceMode,
  isWorkItemState,
  WORK_ITEM_STATES,
  type StartWorkRepositoryInput,
  type WorkItemState,
} from '@lovelace/core';
import type { FastifyInstance } from 'fastify';
import { createManualWorkItem, getWorkItemDetails, updateWorkItem } from '../repositories/work-item-repository.js';
import {
  attachPullRequestToWorkItem,
  detachPullRequestFromWorkItem,
  parsePullRequestRef,
  refreshPullRequestsForWorkItem,
} from '../services/pull-request-service.js';
import { attachJiraIssueToWorkItem, detachJiraIssueFromWorkItem, parseJiraIssueRef } from '../services/tracker-item-service.js';
import { beginRepositoryPreparation } from '../services/work-start-service.js';
import type { RouteDeps } from './deps.js';
import { isNonEmptyString } from '../helpers.js';

export function registerWorkItemRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { database, github, releaseChecker, jira, workspaceManager } = deps;
  const workStartDeps = { database, github, logger: app.log, workspaceManager };

  app.get('/work-items', async (request) => {
    const state = (request.query as { state?: WorkItemState }).state;
    return database.listWorkItems(isWorkItemState(state) ? state : undefined);
  });

  app.get('/work-items/:id', async (request, reply) => {
    const params = request.params as { id: string };
    const details = getWorkItemDetails(database, params.id);
    if (!details) {
      reply.code(404);
      return { ok: false, error: 'work item not found' };
    }

    return details;
  });

  app.post('/work-items/:id/repositories', async (request, reply) => {
    const params = request.params as { id: string };
    const body = request.body as { repositories?: unknown; wait?: unknown } | null;
    if (!body || (body.wait !== undefined && typeof body.wait !== 'boolean') || !Array.isArray(body.repositories) || !body.repositories.every(isValidStartWorkRepositoryInput)) {
      reply.code(400);
      return { ok: false, error: 'invalid repository selection payload' };
    }

    try {
      const operation = beginRepositoryPreparation(workStartDeps, params.id, body.repositories);
      if (!operation) {
        reply.code(404);
        return { ok: false, error: 'work item not found' };
      }
      if (body.wait === false) {
        // Disconnecting the caller never cancels server-owned preparation.
        void operation.completion.catch(error => app.log.error({ err: error, workItemId: params.id }, 'Repository preparation operation failed'));
        reply.code(202);
        return operation.details;
      }
      await operation.completion;
      return getWorkItemDetails(database, params.id);
    } catch (error) {
      app.log.error({ err: error, workItemId: params.id, repositories: body.repositories }, 'Failed to attach repositories to work item');
      reply.code(400);
      return { ok: false, error: error instanceof Error ? error.message : 'failed to attach repositories' };
    }
  });

  app.post('/work-items/:id/pull-requests', async (request, reply) => {
    const params = request.params as { id: string };
    const ref = parsePullRequestRef(request.body as { url?: string; repoFullName?: string; number?: number });
    if (!ref) {
      reply.code(400);
      return { ok: false, error: 'body must include a GitHub pull request url or repoFullName and number' };
    }
    try {
      const meta = await attachPullRequestToWorkItem(database, github, params.id, ref, releaseChecker);
      if (!meta) {
        reply.code(404);
        return { ok: false, error: 'work item not found' };
      }
      return meta;
    } catch (error) {
      app.log.error({ err: error, workItemId: params.id, ref }, 'Failed to attach pull request to work item');
      reply.code(400);
      return { ok: false, error: error instanceof Error ? error.message : 'failed to attach pull request' };
    }
  });

  app.delete('/work-items/:id/pull-requests/:externalId', async (request, reply) => {
    const params = request.params as { id: string; externalId: string };
    const ok = detachPullRequestFromWorkItem(database, params.id, decodeURIComponent(params.externalId));
    if (!ok) {
      reply.code(404);
      return { ok: false, error: 'work item not found' };
    }
    return { ok: true };
  });

  app.post('/work-items/:id/pull-requests/refresh', async (request, reply) => {
    const params = request.params as { id: string };
    try {
      const metas = await refreshPullRequestsForWorkItem(database, github, params.id, releaseChecker);
      if (!metas) {
        reply.code(404);
        return { ok: false, error: 'work item not found' };
      }
      return metas;
    } catch (error) {
      app.log.error({ err: error, workItemId: params.id }, 'Failed to refresh pull requests for work item');
      reply.code(400);
      return { ok: false, error: error instanceof Error ? error.message : 'failed to refresh pull requests' };
    }
  });

  app.post('/work-items/:id/tracker-items', async (request, reply) => {
    const params = request.params as { id: string };
    const body = request.body as { provider?: string; key?: string; url?: string };
    if (body.provider !== undefined && body.provider !== 'jira') {
      reply.code(400);
      return { ok: false, error: 'only jira tracker items are supported' };
    }
    const ref = parseJiraIssueRef(body);
    if (!ref) {
      reply.code(400);
      return { ok: false, error: 'body must include a Jira issue key or browse url' };
    }
    try {
      const meta = await attachJiraIssueToWorkItem(database, jira, params.id, ref);
      if (!meta) {
        reply.code(404);
        return { ok: false, error: 'work item not found' };
      }
      return meta;
    } catch (error) {
      app.log.error({ err: error, workItemId: params.id, ref }, 'Failed to attach Jira issue to work item');
      reply.code(400);
      return { ok: false, error: error instanceof Error ? error.message : 'failed to attach Jira issue' };
    }
  });

  app.delete('/work-items/:id/tracker-items/:externalId', async (request, reply) => {
    const params = request.params as { id: string; externalId: string };
    const ok = detachJiraIssueFromWorkItem(database, params.id, decodeURIComponent(params.externalId));
    if (!ok) {
      reply.code(404);
      return { ok: false, error: 'work item not found' };
    }
    return { ok: true };
  });

  app.post('/work-items/manual', async (request, reply) => {
    const body = request.body as {
      title?: string;
      notes?: string;
    };

    if (!body.title?.trim()) {
      reply.code(400);
      return { ok: false, error: 'title is required' };
    }

    return createManualWorkItem(database, {
      title: body.title,
      notes: body.notes,
    });
  });

  app.patch('/work-items/:id', async (request, reply) => {
    const params = request.params as { id: string };
    const body = request.body as { title?: unknown; notes?: unknown };
    const validTitle = body.title === undefined || (typeof body.title === 'string' && body.title.trim());
    const validNotes = body.notes === undefined || body.notes === null || typeof body.notes === 'string';
    if (!validTitle || !validNotes) {
      reply.code(400);
      return { ok: false, error: 'title must be a non-empty string and notes a string or null' };
    }

    const workItem = updateWorkItem(database, params.id, body as { title?: string; notes?: string | null });
    if (!workItem) {
      reply.code(404);
      return { ok: false, error: 'work item not found' };
    }

    return workItem;
  });

  app.post('/work-items/:id/state', async (request, reply) => {
    const params = request.params as { id: string };
    const body = request.body as { state?: WorkItemState };

    if (!isWorkItemState(body.state)) {
      reply.code(400);
      return { ok: false, error: `state must be one of: ${WORK_ITEM_STATES.join(', ')}` };
    }

    const workItem = database.updateWorkItemState(params.id, body.state);
    if (!workItem) {
      reply.code(404);
      return { ok: false, error: 'work item not found' };
    }

    return workItem;
  });
}

function isValidStartWorkRepositoryInput(value: unknown): value is StartWorkRepositoryInput {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (!isNonEmptyString(record.repoId)) return false;
  if (record.role !== undefined && record.role !== 'primary' && record.role !== 'secondary') return false;
  if (record.workspaceMode !== undefined && !isWorkspaceMode(asOptionalString(record.workspaceMode))) return false;
  if (record.sourceExternalId !== undefined && record.sourceExternalId !== null && !isNonEmptyString(record.sourceExternalId)) return false;
  if (record.branchName !== undefined && record.branchName !== null && !isNonEmptyString(record.branchName)) return false;
  if (record.baseBranch !== undefined && record.baseBranch !== null && !isNonEmptyString(record.baseBranch)) return false;
  return true;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
