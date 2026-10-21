import { createConnection, type Socket } from 'node:net';
import safeParse from '@nkzw/core/safeParse.js';
import { asRecord } from '../helpers.js';

interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

export interface HerdrEventWatcher {
  /** Whether a subscription is live; callers poll more often while it is not. */
  readonly connected: boolean;
  /** Subscribes to status changes of exactly these panes, which must exist in Herdr. */
  watchPanes(paneIds: string[]): void;
  close(): void;
}

export interface HerdrEventOptions {
  socketPath: () => Promise<string>;
  /** Called for every relevant event and after each (re)subscription, so missed changes are synced. */
  onChange: () => void;
  logger: Logger;
}

const MAX_BACKOFF_MS = 30_000;

/**
 * Keeps one `events.subscribe` connection to Herdr's socket API. Herdr emits
 * no event when an agent reports its conversation identity, so callers resync
 * on agent detection, status changes and pane exits, and keep a slow poll.
 * Status changes need one subscription per pane, and Herdr rejects the whole
 * request when one of them is gone; the watcher then asks for a resync.
 */
export function watchHerdrEvents({ socketPath, onChange, logger }: HerdrEventOptions): HerdrEventWatcher {
  let panes: string[] = [];
  let socket: Socket | null = null;
  let connected = false;
  let closed = false;
  let backoffMs = 1_000;
  let timer: NodeJS.Timeout | null = null;

  const schedule = (delayMs: number) => {
    if (closed || timer) return;
    timer = setTimeout(() => { timer = null; void connect(); }, delayMs);
    timer.unref();
  };

  const reconnectLater = () => {
    connected = false;
    socket = null;
    schedule(backoffMs);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  };

  async function connect() {
    let path: string;
    try {
      path = await socketPath();
    } catch (error) {
      logger.warn({ err: { message: (error as Error).message } }, 'Herdr socket unavailable; retrying');
      return reconnectLater();
    }
    if (closed) return;
    const subscriptions = [
      { type: 'pane.agent_detected' }, { type: 'pane.exited' }, { type: 'pane.closed' },
      ...panes.map(pane_id => ({ type: 'pane.agent_status_changed', pane_id })),
    ];
    const current = createConnection(path);
    socket = current;
    let buffer = '';
    current.setEncoding('utf8');
    current.on('connect', () => {
      current.write(`${JSON.stringify({ id: 'lovelace:events', method: 'events.subscribe', params: { subscriptions } })}\n`);
    });
    current.on('data', (chunk: string) => {
      buffer += chunk;
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const message = asRecord(safeParse(buffer.slice(0, index)));
        buffer = buffer.slice(index + 1);
        if (message.id === 'lovelace:events') {
          const error = asRecord(message.error);
          if (error.code) {
            logger.warn({ code: error.code, message: error.message }, 'Herdr rejected the event subscription');
            current.destroy();
            onChange();
            return;
          }
          connected = true;
          backoffMs = 1_000;
          onChange();
        } else if (typeof message.event === 'string') {
          onChange();
        }
      }
    });
    current.on('error', () => undefined);
    current.on('close', () => {
      if (socket !== current) return;
      reconnectLater();
    });
  }

  void connect();

  return {
    get connected() { return connected; },
    watchPanes(next) {
      const sorted = [...new Set(next)].sort();
      if (sorted.join('\n') === panes.join('\n')) return;
      panes = sorted;
      // Herdr fixes subscriptions per connection: replace it right away.
      const previous = socket;
      socket = null;
      connected = false;
      previous?.destroy();
      if (timer) { clearTimeout(timer); timer = null; }
      backoffMs = 1_000;
      void connect();
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      socket?.destroy();
    },
  };
}
