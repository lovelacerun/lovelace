import { activityRouter } from './routes/activity.js';
import { dashboardRouter, launchesRouter, sessionsRouter } from './routes/dashboard.js';
import { inboxRouter } from './routes/inbox.js';
import { promptsRouter } from './routes/prompts.js';
import { githubRouter, jiraRouter } from './routes/providers.js';
import { repositoriesRouter } from './routes/repos.js';
import { systemRouter } from './routes/system.js';
import { toolsRouter } from './routes/tools.js';
import { workItemsRouter } from './routes/work-items.js';
import { workspacesRouter } from './routes/workspaces.js';
import { createCallerFactory, router } from './trpc.js';

export const appRouter = router({
  system: systemRouter,
  activity: activityRouter,
  repositories: repositoriesRouter,
  dashboard: dashboardRouter,
  inbox: inboxRouter,
  prompts: promptsRouter,
  tools: toolsRouter,
  workItems: workItemsRouter,
  launches: launchesRouter,
  sessions: sessionsRouter,
  workspaces: workspacesRouter,
  github: githubRouter,
  jira: jiraRouter,
});

/** The server API; clients infer every route's input and output from it. */
export type AppRouter = typeof appRouter;

export const createCaller = createCallerFactory(appRouter);
