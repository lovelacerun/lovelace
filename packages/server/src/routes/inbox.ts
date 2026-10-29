import { z } from 'zod';
import { activateInboxItem, dismissInboxItem } from '../services/inbox-command-service.js';
import { buildInbox } from '../services/inbox-query-service.js';
import { notFound, procedure, router } from '../trpc.js';
import { nonEmpty, sourceType, startWorkSource } from './schemas.js';

const workItemSource = z.object({ sourceType: z.literal('work-item'), id: nonEmpty });

export const inboxRouter = router({
  get: procedure.query(({ ctx: { database, github, jira } }) => buildInbox(database, { github, jira })),

  /** Marks an inbox item active locally; external sources become a new work item. */
  activate: procedure
    .input(z.union([workItemSource, z.object({ title: nonEmpty, sources: z.array(startWorkSource).min(1) })]))
    .mutation(({ ctx, input }) => activateInboxItem(ctx.database, input) ?? notFound('inbox item not found')),

  /** Dismisses an inbox item locally; never changes the upstream issue or pull request. */
  dismiss: procedure
    .input(z.union([workItemSource, z.object({ sources: z.array(z.strictObject({ sourceType, provider: nonEmpty, externalId: nonEmpty })).min(1) })]))
    .mutation(({ ctx, input }) => dismissInboxItem(ctx.database, input) ?? notFound('inbox item not found')),
});
