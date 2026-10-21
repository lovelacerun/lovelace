import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from './deps.js';

export function registerSystemRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { config, database, cache } = deps;

  app.get('/status', async () => ({
    ok: true,
    version: config.version ?? null,
    pid: process.pid,
    config: {
      domainRoot: config.domainRoot,
      lovelaceDir: config.lovelaceDir,
      port: config.port,
      syncIntervalMs: config.syncIntervalMs,
    },
    repoCount: database.getRepoCount(),
    workItemCount: database.getWorkItemCount(),
    lastRepoSyncAt: database.getLastRepoSyncAt(),
  }));

  app.get('/cache/snapshots', async () => cache.list());
}
