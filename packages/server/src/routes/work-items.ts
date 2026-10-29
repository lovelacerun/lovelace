import { WORK_ITEM_STATES } from '@lovelace/core';
import { z } from 'zod';
import { createManualWorkItem, getWorkItemDetails, updateWorkItem } from '../repositories/work-item-repository.js';
import {
  attachPullRequestToWorkItem,
  detachPullRequestFromWorkItem,
  parsePullRequestRef,
  refreshPullRequestsForWorkItem,
} from '../services/pull-request-service.js';
import { attachJiraIssueToWorkItem, detachJiraIssueFromWorkItem, parseJiraIssueRef } from '../services/tracker-item-service.js';
import { workItemIdForPath } from '../services/task-workspace-service.js';
import { beginRepositoryPreparation } from '../services/work-start-service.js';
import { renameWorkItemWorkspace } from '../herdr/work-item-workspace.js';
import { notFound, procedure, rejected, router, type Context } from '../trpc.js';
import { nonEmpty, startWorkRepository } from './schemas.js';

const workItemId = z.object({ id: z.string() });

/** Runs a work-item change and relabels its Herdr workspace in the background when the title changed. */
async function retitling<T>({ database, herdr, logger }: Context, workItemId: string, change: () => T | Promise<T>): Promise<T> {
  const before = database.getWorkItem(workItemId)?.title;
  const result = await change();
  const after = database.getWorkItem(workItemId)?.title;
  if (before !== undefined && after !== undefined && before !== after) {
    renameWorkItemWorkspace(database, herdr, workItemId)
      .catch((error: unknown) => logger.warn({ err: error, workItemId }, 'Failed to rename Herdr workspace'));
  }
  return result;
}

export const workItemsRouter = router({
  list: procedure
    .input(z.object({ state: z.enum(WORK_ITEM_STATES).optional() }).optional())
    .query(({ ctx, input }) => ctx.database.listWorkItems(input?.state)),

  /** The work item whose task directory contains `path`. */
  current: procedure
    .input(z.object({ path: nonEmpty }))
    .query(({ ctx: { database, workspaceManager }, input: { path } }) => {
      const id = workItemIdForPath(workspaceManager.workspacesDirectory, path, database.listWorkItems().map(workItem => workItem.id));
      return (id ? getWorkItemDetails(database, id) : null) ?? notFound(`${path} is not inside a Lovelace work item workspace`);
    }),

  get: procedure
    .input(workItemId)
    .query(({ ctx, input }) => getWorkItemDetails(ctx.database, input.id) ?? notFound('work item not found')),

  create: procedure
    .input(z.object({ title: nonEmpty, notes: z.string().optional() }))
    .mutation(({ ctx, input }) => createManualWorkItem(ctx.database, input)),

  /** Omitted fields keep their current value; `notes: null` clears notes. Never changes upstream issues. */
  update: procedure
    .input(z.object({ id: z.string(), title: nonEmpty.optional(), notes: z.string().nullable().optional() }))
    .mutation(async ({ ctx, input: { id, ...patch } }) =>
      await retitling(ctx, id, () => updateWorkItem(ctx.database, id, patch)) ?? notFound('work item not found')),

  setState: procedure
    .input(z.object({ id: z.string(), state: z.enum(WORK_ITEM_STATES) }))
    .mutation(({ ctx, input }) => ctx.database.updateWorkItemState(input.id, input.state) ?? notFound('work item not found')),

  /** Submits a repository selection once; `wait: false` returns before preparation finishes. */
  addRepositories: procedure
    .input(z.object({ id: z.string(), repositories: z.array(startWorkRepository), wait: z.boolean().optional() }))
    .mutation(async ({ ctx, input: { id, repositories, wait } }) => {
      const { database, github, logger, workspaceManager } = ctx;
      try {
        const operation = beginRepositoryPreparation({ database, github, logger, workspaceManager }, id, repositories);
        if (!operation) notFound('work item not found');
        if (wait === false) {
          // Disconnecting the caller never cancels server-owned preparation.
          void operation.completion.catch(error => logger.error({ err: error, workItemId: id }, 'Repository preparation operation failed'));
          return operation.details;
        }
        await operation.completion;
        return getWorkItemDetails(database, id)!;
      } catch (error) {
        logger.error({ err: error, workItemId: id, repositories }, 'Failed to attach repositories to work item');
        throw rejected(error, 'failed to attach repositories');
      }
    }),

  attachPullRequest: procedure
    .input(z.object({ id: z.string(), url: z.string().optional(), repoFullName: z.string().optional(), number: z.number().optional() }))
    .mutation(async ({ ctx, input: { id, ...body } }) => {
      const ref = parsePullRequestRef(body) ?? rejectInput('body must include a GitHub pull request url or repoFullName and number');
      try {
        return await attachPullRequestToWorkItem(ctx.database, ctx.github, id, ref) ?? notFound('work item not found');
      } catch (error) {
        ctx.logger.error({ err: error, workItemId: id, ref }, 'Failed to attach pull request to work item');
        throw rejected(error, 'failed to attach pull request');
      }
    }),

  detachPullRequest: procedure
    .input(z.object({ id: z.string(), externalId: z.string() }))
    .mutation(({ ctx, input }) => {
      if (!detachPullRequestFromWorkItem(ctx.database, input.id, input.externalId)) notFound('work item not found');
      return { ok: true as const };
    }),

  /** Re-reads every attached pull request from GitHub. */
  refreshPullRequests: procedure
    .input(workItemId)
    .mutation(async ({ ctx, input: { id } }) => {
      try {
        return await refreshPullRequestsForWorkItem(ctx.database, ctx.github, id) ?? notFound('work item not found');
      } catch (error) {
        ctx.logger.error({ err: error, workItemId: id }, 'Failed to refresh pull requests for work item');
        throw rejected(error, 'failed to refresh pull requests');
      }
    }),

  attachTrackerItem: procedure
    .input(z.object({ id: z.string(), provider: z.literal('jira').optional(), key: z.string().optional(), url: z.string().optional() }))
    .mutation(async ({ ctx, input: { id, ...body } }) => {
      const ref = parseJiraIssueRef(body) ?? rejectInput('body must include a Jira issue key or browse url');
      try {
        return await retitling(ctx, id, () => attachJiraIssueToWorkItem(ctx.database, ctx.jira, id, ref)) ?? notFound('work item not found');
      } catch (error) {
        ctx.logger.error({ err: error, workItemId: id, ref }, 'Failed to attach Jira issue to work item');
        throw rejected(error, 'failed to attach Jira issue');
      }
    }),

  /** Detaches by the tracker's issue ID or key. */
  detachTrackerItem: procedure
    .input(z.object({ id: z.string(), idOrKey: z.string() }))
    .mutation(async ({ ctx, input: { id, idOrKey } }) => {
      if (!await retitling(ctx, id, () => detachJiraIssueFromWorkItem(ctx.database, id, idOrKey))) notFound('work item not found');
      return { ok: true as const };
    }),
});

function rejectInput(message: string): never {
  throw rejected(new Error(message), message);
}
