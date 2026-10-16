import type { FastifyInstance } from 'fastify';
import { activityBus, type ActivityEvent } from '../services/activity-bus.js';
import type { RouteDeps } from './deps.js';

const HEARTBEAT_INTERVAL_MS = 15_000;

export function registerEventRoutes(app: FastifyInstance, _deps: RouteDeps) {
  app.get('/activity', async (request) => {
    const sinceId = Number.parseInt((request.query as { since?: string }).since ?? '', 10);
    return activityBus.recent(Number.isFinite(sinceId) ? sinceId : undefined);
  });

  app.get('/events', (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(':connected\n\n');

    const sinceId = Number.parseInt((request.query as { since?: string }).since ?? '', 10);
    const send = (event: ActivityEvent) => {
      reply.raw.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    for (const event of activityBus.recent(Number.isFinite(sinceId) ? sinceId : undefined)) send(event);
    activityBus.on('event', send);

    const heartbeat = setInterval(() => reply.raw.write(':heartbeat\n\n'), HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      activityBus.off('event', send);
    });
  });
}
