import type { WorkItemDetails } from '@lovelace/core';
import type { AppState } from './state.js';

/** The open work item, for assertions; empty on any other route. */
export function openWork(state: AppState): { id?: string; details?: WorkItemDetails | null } {
  return state.route.kind === 'work' ? state.route : {};
}
