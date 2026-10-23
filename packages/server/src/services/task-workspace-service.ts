import { mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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

/**
 * Finds the work item whose task directory contains `path`, so agents can
 * call back from any of its workspaces without knowing the work item ID.
 */
export function workItemIdForPath(workspacesDirectory: string, path: string, workItemIds: string[]): string | null {
  const taskDirectory = relative(canonical(workspacesDirectory), canonical(path)).split(sep)[0];
  if (!taskDirectory || taskDirectory === '..' || isAbsolute(taskDirectory)) return null;
  const prefix = /--([0-9a-f]{8})$/.exec(taskDirectory)?.[1];
  const matches = prefix ? workItemIds.filter(id => id.startsWith(prefix)) : [];
  return matches.length === 1 ? matches[0]! : null;
}

/** Resolves symlinks (e.g. macOS /var → /private/var) through the nearest existing ancestor. */
function canonical(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonical(parent), basename(absolute));
  }
}
