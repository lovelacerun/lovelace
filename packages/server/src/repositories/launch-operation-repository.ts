import type { LaunchOperationSummary } from '@lovelace/core';
import type { LaunchOperation } from '../database.js';

export function launchOperationSummary(operation: LaunchOperation): LaunchOperationSummary {
  return {
    requestId: operation.requestId, draftMetaId: operation.draftMetaId, status: operation.status,
    launch: operation.outcomeJson ? JSON.parse(operation.outcomeJson) as LaunchOperationSummary['launch']
      : { ok: false, error: null, phase: 'accepted' },
  };
}

/** Active launches take priority; an explicit later launch supersedes an old failure. */
export function latestLaunchPhase(operations: LaunchOperation[]) {
  const current = operations.findLast(operation => operation.status === 'pending') ?? operations.at(-1);
  const phase = current ? launchOperationSummary(current).launch.phase : undefined;
  return phase === 'started' ? undefined : phase;
}
