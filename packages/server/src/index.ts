import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceManager } from '@lovelace/coriol';
import { loadServerConfig, type AgentCli } from '@lovelace/core';
import { buildServer } from './app.js';
import { createCacheStore } from '@lovelace/cache';
import { createCachedCodeHost, createCachedModels, createCachedTracker } from './cached-providers.js';
import { openDatabase } from './database.js';
import { createGitHubCodeHost } from './providers/github.js';
import { createJiraTracker } from './providers/jira.js';
import { createHerdrClient, herdrSocketPath } from './herdr/herdr-client.js';
import { watchHerdrEvents } from './herdr/herdr-events.js';
import { createLogger } from './logger.js';
import { resolveProviderSecrets } from './secrets.js';
import { startSessionSync } from './services/session-sync.js';
import { refreshAttachedTrackerIssues } from './services/tracker-item-service.js';
import { createReleaseCheckPlugin } from './plugins/release-checks.js';
import { refreshAssignedIssues, refreshReleaseChecks, refreshRepoCache, refreshReviewRequests } from './sync.js';
import { loadTools } from './tools/tool-loader.js';
import { createCoriolEnvironmentPolicy } from './tools/coriol-environment.js';

export { resolveMacOSSystemProxy } from './macos-system-proxy.js';
export { findExecutable } from './tools/executables.js';
export type { AppRouter } from './router.js';

export interface StartServerOptions {
  /** How launched agents call the CLI back; without it prompts get no Lovelace context. */
  agentCli?: AgentCli;
  /** Reported by /status so clients notice a server left running across an upgrade. */
  version?: string;
}

/** Runs the server in this process until SIGTERM/SIGINT. */
export async function startServer(options: StartServerOptions = {}): Promise<void> {
  const config = loadServerConfig();
  config.agentCli = options.agentCli;
  config.version = options.version;
  mkdirSync(join(config.configDir, 'prompts'), { recursive: true });

  const logger = createLogger(config);
  await resolveProviderSecrets(config, logger);
  const database = openDatabase(config);
  // Loads persisted provider data up front so the dashboard renders before the first sync.
  const cache = createCacheStore({
    storage: database.cacheStorage,
    onError: (error, key) => logger.warn({ err: error, key }, 'Provider cache refresh or storage failed'),
  });
  const codeHost = createCachedCodeHost(cache, createGitHubCodeHost(config));
  const tracker = createCachedTracker(cache, createJiraTracker(config));
  const tools = loadTools(logger);
  const workspaceManager = new WorkspaceManager({
    root: config.dataDir,
    toolchainsDirectory: join(config.cacheDir, 'toolchains'),
    environmentPolicy: createCoriolEnvironmentPolicy(),
    logger,
  });
  const herdr = createHerdrClient(config.herdr);
  const releaseChecks = config.plugins?.releaseChecks && createReleaseCheckPlugin(config.plugins.releaseChecks, config.configDir);
  const app = buildServer({ config, tools, listModels: createCachedModels(cache), workspaceManager, herdr, database, cache, codeHost, tracker, releaseChecks }, logger);
  const shutdown = () => {
    void app.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  const refreshRepos = () => void refreshRepoCache({ codeHost, database, logger })
    .catch((error) => logger.error({ err: error }, 'Repository catalog sync failed'));
  const refreshReviews = () => {
    void refreshReviewRequests({ codeHost, database, logger })
      .catch(() => undefined)
      .finally(() => {
        // Runs after the change request refresh so a merge seen there is checked in the same round.
        if (releaseChecks) void refreshReleaseChecks({ plugin: releaseChecks, database, logger }).catch(() => undefined);
      });
  };
  const refreshIssues = () => {
    void refreshAssignedIssues({ tracker, logger })
      .catch(() => undefined)
      .finally(() => {
        // Attached issues drift independently of the assigned-issue list;
        // refresh their status so the dashboard filters finished ones out.
        void refreshAttachedTrackerIssues({ tracker, database, logger })
          .catch((error) => logger.error({ err: error }, 'Attached tracker-item refresh failed'));
      });
  };
  refreshRepos();
  refreshReviews();
  refreshIssues();
  setInterval(refreshRepos, config.syncIntervalMs).unref();
  setInterval(refreshReviews, config.syncIntervalMs).unref();
  setInterval(refreshIssues, config.syncIntervalMs).unref();
  // Herdr owns agent state; follow its events so native identities are recorded before agents exit.
  startSessionSync({
    database, herdr, logger,
    watch: ({ onChange }) => watchHerdrEvents({ socketPath: () => herdrSocketPath(config.herdr), onChange, logger }),
  });

  await app.listen({ port: config.port, host: '127.0.0.1' });
  logger.info({ port: config.port }, 'Lovelace server listening');
}
