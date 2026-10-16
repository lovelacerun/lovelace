import type { RepoRecord } from '@lovelace/core';

/** Name terms intersect; comma-separated topics within a topic: term are alternatives. */
export function filterRepositories(repositories: RepoRecord[], query: string): RepoRecord[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return repositories.filter(repo => terms.every(term => {
    if (term.startsWith('topic:')) {
      const topics = term.slice(6).split(',').filter(Boolean);
      return topics.length === 0 || topics.some(topic => repo.topics.some(value => value.toLowerCase() === topic));
    }
    return repo.fullName.toLowerCase().includes(term);
  }));
}
