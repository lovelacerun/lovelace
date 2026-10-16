import type { InboxSourceType } from '@lovelace/core';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from './deps.js';
import { isNonEmptyString } from '../helpers.js';
import type { ActivateInboxInput, DismissInboxInput, InboxActionSource } from '../services/inbox-command-service.js';
import { activateInboxItem, dismissInboxItem } from '../services/inbox-command-service.js';
import { buildInbox } from '../services/inbox-query-service.js';

export function registerInboxRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { database, github, jira, config } = deps;

  app.get('/inbox', async () => buildInbox(database, { github, jira, jiraBaseUrl: config.jira?.siteUrl ?? config.jira?.baseUrl ?? null }));

  app.post('/inbox/activate', async (request, reply) => {
    if (!isValidActivateInboxInput(request.body)) {
      reply.code(400);
      return { ok: false, error: 'invalid inbox activation payload' };
    }

    const workItem = activateInboxItem(database, request.body);
    if (!workItem) {
      reply.code(404);
      return { ok: false, error: 'inbox item not found' };
    }

    return workItem;
  });

  app.post('/inbox/dismiss', async (request, reply) => {
    if (!isValidDismissInboxInput(request.body)) {
      reply.code(400);
      return { ok: false, error: 'invalid inbox dismiss payload' };
    }

    const result = dismissInboxItem(database, request.body);
    if (!result) {
      reply.code(404);
      return { ok: false, error: 'inbox item not found' };
    }

    return result;
  });
}

function isValidActivateInboxInput(value: unknown): value is ActivateInboxInput {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;

  if (record.sourceType === 'work-item') {
    return isNonEmptyString(record.id);
  }

  return isNonEmptyString(record.title) && isValidInboxSources(record.sources, true);
}

function isValidDismissInboxInput(value: unknown): value is DismissInboxInput {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;

  if (record.sourceType === 'work-item') {
    return isNonEmptyString(record.id);
  }

  return isValidInboxSources(record.sources, false);
}

function isValidInboxSources(value: unknown, allowPayload: boolean): value is InboxActionSource[] {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => isValidInboxSource(entry, allowPayload));
}

function isValidInboxSource(value: unknown, allowPayload: boolean): value is InboxActionSource {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;

  if (!isInboxSourceType(record.sourceType)) return false;
  if (!isNonEmptyString(record.provider) || !isNonEmptyString(record.externalId)) return false;
  if (!allowPayload && 'payload' in record) return false;
  return true;
}

function isInboxSourceType(value: unknown): value is InboxSourceType {
  return value === 'tracker-item' || value === 'change-request';
}
