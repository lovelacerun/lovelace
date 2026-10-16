import type { FastifyInstance } from 'fastify';
import { cleanupManagedWorktrees } from '../services/work-start-service.js';
import type { RouteDeps } from './deps.js';

export function registerWorkspaceRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { database, github, workspaceManager } = deps;
  const workStartDeps = { database, github, logger: app.log, workspaceManager };

  app.get('/workspaces/status', async () => {
    const capabilities = workspaceManager.capabilities();
    return {
      copyOnWrite: capabilities.copyOnWrite,
      strategy: capabilities.copyOnWrite.available ? 'reflink' : 'install',
    };
  });

  app.post('/workspaces/cleanup', async (_request, reply) => {
    try {
      return await cleanupManagedWorktrees(workStartDeps);
    } catch (error) {
      reply.code(500);
      return { ok: false, error: error instanceof Error ? error.message : 'failed to clean workspaces' };
    }
  });
}
