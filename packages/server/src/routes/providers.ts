import { pendingReviewRequests } from '../services/review-request-service.js';
import { refreshGitHubReviews, refreshJiraAssignedIssues } from '../sync.js';
import { procedure, router } from '../trpc.js';

export const githubRouter = router({
  reviewRequests: procedure.query(({ ctx }) => pendingReviewRequests(ctx.database, ctx.github)),

  refreshReviewRequests: procedure.mutation(async ({ ctx: { github, database, logger } }) => {
    await refreshGitHubReviews({ github, database, logger });
    return pendingReviewRequests(database, github);
  }),
});

export const jiraRouter = router({
  issues: procedure.query(({ ctx }) => ctx.jira.peekAssignedIssues()?.value ?? []),

  refreshIssues: procedure.mutation(async ({ ctx: { jira, logger } }) => {
    await refreshJiraAssignedIssues({ jira, logger });
    return jira.peekAssignedIssues()?.value ?? [];
  }),
});
