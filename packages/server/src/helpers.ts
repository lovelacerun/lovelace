import type { LovelaceLink, RepositoryWorkspaceMetaPayload, StartWorkSource, WorkItemMeta } from '@lovelace/core';
import safeParse from '@nkzw/core/safeParse.js';

export const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function truncateText(value: string | null | undefined, maxLength: number): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** Coriol repository ID for a catalog repository. */
export function managedRepositoryId(repository: { provider: string; fullName: string }): string {
  return [repository.provider, ...repository.fullName.split('/')].join('/');
}

export function dedupeLinks(links: LovelaceLink[]): LovelaceLink[] {
  const byKey = new Map<string, LovelaceLink>();
  for (const link of links) {
    const key = `${link.type}:${link.provider}:${link.key ?? ''}:${link.externalId}`;
    if (!byKey.has(key)) byKey.set(key, link);
  }
  return [...byKey.values()];
}

/** Tracker items and change requests attached to a work item. */
export function metaSources(metas: WorkItemMeta[]): StartWorkSource[] {
  return metas.flatMap((meta) => meta.metaType === 'tracker-item' || meta.metaType === 'change-request'
    ? [{ sourceType: meta.metaType, provider: meta.provider ?? 'unknown', externalId: meta.externalId ?? meta.id, payload: safeParse(meta.payloadJson) }]
    : []);
}

function parseRepositoryWorkspacePayload(payloadJson: string | null): RepositoryWorkspaceMetaPayload | null {
  const payload = safeParse<RepositoryWorkspaceMetaPayload>(payloadJson);
  if (!payload?.worktreePath || (payload.workspaceMode !== 'fresh' && payload.workspaceMode !== 'change-request')) return null;
  return payload;
}

/** Repository workspace metas with a valid payload. */
export function repositoryWorkspaces(metas: WorkItemMeta[]): Array<{ meta: WorkItemMeta; payload: RepositoryWorkspaceMetaPayload }> {
  return metas.flatMap((meta) => {
    const payload = meta.metaType === 'repository' ? parseRepositoryWorkspacePayload(meta.payloadJson) : null;
    return payload ? [{ meta, payload }] : [];
  });
}
