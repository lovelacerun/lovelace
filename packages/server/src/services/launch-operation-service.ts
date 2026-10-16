import { randomUUID } from 'node:crypto';
import type { QuickStartLaunchOutcome, QuickStartResponse } from '@lovelace/core';
import type { DatabaseState, LaunchOperation } from '../database.js';
import { getWorkItemDetails } from '../repositories/work-item-repository.js';
import { launchOperationSummary } from '../repositories/launch-operation-repository.js';

export class LaunchRequestError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const inFlight = new WeakMap<DatabaseState, Map<string, Promise<QuickStartResponse>>>();

interface LaunchOperationInput {
  requestId?: string;
  wait?: boolean;
  onError?: (error: unknown) => void;
  kind: 'quick-start' | 'new-session';
  input: unknown;
  prepare(requestId: string): { workItemId: string; draftMetaId: string };
  launch(operation: LaunchOperation): Promise<QuickStartLaunchOutcome>;
}

/** Identity, item and exact draft commit before any asynchronous launch side effect. */
export function performLaunchOperation(database: DatabaseState, input: LaunchOperationInput): Promise<QuickStartResponse> {
  const requestId = input.requestId?.toLowerCase() ?? randomUUID();
  const inputJson = JSON.stringify(canonical(input.input));
  let pending = inFlight.get(database);
  if (!pending) { pending = new Map(); inFlight.set(database, pending); }
  const existing = database.getLaunchOperation(requestId);
  if (existing) {
    if (existing.kind !== input.kind || existing.inputJson !== inputJson) {
      return Promise.reject(new LaunchRequestError(409, 'requestId already belongs to another launch intent'));
    }
    const current = pending.get(requestId);
    if (current) return input.wait === false ? Promise.resolve(response(database, existing)) : current;
    return Promise.resolve(getLaunchOperationResponse(database, requestId)!);
  }
  const operation = database.transaction(() => {
    const prepared = input.prepare(requestId);
    return database.createLaunchOperation({ requestId, kind: input.kind, inputJson, ...prepared });
  });
  const task = (async () => {
    let outcome: QuickStartLaunchOutcome;
    try { outcome = await input.launch(operation); }
    catch (error) { outcome = { ok: false, phase: 'failed', error: error instanceof Error ? error.message : String(error) }; }
    database.finishLaunchOperation(requestId, 'completed', outcome);
    return response(database, { ...operation, status: 'completed', outcomeJson: JSON.stringify(outcome) });
  })().finally(() => { if (pending!.get(requestId) === task) pending!.delete(requestId); });
  pending.set(requestId, task);
  if (input.wait === false) {
    // The server owns completion even if the accepting caller disconnects.
    void task.catch(error => input.onError?.(error));
    return Promise.resolve(response(database, database.getLaunchOperation(requestId)!));
  }
  return task;
}

/** Status lookup recovers orphaned outcomes, never launches or replays an operation. */
export function getLaunchOperationResponse(database: DatabaseState, requestId: string): QuickStartResponse | null {
  let operation = database.getLaunchOperation(requestId);
  if (!operation) return null;
  if (operation.status === 'pending' && !inFlight.get(database)?.has(requestId)) {
    const outcome = { ok: false, phase: 'uncertain' as const, error: 'launch outcome uncertain after interruption; check Herdr before an explicit new launch' };
    database.finishLaunchOperation(requestId, 'uncertain', outcome);
    operation = { ...operation, status: 'uncertain', outcomeJson: JSON.stringify(outcome) };
  }
  return response(database, operation);
}

export function recoverInterruptedLaunchOperations(database: DatabaseState): void {
  for (const operation of database.listLaunchOperations()) {
    if (operation.status === 'pending' && !inFlight.get(database)?.has(operation.requestId)) {
      getLaunchOperationResponse(database, operation.requestId);
    }
  }
}

function response(database: DatabaseState, operation: LaunchOperation): QuickStartResponse {
  const details = getWorkItemDetails(database, operation.workItemId);
  if (!details) throw new LaunchRequestError(404, 'work item no longer exists');
  const launch = launchOperationSummary(operation).launch;
  return { details, launch, operation: { requestId: operation.requestId, status: operation.status } };
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}
