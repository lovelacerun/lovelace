import type { CachedCodeHost, CachedTracker } from './cached-providers.js';
import type { DatabaseState } from './database.js';
import { describeActivityError, emitActivity } from './services/activity-bus.js';
import { refreshOpenChangeRequests } from './services/change-request-service.js';

type SyncLogger = Pick<Console, 'info' | 'error' | 'warn'>;

interface SyncJob {
  /** Activity type prefix, e.g. `sync.jira.issues`. */
  type: string;
  /** Provider display name, e.g. `Jira`. */
  provider: string;
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

export async function refreshReviewRequests(deps: {
  codeHost: CachedCodeHost;
  database: DatabaseState;
  logger: SyncLogger;
}) {
  const { codeHost, database, logger } = deps;
  await runSync(logger, {
    type: `sync.${codeHost.provider}.reviews`,
    provider: codeHost.name,
    name: 'review',
    logName: 'review sync',
    configured: codeHost.isConfigured(),
    startMessage: `Syncing ${codeHost.name} review requests and tracked change requests`,
    data: {
      provider: codeHost.name,
      resource: 'review requests and tracked change requests',
      filters: ['open change requests', 'review requested from current user', 'attached open change requests'],
    },
    async run() {
      const reviews = await codeHost.refreshReviewRequests();
      const trackedChangeRequests = await refreshOpenChangeRequests(database, codeHost, logger);
      const partial = trackedChangeRequests.failed > 0;
      return {
        partial,
        message: partial
          ? `Synced ${codeHost.name} reviews; ${trackedChangeRequests.failed} tracked change request update(s) failed`
          : `Synced ${reviews.length} ${codeHost.name} review request(s)`,
        data: { reviewCount: reviews.length, trackedChangeRequests },
      };
    },
  });
}

export async function refreshAssignedIssues(deps: {
  tracker: CachedTracker;
  logger: SyncLogger;
}) {
  const { tracker, logger } = deps;
  await runSync(logger, {
    type: `sync.${tracker.provider}.issues`,
    provider: tracker.name,
    name: 'issue',
    logName: 'assigned issue sync',
    configured: tracker.isConfigured(),
    startMessage: `Syncing assigned ${tracker.name} issues`,
    data: { provider: tracker.name, resource: 'issues assigned to the current user' },
    async run() {
      const issues = await tracker.refreshAssignedIssues();
      return { message: `Synced ${issues.length} assigned ${tracker.name} issue(s)`, data: { issueCount: issues.length } };
    },
  });
}

export async function refreshRepoCache(deps: {
  codeHost: CachedCodeHost;
  database: DatabaseState;
  logger: SyncLogger;
}) {
  const { codeHost, database, logger } = deps;
  await runSync(logger, {
    type: `sync.${codeHost.provider}.repositories`,
    provider: codeHost.name,
    name: 'repository',
    logName: 'repository catalog sync',
    configured: codeHost.isConfigured(),
    startMessage: `Syncing ${codeHost.name} repository catalog`,
    data: { provider: codeHost.name, resource: 'accessible repository catalog', fields: ['name', 'clone URL', 'default branch', 'archived state', 'topics'] },
    async run() {
      const repos = await codeHost.refreshRepositories();
      database.replaceRepos(repos);
      return { message: `Synced ${repos.length} ${codeHost.name} repositories`, data: { repositoryCount: repos.length }, log: { repoCount: repos.length } };
    },
  });
}
