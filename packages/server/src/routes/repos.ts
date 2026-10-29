import { refreshRepoCache } from '../sync.js';
import { procedure, router } from '../trpc.js';

export const repositoriesRouter = router({
  list: procedure.query(({ ctx }) => ctx.database.listRepos()),

  sync: procedure.mutation(async ({ ctx: { github, database, logger } }) => {
    await refreshRepoCache({ github, database, logger });
    const repos = database.listRepos();
    return { ok: true as const, repoCount: repos.length, repos };
  }),
});
