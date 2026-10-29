import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import type { RouteDeps } from './routes/deps.js';
import { appRouter, type AppRouter } from './router.js';
import { serverStatus } from './routes/system.js';
import { recoverInterruptedRepositoryPreparations } from './services/work-start-service.js';

export function buildServer(deps: RouteDeps, logger?: FastifyBaseLogger) {
  recoverInterruptedRepositoryPreparations(deps.database);
  deps.database.recoverInterruptedLaunches();
  const app = Fastify({ loggerInstance: logger, forceCloseConnections: true });
  const context = { ...deps, logger: app.log };
  app.get('/status', async () => serverStatus(deps));
  void app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext: () => context,
      onError: ({ error, path }) => {
        if (error.code === 'INTERNAL_SERVER_ERROR') app.log.error({ err: error, path }, 'Request failed');
      },
    },
  } satisfies FastifyTRPCPluginOptions<AppRouter>);
  return app;
}
