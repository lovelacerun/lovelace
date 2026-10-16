import type { GitHubReviewRequest } from '@lovelace/core';

export interface PullRequestGroup {
  key: string;
  title: string;
  authors: string[];
  updatedAt: string;
  isAutomated: boolean;
  items: GitHubReviewRequest[];
}

export function groupPullRequests(items: GitHubReviewRequest[]): PullRequestGroup[] {
  const groups = new Map<string, GitHubReviewRequest[]>();

  for (const item of items) {
    const key = buildGroupKey(item.title);
    const existing = groups.get(key);
    if (existing) existing.push(item);
    else groups.set(key, [item]);
  }

  return [...groups.entries()]
    .map(([key, groupedItems]) => {
      const items = groupedItems.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return {
        key,
        title: items[0]?.title ?? 'Pull request group',
        authors: [...new Set(items.map((item) => item.authorLogin).filter(Boolean))] as string[],
        updatedAt: items[0]?.updatedAt ?? new Date(0).toISOString(),
        isAutomated: items.every((item) => isAutomatedAuthor(item.authorLogin)),
        items,
      };
    })
    .sort((a, b) => {
      if (b.items.length !== a.items.length) return b.items.length - a.items.length;
      return a.title.localeCompare(b.title);
    });
}

export function splitPullRequestGroups(groups: PullRequestGroup[]): { human: PullRequestGroup[]; automated: PullRequestGroup[] } {
  return {
    human: groups.filter((group) => !group.isAutomated),
    automated: groups.filter((group) => group.isAutomated),
  };
}

function buildGroupKey(title: string): string {
  const canonical = canonicalizeTitle(title);

  const explicitDependency =
    canonical.match(/\b(?:bump|update)\s+(@?[a-z0-9./_-]+)\s+from\b/i)?.[1] ??
    canonical.match(/\b(?:bump|update)\s+(@?[a-z0-9./_-]+)\s+to\b/i)?.[1] ??
    canonical.match(/\bupdate\s+terraform\s+([a-z0-9./_-]+)\s+to\b/i)?.[1] ??
    canonical.match(/\bupdate\s+([a-z0-9./_-]+\/[a-z0-9._-]+)\s+action\s+to\b/i)?.[1];

  if (explicitDependency) return normalize(explicitDependency);
  if (/all non-major updates/i.test(canonical)) return 'all-non-major-updates';

  return normalize(canonical);
}

function canonicalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^\s*[^a-z0-9]+/i, '')
    .replace(/^[a-z]+\([^)]*\):\s*/i, '')
    .replace(/^[a-z]+:\s*/i, '')
    .replace(/^update dependency\s+/i, 'update ')
    .replace(/^bump dependency\s+/i, 'bump ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function isAutomatedAuthor(login: string | null | undefined): boolean {
  if (!login) return false;
  return /renovate|dependabot|bot/i.test(login);
}
