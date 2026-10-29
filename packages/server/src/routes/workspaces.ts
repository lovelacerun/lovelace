import { cleanupManagedWorktrees } from '../services/work-start-service.js';
import { procedure, router } from '../trpc.js';

export const workspacesRouter = router({
  status: procedure.query(({ ctx }) => {
    const capabilities = ctx.workspaceManager.capabilities();
    return { ...capabilities, strategy: capabilities.copyOnWrite.available ? 'reflink' as const : 'install' as const };
  }),

  /** Removes worktrees of work items completed longer than the retention period. */
  cleanup: procedure.mutation(({ ctx: { database, codeHost, logger, workspaceManager } }) =>
    cleanupManagedWorktrees({ database, codeHost, logger, workspaceManager })),
});
