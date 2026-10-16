import type { CacheStore } from '@lovelace/cache';
import type { WorkspaceManager } from '@lovelace/coriol';
import type { LovelaceConfig } from '@lovelace/core';
import type { CachedGitHub, CachedJira, ModelLister } from '../cached-providers.js';
import type { DatabaseState } from '../database.js';
import type { HerdrClient } from '../herdr/herdr-client.js';
import type { PullRequestReleaseChecker } from '../services/pull-request-release-service.js';
import type { LoadedTool } from '../tools/tool-loader.js';

export interface RouteDeps {
  config: LovelaceConfig;
  tools: LoadedTool[];
  /** Injectable discovery seam; fixture tests must not launch installed harnesses. */
  refreshTools?: (tools: LoadedTool[]) => void;
  /** Each detected harness's model catalog, cached. */
  listModels: ModelLister;
  workspaceManager: WorkspaceManager;
  herdr: HerdrClient;
  database: DatabaseState;
  /** Exposed for diagnostics only; services use the cached provider accessors. */
  cache: CacheStore;
  github: CachedGitHub;
  releaseChecker: PullRequestReleaseChecker;
  jira: CachedJira;
}
