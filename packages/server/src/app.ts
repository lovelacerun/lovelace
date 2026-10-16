import Fastify, { type FastifyBaseLogger } from 'fastify';
import { registerDashboardRoutes } from './routes/dashboard.js';
import type { RouteDeps } from './routes/deps.js';
import { registerEventRoutes } from './routes/events.js';
import { registerInboxRoutes } from './routes/inbox.js';
import { registerPromptRoutes } from './routes/prompts.js';
import { registerProviderRoutes } from './routes/providers.js';
import { registerRepoRoutes } from './routes/repos.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerToolRoutes } from './routes/tools.js';
import { registerWorkItemRoutes } from './routes/work-items.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import { recoverInterruptedLaunchOperations } from './services/launch-operation-service.js';
import { recoverInterruptedRepositoryPreparations } from './services/work-start-service.js';

const ROUTES = [
  registerSystemRoutes,
  registerEventRoutes,
  registerRepoRoutes,
  registerDashboardRoutes,
  registerInboxRoutes,
  registerPromptRoutes,
  registerToolRoutes,
  registerWorkItemRoutes,
  registerWorkspaceRoutes,
  registerProviderRoutes,
];

export function buildServer(deps: RouteDeps, logger?: FastifyBaseLogger) {
  recoverInterruptedRepositoryPreparations(deps.database);
  recoverInterruptedLaunchOperations(deps.database);
  const app = Fastify({ loggerInstance: logger, forceCloseConnections: true });
  for (const register of ROUTES) register(app, deps);
  return app;
}
