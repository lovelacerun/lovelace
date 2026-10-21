import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceManager } from '@lovelace/coriol';
import { loadConfig, type AgentCli } from '@lovelace/core';
import { buildServer } from './app.js';
import { createCacheStore } from '@lovelace/cache';
import { createCachedGitHub, createCachedJira, createCachedModels } from './cached-providers.js';
import { openDatabase } from './database.js';
import { createGitHubClient } from './github.js';
import { createJiraClient } from './jira.js';
import { createHerdrClient } from './herdr/herdr-client.js';
import { createLogger } from './logger.js';
import { resolveProviderSecrets } from './secrets.js';
import { createPullRequestReleaseChecker } from './services/pull-request-release-service.js';
import { syncSessions } from './services/session-service.js';
import { refreshAttachedTrackerIssues } from './services/tracker-item-service.js';
import { refreshGitHubReviews, refreshJiraAssignedIssues, refreshJiraProjectCatalog, refreshRepoCache } from './sync.js';
import { loadTools } from './tools/tool-loader.js';

export { resolveMacOSSystemProxy } from './macos-system-proxy.js';
export { findExecutable } from './tools/executables.js';

const SESSION_SYNC_INTERVAL_MS = 3_000;

export interface StartServerOptions {
  /** How launched agents call the CLI back; without it prompts get no Lovelace context. */
  agentCli?: (port: number) => AgentCli;
}

/** Runs the server in this process until SIGTERM/SIGINT. */
export async function startServer(options: StartServerOptions = {}): Promise<void> {
  const config = loadConfig();
  config.agentCli = options.agentCli?.(config.port);
  mkdirSync(join(config.lovelaceDir, 'prompts'), { recursive: true });

  const logger = createLogger(config);
  await resolveProviderSecrets(config, logger);
  const database = openDatabase(config);
  // Loads persisted provider data up front so the dashboard renders before the first sync.
  const cache = createCacheStore({
    storage: database.cacheStorage,
    onError: (error, key) => logger.warn({ err: error, key }, 'Provider cache refresh or storage failed'),
  });
  const github = createCachedGitHub(cache, createGitHubClient(config));
  const jira = createCachedJira(cache, createJiraClient(config));
  const tools = loadTools(logger);
  const workspaceManager = new WorkspaceManager({ root: config.lovelaceDir, logger });
  const releaseChecker = createPullRequestReleaseChecker({
    config: config.pullRequestReleases,
    lovelaceDir: config.lovelaceDir,
    database,
    workspaceManager,
    logger,
  });
  const herdr = createHerdrClient(config.herdr);
  const app = buildServer({ config, tools, listModels: createCachedModels(cache), workspaceManager, herdr, database, cache, github, releaseChecker, jira }, logger);
  const shutdown = () => {
    void app.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  const refreshRepos = () => void refreshRepoCache({ github, database, logger })
    .catch((error) => logger.error({ err: error }, 'Repository catalog sync failed'));
  const refreshGitHub = () => void refreshGitHubReviews({ github, database, releaseChecker, logger }).catch(() => undefined);
  const refreshJira = () => {
    void refreshJiraAssignedIssues({ jira, logger })
      .catch(() => undefined)
      .finally(() => {
        // Attached Jira issues drift independently of the assigned-issue list;
        // refresh their status so the dashboard filters terminal categories out.
        void refreshAttachedTrackerIssues({ jira, database, logger })
          .catch((error) => logger.error({ err: error }, 'Attached tracker-item refresh failed'));
      });
  };
  const refreshJiraProjects = () => void refreshJiraProjectCatalog({ jira, logger }).catch(() => undefined);
  refreshRepos();
  refreshGitHub();
  refreshJira();
  refreshJiraProjects();
  setInterval(refreshRepos, config.syncIntervalMs).unref();
  setInterval(refreshGitHub, config.syncIntervalMs).unref();
  setInterval(refreshJira, config.syncIntervalMs).unref();
  setInterval(refreshJiraProjects, 24 * 60 * 60 * 1000).unref();
  // Herdr owns agent state; mirror it often enough to catch native identities before agents exit.
  let sessionSync: Promise<void> | null = null;
  setInterval(() => {
    sessionSync ??= syncSessions(database, herdr)
      .catch((error) => logger.warn({ err: error }, 'Herdr session sync failed'))
      .finally(() => { sessionSync = null; });
  }, SESSION_SYNC_INTERVAL_MS).unref();

  await app.listen({ port: config.port, host: '127.0.0.1' });
  logger.info({ port: config.port }, 'Lovelace server listening');
}
