import type { GitHubReviewRequest, JiraIssueSummary, LovelaceLink } from '@lovelace/core';
import type { JiraProjectSummary } from '@lovelace/jira-client';
import { dedupeLinks, isNonEmptyString } from '../helpers.js';

interface ChangeRequestLinkInference {
  changeRequestId: string;
  links: LovelaceLink[];
}

/** Jira keys mentioned in change requests, limited to known project keys. */
export function inferChangeRequestLinks(
  changeRequests: GitHubReviewRequest[],
  issues: JiraIssueSummary[],
  projects: JiraProjectSummary[],
  jiraBaseUrl: string | null,
): ChangeRequestLinkInference[] {
  const projectKeys = unique([
    ...projects.map((project) => project.key),
    ...issues.map((issue) => issue.key.split('-')[0] ?? '').filter(Boolean),
  ]);
  const keyPattern = buildTrackerKeyPattern(projectKeys);
  if (!keyPattern) return [];

  const issuesByKey = new Map(issues.map((issue) => [issue.key.toUpperCase(), issue]));
  return changeRequests.flatMap((changeRequest) => {
    const keys = extractTrackerKeys(changeRequest, keyPattern);
    if (keys.length === 0) return [];

    const links = keys.map((key) => {
      const issue = issuesByKey.get(key.toUpperCase());
      return {
        type: 'tracker-item' as const,
        provider: 'jira',
        externalId: issue?.id ?? key,
        key,
        url: issue?.url ?? (jiraBaseUrl ? `${jiraBaseUrl.replace(/\/$/, '')}/browse/${key}` : null),
        source: 'inferred' as const,
      } satisfies LovelaceLink;
    });

    return [{ changeRequestId: changeRequest.id, links: dedupeLinks(links) }];
  });
}

function extractTrackerKeys(changeRequest: GitHubReviewRequest, pattern: RegExp): string[] {
  const fields = [changeRequest.title, changeRequest.descriptionText, changeRequest.headRefName]
    .filter(isNonEmptyString);

  const matches = new Set<string>();
  for (const field of fields) {
    for (const match of field.matchAll(pattern)) {
      const key = match[0]?.toUpperCase();
      if (key) matches.add(key);
    }
  }
  return [...matches].sort();
}

function buildTrackerKeyPattern(projectKeys: string[]): RegExp | null {
  if (projectKeys.length === 0) return null;
  const alternatives = projectKeys
    .map((key) => key.trim().toUpperCase())
    .filter(Boolean)
    .map(escapeRegExp)
    .sort((a, b) => b.length - a.length);
  if (alternatives.length === 0) return null;
  return new RegExp(`\\b(?:${alternatives.join('|')})-\\d+\\b`, 'g');
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
