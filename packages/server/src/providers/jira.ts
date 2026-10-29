import { createJiraClient, type JiraClientOptions, type JiraIssueSummary } from '@lovelace/jira-client';
import type { ServerConfig, TrackerIssue } from '@lovelace/core';
import type { Tracker } from './types.js';

type JiraTrackerOptions = Pick<JiraClientOptions, 'fetch' | 'now' | 'requestTimeoutMs'>;

const ISSUE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const ISSUE_ID_PATTERN = /^\d+$/;
/** Status names treated as finished when Jira reports no status category. */
const TERMINAL_STATUSES = new Set(['done', 'closed', 'resolved', 'cancelled', 'canceled']);

export function createJiraTracker(config: ServerConfig, options: JiraTrackerOptions = {}): Tracker {
  const jira = createJiraClient({ ...config.jira, ...options });
  return {
    provider: 'jira',
    name: 'Jira',
    isConfigured: () => jira.isConfigured(),
    fetchAssignedIssues: async (requestOptions) => (await jira.fetchAssignedIssues(requestOptions)).map(toTrackerIssue),
    async fetchIssue(idOrKey, requestOptions) {
      const issue = await jira.fetchIssue(idOrKey, requestOptions);
      return issue && toTrackerIssue(issue);
    },
    parseIssueRef,
  };
}

function toTrackerIssue(issue: JiraIssueSummary): TrackerIssue {
  return {
    id: issue.id,
    key: issue.key,
    title: issue.title,
    url: issue.url,
    project: issue.project,
    status: issue.status,
    done: issue.statusCategory
      ? issue.statusCategory.trim().toLowerCase() === 'done'
      : TERMINAL_STATUSES.has(issue.status?.trim().toLowerCase() ?? ''),
    issueType: issue.issueType,
    author: issue.author,
    description: issue.descriptionText,
    updatedAt: issue.updatedAt,
  };
}

/** Accepts an issue key ("PROJ-123"), a numeric issue ID or a browse URL. */
function parseIssueRef(input: { key?: string; url?: string }): string | null {
  const key = input.key?.trim();
  if (key && (ISSUE_KEY_PATTERN.test(key) || ISSUE_ID_PATTERN.test(key))) return key.toUpperCase();
  if (!input.url) return null;
  try {
    const parts = new URL(input.url).pathname.split('/').filter(Boolean);
    const browseIndex = parts.indexOf('browse');
    const urlKey = browseIndex >= 0 ? parts[browseIndex + 1] : null;
    return urlKey && ISSUE_KEY_PATTERN.test(urlKey) ? urlKey.toUpperCase() : null;
  } catch {
    return null;
  }
}
