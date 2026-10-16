import type { FastifyInstance } from 'fastify';
import { refreshTools as discoverTools } from '../tools/tool-loader.js';
import type { RouteDeps } from './deps.js';

export function registerToolRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get('/tools', async () => {
    (deps.refreshTools ?? discoverTools)(deps.tools);
    // A harness whose catalog cannot be listed still launches; its model is then typed.
    return Promise.all(deps.tools.map(async tool => ({ ...tool, models: await deps.listModels(tool).catch(() => []) })));
  });
}
