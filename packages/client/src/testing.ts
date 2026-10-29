import { createTRPCClient, TRPCClientError, type TRPCLink } from '@trpc/client';
import { TRPCError, type AnyProcedure, type AnyRouter, type inferProcedureInput, type inferProcedureOutput } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { observable } from '@trpc/server/observable';
import { TRPC_ERROR_CODES_BY_KEY } from '@trpc/server/rpc';
import type { AppRouter, LovelaceClient } from './client.js';

type Handler<P extends AnyProcedure> = (input: inferProcedureInput<P>, signal?: AbortSignal) => inferProcedureOutput<P> | Promise<inferProcedureOutput<P>>;
type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void ? I : never;
type HandlersOf<Record, Prefix extends string> = UnionToIntersection<{
  [Key in keyof Record & string]: Record[Key] extends AnyProcedure
    ? { [Path in `${Prefix}${Key}`]?: Handler<Record[Key]> }
    : HandlersOf<Record[Key], `${Prefix}${Key}.`>;
}[keyof Record & string]>;

/** Fake server procedures keyed by path, e.g. `'workItems.get'`; inputs and outputs are typed from the router. */
export type FakeHandlers<Router extends AnyRouter = AppRouter> = HandlersOf<Router['_def']['record'], ''>;

/**
 * A client whose calls run the given handlers instead of HTTP requests.
 * Throw `serverError(status, message)` for a server rejection; any other
 * error behaves like an unreachable server (status 0). Handlers are looked up
 * on every call, so a test may replace an entry of the passed object later.
 */
export function fakeClient(handlers: FakeHandlers): LovelaceClient {
  const table = handlers as Record<string, ((input: unknown, signal?: AbortSignal) => unknown) | undefined>;
  const link: TRPCLink<AppRouter> = () => ({ op }) => observable(observer => {
    void (async () => {
      const handler = table[op.path];
      if (!handler) throw new Error(`No fake for ${op.path}`);
      return handler(op.input, op.signal ?? undefined);
    })().then(
      data => { observer.next({ result: { type: 'data', data } }); observer.complete(); },
      (error: unknown) => observer.error(toClientError(error, op.path)),
    );
  });
  return createTRPCClient<AppRouter>({ links: [link] });
}

/** A rejection as the server sends it: `errorStatus()` reports `status`. */
export function serverError(status: 400 | 404 | 409 | 500 | 502 | 503, message: string): TRPCError {
  const code = ({ 400: 'BAD_REQUEST', 404: 'NOT_FOUND', 409: 'CONFLICT', 500: 'INTERNAL_SERVER_ERROR', 502: 'BAD_GATEWAY', 503: 'SERVICE_UNAVAILABLE' } as const)[status];
  return new TRPCError({ code, message });
}

function toClientError(error: unknown, path: string): TRPCClientError<AppRouter> {
  if (error instanceof TRPCError) {
    return TRPCClientError.from({
      error: {
        message: error.message, code: TRPC_ERROR_CODES_BY_KEY[error.code],
        data: { code: error.code, httpStatus: getHTTPStatusCodeFromError(error), path },
      },
    });
  }
  return TRPCClientError.from(error instanceof Error ? error : new Error(String(error)));
}
