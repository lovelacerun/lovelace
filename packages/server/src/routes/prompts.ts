import type { RenderPromptInput } from '@lovelace/core';
import type { FastifyInstance } from 'fastify';
import { listPromptTemplates, renderPrompt } from '../services/prompt-service.js';
import type { RouteDeps } from './deps.js';
import { isNonEmptyString } from '../helpers.js';

export function registerPromptRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get('/prompts', async () => listPromptTemplates(deps.config.lovelaceDir));

  app.post('/prompts/render', async (request, reply) => {
    if (!isRenderPromptInput(request.body)) {
      reply.code(400);
      return { ok: false, error: 'invalid prompt render payload' };
    }
    const rendered = renderPrompt(deps.config.lovelaceDir, request.body);
    if (!rendered) {
      reply.code(404);
      return { ok: false, error: 'prompt not found' };
    }
    return rendered;
  });
}

function isRenderPromptInput(value: unknown): value is RenderPromptInput {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (!isNonEmptyString(record.promptId) || !isNonEmptyString(record.title)) return false;
  if (record.sources !== undefined && !Array.isArray(record.sources)) return false;
  if (record.workspacePaths !== undefined && (!Array.isArray(record.workspacePaths) || !record.workspacePaths.every(isNonEmptyString))) return false;
  if (record.context !== undefined && typeof record.context !== 'string') return false;
  return true;
}
