import { EventEmitter } from 'node:events';

export interface ActivityEvent {
  id: number;
  time: string;
  type: string;
  message: string;
  workItemId?: string | null;
  repoName?: string | null;
  data?: Record<string, unknown>;
}

type ActivityEventInput = Omit<ActivityEvent, 'id' | 'time'>;

const MAX_BUFFERED_EVENTS = 300;

class ActivityBus extends EventEmitter {
  private buffer: ActivityEvent[] = [];
  private nextId = 1;

  publish(input: ActivityEventInput): ActivityEvent {
    const event: ActivityEvent = {
      ...input,
      id: this.nextId++,
      time: new Date().toISOString(),
    };
    this.buffer.push(event);
    if (this.buffer.length > MAX_BUFFERED_EVENTS) {
      this.buffer.splice(0, this.buffer.length - MAX_BUFFERED_EVENTS);
    }
    this.emit('event', event);
    return event;
  }

  recent(sinceId?: number): ActivityEvent[] {
    if (!sinceId) return [...this.buffer];
    return this.buffer.filter((event) => event.id > sinceId);
  }
}

export const activityBus = new ActivityBus();
// Every SSE client adds a listener; don't warn at the default threshold of 10.
activityBus.setMaxListeners(100);

export function emitActivity(input: ActivityEventInput): void {
  activityBus.publish(input);
}

export function describeActivityError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lines = message.split('\n')
    .map((line) => line.replace(/^\s*-\s*/, '').trim())
    .filter(Boolean);
  const unique = [...new Set(lines)];
  const summary = unique.slice(0, 3).join('; ');
  return summary.length > 500 ? `${summary.slice(0, 497)}…` : summary;
}
