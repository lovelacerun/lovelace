import { isUnreachable } from '@lovelace/client';

export { errorStatus, isAborted } from '@lovelace/client';

/** The server was unreachable or did not answer in time. */
export function isOffline(error: unknown): boolean {
  return isUnreachable(error);
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
