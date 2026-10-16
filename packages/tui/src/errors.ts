import { ApiError } from '@lovelace/client';

/** The server was unreachable or did not answer in time. */
export function isOffline(error: unknown): boolean {
  return (error instanceof ApiError && error.status === 0) || (error instanceof Error && error.name === 'TimeoutError');
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
