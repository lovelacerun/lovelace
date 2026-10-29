import { z } from 'zod';
import { activityBus } from '../services/activity-bus.js';
import { procedure, router } from '../trpc.js';

export const activityRouter = router({
  /** Buffered server activity since the last restart, optionally only events after `sinceId`. */
  list: procedure
    .input(z.object({ sinceId: z.number().int().optional() }).optional())
    .query(({ input }) => activityBus.recent(input?.sinceId)),
});
