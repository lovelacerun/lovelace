import type { DatabaseState } from '../database.js';
import type { HerdrClient } from '../herdr/herdr-client.js';
import type { HerdrEventOptions, HerdrEventWatcher } from '../herdr/herdr-events.js';
import { runningSessionPanes, syncSessions } from './session-service.js';

interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

/** Without a live subscription, poll as often as before events existed. */
export const DISCONNECTED_POLL_MS = 3_000;
/** Herdr emits no event for a reported conversation identity; this bounds how late it is recorded. */
export const CONNECTED_POLL_MS = 15_000;

/**
 * Mirrors Herdr's panes into session records whenever Herdr reports a change,
 * coalescing bursts into one sync at a time, and keeps the event subscription
 * on the panes of running sessions.
 */
export function startSessionSync(deps: {
  database: DatabaseState;
  herdr: HerdrClient;
  logger: Logger;
  watch: (options: Pick<HerdrEventOptions, 'onChange'>) => HerdrEventWatcher;
  now?: () => number;
}): { sync: () => Promise<void>; tick: () => void; stop: () => void } {
  const now = deps.now ?? Date.now;
  let running: Promise<void> | null = null;
  let again = false;
  let lastSyncAt = 0;

  const sync = (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    lastSyncAt = now();
    running = syncSessions(deps.database, deps.herdr)
      .catch(error => deps.logger.warn({ err: error }, 'Herdr session sync failed'))
      .finally(() => {
        running = null;
        watcher.watchPanes(runningSessionPanes(deps.database));
        if (again) {
          again = false;
          void sync();
        }
      });
    return running;
  };
  const watcher = deps.watch({ onChange: () => void sync() });
  const tick = () => {
    if (now() - lastSyncAt >= (watcher.connected ? CONNECTED_POLL_MS : DISCONNECTED_POLL_MS)) void sync();
  };
  const timer = setInterval(tick, 1_000);
  timer.unref();
  return { sync, tick, stop: () => { clearInterval(timer); watcher.close(); } };
}
