import assert from 'node:assert/strict';
import { TRPCError, type TRPC_ERROR_CODE_KEY } from '@trpc/server';
import { pino } from 'pino';
import { createCaller } from '../router.js';
import type { RouteDeps } from '../routes/deps.js';

/** Calls procedures in-process; reads `deps` on every call so tests may swap seams after setup. */
export function callerFor(deps: RouteDeps) {
  const logger = pino({ level: 'silent' });
  return createCaller(() => ({ ...deps, logger }));
}

/** Asserts that a procedure call rejects with the given tRPC error code (and message). */
export async function rejectsWith(call: Promise<unknown>, code: TRPC_ERROR_CODE_KEY, message?: RegExp | string, label?: string): Promise<void> {
  await assert.rejects(call, (error: unknown) => {
    assert.ok(error instanceof TRPCError, `${label ?? ''} expected a TRPCError, got ${String(error)}`);
    assert.equal(error.code, code, label);
    if (message instanceof RegExp) assert.match(error.message, message, label);
    else if (message !== undefined) assert.equal(error.message, message, label);
    return true;
  });
}
