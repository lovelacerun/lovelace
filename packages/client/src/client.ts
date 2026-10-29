import type { AppRouter } from '@lovelace/server';
import { createTRPCClient, httpLink, isTRPCClientError, TRPCClientError, type Operation, type TRPCClient, type TRPCLink } from '@trpc/client';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import { observable } from '@trpc/server/observable';

export type { AppRouter };
/** Typed access to every server procedure, e.g. `client.workItems.get.query({ id })`. */
export type LovelaceClient = TRPCClient<AppRouter>;
export type RouterInputs = inferRouterInputs<AppRouter>;
export type RouterOutputs = inferRouterOutputs<AppRouter>;

/** Per-call options, passed as `{ context }` next to `{ signal }`. */
export interface RequestContext extends Record<string, unknown> {
  /** Includes response-body consumption. Default: 15 seconds, 60 for launches and repository syncs. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
/** Herdr agent startup may take up to 30 seconds before a launch reply. */
const SLOW_TIMEOUT_MS = 60_000;
const SLOW_PROCEDURES = new Set(['launches.quickStart', 'launches.newSession', 'sessions.open', 'repositories.sync']);
const UNREACHABLE = 'Cannot reach Lovelace server or read its response. Check the server URL and retry.';

/**
 * Thin server-only HTTP transport. Never retries mutations automatically and
 * never batches, so each call is one request with its own deadline.
 */
export function createLovelaceClient(serverUrl: string, fetchFn: typeof fetch = globalThis.fetch.bind(globalThis)): LovelaceClient {
  const url = new URL(serverUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Lovelace client requires an HTTP loopback server URL without credentials, query or path.');
  }
  return createTRPCClient<AppRouter>({
    links: [
      deadlineLink(),
      httpLink({ url: `${serverUrl.replace(/\/$/, '')}/trpc`, fetch: fetchFn }),
    ],
  });
}

/** HTTP status of a server rejection; 0 when the server could not be reached or its reply read. */
export function errorStatus(error: unknown): number {
  return isTRPCClientError<AppRouter>(error) ? error.data?.httpStatus ?? 0 : 0;
}

/** The server could not be reached or its reply read in time; caller cancellation is not. */
export function isUnreachable(error: unknown): boolean {
  return isTRPCClientError(error) && !error.data && !isAborted(error);
}

/** The caller's signal stopped the request. */
export function isAborted(error: unknown): boolean {
  const cause = isTRPCClientError(error) ? error.cause : error;
  return cause instanceof Error && cause.name === 'AbortError';
}

/** Caller cancellation and expired deadlines keep their reason as the error's cause. */
export function isTimeout(error: unknown): boolean {
  const cause = isTRPCClientError(error) ? error.cause : error;
  return cause instanceof Error && cause.name === 'TimeoutError';
}

function timeoutFor(op: Operation): number {
  const timeoutMs = (op.context as RequestContext).timeoutMs;
  if (timeoutMs !== undefined) return timeoutMs;
  // wait:false asks only for acceptance, which the ordinary deadline covers.
  const wait = (op.input as { wait?: unknown } | undefined)?.wait;
  return SLOW_PROCEDURES.has(op.path) && wait !== false ? SLOW_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

/**
 * Bounds each call, response body included, even when an injected fetch
 * ignores abort. Injected fetch implementations must still honor the signal
 * to release their own sockets.
 */
function deadlineLink(): TRPCLink<AppRouter> {
  return () => ({ op, next }) => observable(observer => {
    const timeoutMs = timeoutFor(op);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      observer.error(TRPCClientError.from(new RangeError('timeoutMs must be positive')));
      return;
    }
    const controller = new AbortController();
    const abort = () => controller.abort(op.signal?.reason);
    const timer = setTimeout(() => controller.abort(new DOMException('Server request timed out', 'TimeoutError')), timeoutMs);
    const stop = () => {
      const reason: unknown = controller.signal.reason;
      observer.error(new TRPCClientError(reason instanceof Error ? reason.message : 'Request aborted', { cause: reason instanceof Error ? reason : undefined }));
    };
    controller.signal.addEventListener('abort', stop, { once: true });
    op.signal?.addEventListener('abort', abort, { once: true });
    if (op.signal?.aborted) abort();
    const subscription = controller.signal.aborted ? null : next({ ...op, signal: controller.signal }).subscribe({
      next: value => observer.next(value),
      // Do not leak URLs, request payloads or transport details in errors.
      error: error => observer.error(error.data ? error : new TRPCClientError(UNREACHABLE, { cause: error })),
      complete: () => observer.complete(),
    });
    return () => {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', stop);
      op.signal?.removeEventListener('abort', abort);
      subscription?.unsubscribe();
    };
  });
}
