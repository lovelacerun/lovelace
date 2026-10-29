import { refreshTools as discoverTools } from '../tools/tool-loader.js';
import { procedure, router } from '../trpc.js';

export const toolsRouter = router({
  /** Coding harnesses detected on the server, re-detected on every call. */
  list: procedure.query(({ ctx }) => {
    (ctx.refreshTools ?? discoverTools)(ctx.tools);
    // A harness whose catalog cannot be listed still launches; its model is then typed.
    return Promise.all(ctx.tools.map(async tool => ({ ...tool, models: await ctx.listModels(tool).catch(() => []) })));
  }),
});
