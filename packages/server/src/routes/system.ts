import type { RouteDeps } from './deps.js';
import { procedure, router } from '../trpc.js';

/** Also served as plain `GET /status`: the CLI's version handshake must reach servers from other releases. */
export function serverStatus({ config, database }: Pick<RouteDeps, 'config' | 'database'>) {
  return {
    ok: true as const,
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
  };
}

export const systemRouter = router({
  status: procedure.query(({ ctx }) => serverStatus(ctx)),

  cacheSnapshots: procedure.query(({ ctx }) => ctx.cache.list()),
});
