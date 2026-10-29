import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from './deps.js';
import { pendingReviewRequests } from '../services/review-request-service.js';
import { refreshGitHubReviews, refreshJiraAssignedIssues } from '../sync.js';

export function registerProviderRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { database, github, jira } = deps;

  app.get('/github/reviews', async () => pendingReviewRequests(database, github));

  app.post('/github/reviews/refresh', async () => {
    await refreshGitHubReviews({ github, database, logger: app.log });
    return pendingReviewRequests(database, github);
  });

  app.get('/jira/issues', async () => jira.peekAssignedIssues()?.value ?? []);

  app.post('/jira/issues/refresh', async () => {
    await refreshJiraAssignedIssues({ jira, logger: app.log });
    return jira.peekAssignedIssues()?.value ?? [];
  });
}
