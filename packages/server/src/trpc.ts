import { initTRPC, TRPCError, type TRPC_ERROR_CODE_KEY } from '@trpc/server';
import type { FastifyBaseLogger } from 'fastify';
import { prettifyError, ZodError } from 'zod';
import type { RouteDeps } from './routes/deps.js';

export interface Context extends RouteDeps {
  logger: FastifyBaseLogger;
}

const t = initTRPC.context<Context>().create({
  // Responses never carry server stack traces.
  isDev: false,
  // Invalid input reads as a sentence for CLI users instead of a JSON issue list.
  errorFormatter: ({ shape, error }) => error.cause instanceof ZodError ? { ...shape, message: prettifyError(error.cause) } : shape,
});

export const router = t.router;
export const procedure = t.procedure;
export const createCallerFactory = t.createCallerFactory;

const CODES: Record<number, TRPC_ERROR_CODE_KEY> = { 400: 'BAD_REQUEST', 404: 'NOT_FOUND', 409: 'CONFLICT', 502: 'BAD_GATEWAY' };

/** Rejects with the tRPC code for an HTTP status that services report. */
export function requestError(status: number, message: string, cause?: unknown): TRPCError {
  return new TRPCError({ code: CODES[status] ?? 'INTERNAL_SERVER_ERROR', message, cause });
}

export function notFound(message: string): never {
  throw new TRPCError({ code: 'NOT_FOUND', message });
}

/** Provider and preparation failures are reported as rejected requests with their message. */
export function rejected(error: unknown, fallback: string): TRPCError {
  if (error instanceof TRPCError) return error;
  return new TRPCError({ code: 'BAD_REQUEST', message: error instanceof Error ? error.message : fallback, cause: error });
}
