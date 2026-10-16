import { createJiraClient as createProvider, type JiraClientOptions } from '@lovelace/jira-client';
import type { LovelaceConfig } from '@lovelace/core';

type JiraAdapterOptions = Pick<JiraClientOptions, 'fetch' | 'now' | 'requestTimeoutMs'>;

export function createJiraClient(config: LovelaceConfig, options: JiraAdapterOptions = {}) {
  return createProvider({ ...config.jira, ...options });
}
