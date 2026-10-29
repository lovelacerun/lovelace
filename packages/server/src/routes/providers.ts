import { pendingReviewRequests } from '../services/review-request-service.js';
import { refreshAssignedIssues, refreshReviewRequests } from '../sync.js';
import { procedure, router } from '../trpc.js';

export const codeHostRouter = router({
  reviewRequests: procedure.query(({ ctx }) => pendingReviewRequests(ctx.database, ctx.codeHost)),

  refreshReviewRequests: procedure.mutation(async ({ ctx: { codeHost, database, logger } }) => {
    await refreshReviewRequests({ codeHost, database, logger });
    return pendingReviewRequests(database, codeHost);
  }),
});

export const trackerRouter = router({
  issues: procedure.query(({ ctx }) => ctx.tracker.peekAssignedIssues()?.value ?? []),

  refreshIssues: procedure.mutation(async ({ ctx: { tracker, logger } }) => {
    await refreshAssignedIssues({ tracker, logger });
    return tracker.peekAssignedIssues()?.value ?? [];
  }),
});
