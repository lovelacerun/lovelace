import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from './deps.js';
import { buildVisiblePullRequestGroups } from '../services/inbox-query-service.js';
import { refreshGitHubReviews, refreshJiraAssignedIssues } from '../sync.js';

export function registerProviderRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { database, github, releaseChecker, jira } = deps;

  app.get('/github/reviews', async () => buildVisiblePullRequestGroups(database, github));

  app.post('/github/reviews/refresh', async () => {
    await refreshGitHubReviews({ github, database, releaseChecker, logger: app.log });
    return buildVisiblePullRequestGroups(database, github);
  });

  app.get('/jira/issues', async () => jira.peekAssignedIssues()?.value ?? []);

  app.post('/jira/issues/refresh', async () => {
    await refreshJiraAssignedIssues({ jira, logger: app.log });
    return jira.peekAssignedIssues()?.value ?? [];
  });
}
