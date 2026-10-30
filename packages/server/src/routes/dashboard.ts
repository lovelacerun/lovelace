import { isLaunchInProgress, type Launch, type LaunchResponse, type NewSessionRequest, type QuickStartRequest } from '@lovelace/core';
import { z } from 'zod';
import { buildDashboard } from '../services/dashboard-service.js';
import { launchSessions, openSession, SessionRequestError } from '../services/session-service.js';
import { getWorkItemDetails, createActiveWorkItem } from '../repositories/work-item-repository.js';
import { getLaunchResponse, LaunchRequestError, retryLaunch, startLaunch } from '../services/launch-service.js';
import { refreshTools as discoverTools } from '../tools/tool-loader.js';
import { attachRepositoriesToExistingWorkItem } from '../services/work-start-service.js';
import { listPromptTemplates } from '../services/prompt-service.js';
import { notFound, procedure, requestError, router, type Context } from '../trpc.js';
import { newSessionInput, quickStartInput, uuid } from './schemas.js';

export const dashboardRouter = router({
  get: procedure.query(({ ctx: { database, codeHost, tracker, config } }) => buildDashboard({
    database, codeHost, tracker, settings: {
      defaultAgent: config.defaultAgent,
      repositoryTopics: config.github?.repositoryTopics ?? [],
    }, syncIntervalMs: config.syncIntervalMs,
  })),
});

/** Prepares the launch's repositories, then starts its agent in the work item's Herdr workspace. */
function launchRunner(ctx: Context) {
  const { database, config, tools, herdr, logger } = ctx;
  const refreshTools = ctx.refreshTools ?? discoverTools;

  function reviewSourceFor(workItemId: string, repoId: string) {
    const fullName = database.listRepos().find(repo => repo.id === repoId)?.fullName.toLowerCase();
    return database.listAttachmentsOfType('change-request', workItemId)
      .find(attachment => attachment.payload.repository.toLowerCase() === fullName);
  }

  return async (launch: Launch): Promise<void> => {
    if (launch.repoIds.length) {
      database.setLaunchState(launch.id, 'preparing');
      const details = await attachRepositoriesToExistingWorkItem(ctx, launch.workItemId,
        launch.repoIds.map((repoId, index) => {
          // A repository with an attached review request is checked out at its branch.
          const review = reviewSourceFor(launch.workItemId, repoId);
          return { repoId, role: index === 0 ? 'primary' : 'secondary', workspaceMode: review ? 'change-request' : 'fresh', sourceExternalId: review?.externalId ?? null };
        }));
      const failed = (details?.attachments ?? [])
        .filter(attachment => attachment.type === 'worktree' && launch.repoIds.includes(attachment.payload.repoId) && attachment.payload.status !== 'ready');
      if (failed.length) throw new Error('Repository preparation failed. Retry to prepare the selected repositories again.');
    }
    database.setLaunchState(launch.id, 'starting');
    refreshTools(tools);
    const sessions = await launchSessions({ database, herdr, tools, logger, config }, launch.workItemId, {
      toolIds: [launch.harness], toolOptions: launch.options, repoIds: launch.repoIds, promptId: launch.promptId, prompt: launch.prompt,
    });
    if (!sessions.length) throw new Error('launch produced no sessions');
  };
}

function launchFields(ctx: Context, intent: QuickStartRequest | NewSessionRequest) {
  return {
    harness: intent.agentId ?? ctx.config.defaultAgent, options: intent.options, repoIds: intent.repoIds ?? [],
    promptId: intent.promptId ?? null, prompt: intent.prompt,
  };
}

function validateSelection({ database, config }: Context, input: QuickStartRequest | NewSessionRequest): void {
  const repositoryIds = new Set(database.listRepos().map(repo => repo.id));
  for (const id of input.repoIds ?? []) {
    if (!repositoryIds.has(id)) throw new LaunchRequestError(400, `Unknown repository: ${id}`);
  }
  if (input.promptId && !listPromptTemplates(config.configDir).some(prompt => prompt.id === input.promptId)) {
    throw new LaunchRequestError(400, 'Unknown prompt template');
  }
}

/** Accepted launches answer once in progress when `wait: false`; their state tells callers to poll. */
async function sendLaunch(launch: () => Promise<LaunchResponse> | LaunchResponse): Promise<LaunchResponse> {
  try {
    return await launch();
  } catch (error) {
    if (error instanceof LaunchRequestError) throw requestError(error.status, error.message, error);
    throw error;
  }
}

const onError = (ctx: Context) => (error: unknown) => ctx.logger.error({ err: error }, 'Background launch failed');

export const launchesRouter = router({
  /** Creates a work item from the prompt (and optional tracker issue or review request) and launches an agent in it. */
  quickStart: procedure.input(quickStartInput).mutation(({ ctx, input }) => {
    const { requestId, wait, ...rest } = input;
    const intent: QuickStartRequest = { ...rest, trackerIssueId: rest.trackerIssueId ?? null, reviewRequestId: rest.reviewRequestId ?? null };
    const { database, codeHost, tracker } = ctx;
    return sendLaunch(() => startLaunch(database, {
      id: requestId, wait, kind: 'quick-start', request: intent, run: launchRunner(ctx), onError: onError(ctx),
      prepare() {
        const issue = intent.trackerIssueId ? tracker.peekAssignedIssues()?.value.find((entry) => entry.id === intent.trackerIssueId) : null;
        if (intent.trackerIssueId && !issue) throw new LaunchRequestError(400, `trackerIssueId not found in cached ${tracker.name} issues`);
        const review = intent.reviewRequestId ? codeHost.peekReviewRequests()?.value.find((entry) => entry.id === intent.reviewRequestId) : null;
        if (intent.reviewRequestId && !review) throw new LaunchRequestError(400, 'reviewRequestId not found in cached review requests');
        validateSelection(ctx, intent);
        if (review && !database.listRepos().some(repo => intent.repoIds?.includes(repo.id) && repo.fullName.toLowerCase() === review.repository.toLowerCase())) {
          throw new LaunchRequestError(400, `Select ${review.repository} to review its change request`);
        }
        const work = createActiveWorkItem(database, {
          title: issue ? `${issue.key}: ${issue.title}` : review ? `${review.repository}#${review.number}: ${review.title}` : deriveTitleFromPrompt(intent.prompt),
          attachments: [
            ...issue ? [{ type: 'tracker-item' as const, provider: tracker.provider, externalId: issue.id, payload: issue }] : [],
            ...review ? [{ type: 'change-request' as const, provider: codeHost.provider, externalId: review.id, payload: review }] : [],
          ],
        });
        return { workItemId: work.id, ...launchFields(ctx, intent) };
      },
    }));
  }),

  /** Launches another agent in an active work item. */
  newSession: procedure.input(newSessionInput).mutation(({ ctx, input }) => {
    const { requestId, wait, workItemId, ...intent } = input;
    const { database } = ctx;
    return sendLaunch(() => startLaunch(database, {
      id: requestId, wait, kind: 'new-session', request: { workItemId, ...intent }, run: launchRunner(ctx), onError: onError(ctx),
      prepare() {
        const details = getWorkItemDetails(database, workItemId);
        if (!details) throw new LaunchRequestError(404, 'work item not found');
        if (details.workItem.state !== 'active') throw new LaunchRequestError(409, 'work item not active');
        validateSelection(ctx, intent);
        database.touchWorkItem(workItemId);
        return { workItemId, ...launchFields(ctx, intent) };
      },
    }));
  }),

  /** Reads a launch by its request ID without launching, including after a lost acceptance reply. */
  get: procedure
    .input(z.object({ id: uuid }))
    .query(({ ctx, input }) => getLaunchResponse(ctx.database, input.id) ?? notFound('launch not found')),

  /** Runs a failed launch again with its saved prompt and selections. */
  retry: procedure
    .input(z.object({ id: uuid }))
    .mutation(({ ctx, input }) => sendLaunch(() => retryLaunch(ctx.database, input.id, { run: launchRunner(ctx), onError: onError(ctx) }))),
});

export const sessionsRouter = router({
  /** Focuses the session's Herdr pane, or continues its exact conversation when the agent ended. */
  open: procedure
    .input(z.object({ workItemId: z.string(), sessionId: z.string() }))
    .mutation(async ({ ctx, input: { workItemId, sessionId } }) => {
      const { database, herdr, tools, logger, config } = ctx;
      try {
        (ctx.refreshTools ?? discoverTools)(tools);
        const action = await openSession({ database, herdr, tools, logger, config }, workItemId, sessionId);
        return { action, details: getWorkItemDetails(database, workItemId)! };
      } catch (error) {
        if (error instanceof SessionRequestError) throw requestError(error.status, error.message, error);
        logger.error({ err: error, workItemId, sessionId }, 'Failed to open session');
        throw requestError(502, error instanceof Error ? error.message : 'failed to open session', error);
      }
    }),
});

function deriveTitleFromPrompt(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? 'Quick start';
  return firstLine.length > 120 ? `${firstLine.slice(0, 119)}…` : firstLine;
}
