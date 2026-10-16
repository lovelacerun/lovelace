import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { StartWorkSource } from '@lovelace/core';
import { isNonEmptyString, isRecord, slugify } from '../helpers.js';

/**
 * Returns the stable task directory shared by all repositories and sessions of
 * a work item. An existing directory wins so renaming or linking the work item
 * later does not move sessions and subsequently attached worktrees apart.
 */
export function ensureTaskWorkspacePath(
  workspacesDirectory: string,
  workItemId: string,
  sources: StartWorkSource[],
  title: string,
): string {
  mkdirSync(workspacesDirectory, { recursive: true });
  const suffix = `--${workItemId.slice(0, 8)}`;
  const existing = readdirSync(workspacesDirectory, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && entry.name.endsWith(suffix));
  const workspaceId = existing?.name ?? buildTaskWorkspaceId(workItemId, sources, title);
  const path = join(workspacesDirectory, workspaceId);
  mkdirSync(path, { recursive: true });
  return path;
}

function buildTaskWorkspaceId(workItemId: string, sources: StartWorkSource[], title: string): string {
  const baseName = deriveTaskLabel(sources, title);
  return `${slugify(baseName || 'task')}--${workItemId.slice(0, 8)}`;
}

export function deriveTaskLabel(sources: StartWorkSource[], title: string): string {
  for (const { payload } of sources) {
    if (isRecord(payload) && isNonEmptyString(payload.key)) return payload.key.trim();
  }
  return title;
}
