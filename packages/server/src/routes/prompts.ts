import { z } from 'zod';
import { listPromptTemplates, renderPrompt } from '../services/prompt-service.js';
import { notFound, procedure, router } from '../trpc.js';
import { nonEmpty, startWorkSource } from './schemas.js';

export const promptsRouter = router({
  list: procedure.query(({ ctx }) => listPromptTemplates(ctx.config.lovelaceDir)),

  /** Renders a template before user editing; a mutation only so provider text travels in the body, not the URL. */
  render: procedure
    .input(z.object({
      promptId: nonEmpty, title: nonEmpty,
      sources: z.array(startWorkSource).optional(), workspacePaths: z.array(nonEmpty).optional(),
    }))
    .mutation(({ ctx, input }) => renderPrompt(ctx.config, input, ctx.logger) ?? notFound('prompt not found')),
});
