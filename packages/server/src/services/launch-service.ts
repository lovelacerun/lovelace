import { randomUUID } from 'node:crypto';
import type { Launch, LaunchResponse } from '@lovelace/core';
import { toLaunch, type DatabaseState, type LaunchKind, type LaunchRecord } from '../database.js';
import { getWorkItemDetails } from '../repositories/work-item-repository.js';

export class LaunchRequestError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Thrown by a runner when an agent may have started despite the error; the launch is never retried. */
export class UncertainLaunchError extends Error {}

/** Takes a launch to its agent start, recording progress; throws when it fails. */
export type LaunchRunner = (launch: Launch) => Promise<void>;

const running = new WeakMap<DatabaseState, Map<string, Promise<LaunchResponse>>>();

interface LaunchRequest {
  /** Client request ID; repeating it never launches again. */
  id?: string;
  /** false returns once the launch is recorded; the server finishes it either way. */
  wait?: boolean;
  kind: LaunchKind;
  request: unknown;
  /** Validates the request and records its work item; runs in the transaction that records the launch. */
  prepare(): Pick<Launch, 'workItemId' | 'harness' | 'options' | 'repoIds' | 'promptId' | 'prompt'>;
  run: LaunchRunner;
  onError(error: unknown): void;
}

/** The launch, its prompt and selections commit before any slow or fallible step. */
export function startLaunch(database: DatabaseState, input: LaunchRequest): Promise<LaunchResponse> {
  const id = input.id?.toLowerCase() ?? randomUUID();
  const requestJson = JSON.stringify(canonical(input.request));
  const existing = database.getLaunch(id);
  if (existing) {
    if (existing.kind !== input.kind || existing.requestJson !== requestJson) {
      return Promise.reject(new LaunchRequestError(409, 'This request ID belongs to a different launch; discard it to start a new one.'));
    }
    const current = running.get(database)?.get(id);
    return current && input.wait !== false ? current : Promise.resolve(response(database, existing));
  }
  const launch = database.transaction(() => database.createLaunch({ id, kind: input.kind, requestJson, ...input.prepare() }));
  return execute(database, launch, input);
}

/** Runs a failed launch again with its saved prompt and selections. */
export function retryLaunch(database: DatabaseState, id: string, input: Pick<LaunchRequest, 'run' | 'onError'>): LaunchResponse {
  const launch = database.transaction(() => {
    const current = database.getLaunch(id);
    if (!current) throw new LaunchRequestError(404, 'launch not found');
    if (current.state !== 'failed') throw new LaunchRequestError(409, `Only failed launches can be retried; this one is ${current.state}.`);
    if (database.getWorkItem(current.workItemId)?.state !== 'active') throw new LaunchRequestError(409, 'work item not active');
    database.setLaunchState(id, 'accepted');
    return database.getLaunch(id)!;
  });
  void execute(database, launch, { ...input, wait: false });
  return response(database, database.getLaunch(id)!);
}

export function getLaunchResponse(database: DatabaseState, id: string): LaunchResponse | null {
  const launch = database.getLaunch(id);
  return launch ? response(database, launch) : null;
}

function execute(database: DatabaseState, launch: LaunchRecord, input: Pick<LaunchRequest, 'wait' | 'run' | 'onError'>): Promise<LaunchResponse> {
  let launches = running.get(database);
  if (!launches) { launches = new Map(); running.set(database, launches); }
  const task = (async () => {
    try {
      await input.run(toLaunch(launch));
      database.setLaunchState(launch.id, 'started');
    } catch (error) {
      database.setLaunchState(launch.id, error instanceof UncertainLaunchError ? 'uncertain' : 'failed', error instanceof Error ? error.message : String(error));
    }
    return response(database, database.getLaunch(launch.id)!);
  })().finally(() => { if (launches.get(launch.id) === task) launches.delete(launch.id); });
  launches.set(launch.id, task);
  if (input.wait !== false) return task;
  // The server owns completion even if the accepting caller disconnects.
  task.catch(input.onError);
  return Promise.resolve(response(database, database.getLaunch(launch.id)!));
}

function response(database: DatabaseState, launch: LaunchRecord): LaunchResponse {
  const details = getWorkItemDetails(database, launch.workItemId);
  if (!details) throw new LaunchRequestError(404, 'work item no longer exists');
  return { details, launch: toLaunch(launch) };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}
