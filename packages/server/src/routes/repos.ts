import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from './deps.js';
import { refreshRepoCache } from '../sync.js';

export function registerRepoRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { database, github } = deps;

  app.get('/repos', async () => database.listRepos());

  app.post('/repos/sync', async () => {
    await refreshRepoCache({ github, database, logger: app.log });
    const repos = database.listRepos();
    return { ok: true, repoCount: repos.length, repos };
  });
}
