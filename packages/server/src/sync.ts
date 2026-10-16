import type { CachedGitHub, CachedJira } from './cached-providers.js';
import type { DatabaseState } from './database.js';
import { describeActivityError, emitActivity } from './services/activity-bus.js';
import type { PullRequestReleaseChecker } from './services/pull-request-release-service.js';
import { refreshOpenPullRequests } from './services/pull-request-service.js';

type SyncLogger = Pick<Console, 'info' | 'error' | 'warn'>;

interface SyncJob {
  /** Activity type prefix, e.g. `sync.jira.issues`. */
  type: string;
  provider: 'GitHub' | 'Jira';
  /** Name in skip/failure activity messages, e.g. `issue`. */
  name: string;
  /** Name in log messages, e.g. `assigned issue sync`. */
  logName: string;
  configured: boolean;
  startMessage: string;
  data: Record<string, unknown>;
  run(): Promise<{ message: string; data: Record<string, unknown>; log?: Record<string, unknown>; partial?: boolean }>;
}

/** Shared skip/start/finish/failure activity and logging for provider refreshes. */
async function runSync(logger: SyncLogger, job: SyncJob): Promise<void> {
  if (!job.configured) {
    logger.info(`${job.provider} client not configured, skipping ${job.logName}`);
    emitActivity({ type: `${job.type}.skipped`, message: `Skipped ${job.provider} ${job.name} sync: ${job.provider} is not configured`, data: job.data });
    return;
  }

  emitActivity({ type: `${job.type}.started`, message: job.startMessage, data: job.data });
  try {
    const result = await job.run();
    emitActivity({ type: `${job.type}.${result.partial ? 'partial' : 'finished'}`, message: result.message, data: { ...job.data, ...result.data } });
    logger.info(result.log ?? result.data, `${job.provider} ${job.logName} ${result.partial ? 'partially complete' : 'complete'}`);
  } catch (error) {
    const message = describeActivityError(error);
    emitActivity({ type: `${job.type}.failed`, message: `${job.provider} ${job.name} sync failed: ${message}`, data: { ...job.data, error: message } });
    logger.error({ err: error }, `${job.provider} ${job.logName} failed`);
    throw error;
  }
}

export async function refreshGitHubReviews(deps: {
  github: CachedGitHub;
  database: DatabaseState;
  releaseChecker: PullRequestReleaseChecker;
  logger: SyncLogger;
}) {
  const { github, database, releaseChecker, logger } = deps;
  await runSync(logger, {
    type: 'sync.github.reviews',
    provider: 'GitHub',
    name: 'review',
    logName: 'review sync',
    configured: github.isConfigured(),
    startMessage: 'Syncing GitHub review requests and tracked pull requests',
    data: {
      provider: 'GitHub',
      resource: 'review requests and tracked pull requests',
      filters: ['open pull requests', 'review requested from current user', 'attached PRs awaiting final release'],
    },
    async run() {
      const reviews = await github.refreshReviewRequests();
      const trackedPullRequests = await refreshOpenPullRequests(database, github, releaseChecker, logger);
      const partial = trackedPullRequests.failed > 0;
      return {
        partial,
        message: partial
          ? `Synced GitHub reviews; ${trackedPullRequests.failed} tracked pull request update(s) failed`
          : `Synced ${reviews.human.length} human and ${reviews.automated.length} automated GitHub review request(s)`,
        data: { humanReviewCount: reviews.human.length, automatedReviewCount: reviews.automated.length, trackedPullRequests },
      };
    },
  });
}

export async function refreshJiraAssignedIssues(deps: {
  jira: CachedJira;
  logger: SyncLogger;
}) {
  const { jira, logger } = deps;
  await runSync(logger, {
    type: 'sync.jira.issues',
    provider: 'Jira',
    name: 'issue',
    logName: 'assigned issue sync',
    configured: jira.isConfigured(),
    startMessage: 'Syncing assigned Jira issues',
    data: { provider: 'Jira', resource: 'issues assigned to the current user' },
    async run() {
      const issues = await jira.refreshAssignedIssues();
      return { message: `Synced ${issues.length} assigned Jira issue(s)`, data: { issueCount: issues.length } };
    },
  });
}

export async function refreshJiraProjectCatalog(deps: {
  jira: CachedJira;
  logger: SyncLogger;
}) {
  const { jira, logger } = deps;
  await runSync(logger, {
    type: 'sync.jira.projects',
    provider: 'Jira',
    name: 'project',
    logName: 'project catalog sync',
    configured: jira.isConfigured(),
    startMessage: 'Syncing Jira project catalog',
    data: { provider: 'Jira', resource: 'project catalog' },
    async run() {
      const projects = await jira.refreshProjects();
      return { message: `Synced ${projects.length} Jira project(s)`, data: { projectCount: projects.length } };
    },
  });
}

export async function refreshRepoCache(deps: {
  github: CachedGitHub;
  database: DatabaseState;
  logger: SyncLogger;
}) {
  const { github, database, logger } = deps;
  await runSync(logger, {
    type: 'sync.github.repositories',
    provider: 'GitHub',
    name: 'repository',
    logName: 'repository catalog sync',
    configured: github.isConfigured(),
    startMessage: 'Syncing GitHub repository catalog',
    data: { provider: 'GitHub', resource: 'accessible repository catalog', fields: ['name', 'clone URL', 'default branch', 'archived state', 'topics'] },
    async run() {
      const repos = await github.refreshRepositories();
      database.replaceRepos(repos);
      return { message: `Synced ${repos.length} GitHub repositories`, data: { repositoryCount: repos.length }, log: { repoCount: repos.length } };
    },
  });
}
