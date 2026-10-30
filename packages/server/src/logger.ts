import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pino } from 'pino';
import type { ServerConfig } from '@lovelace/core';

export function createLogger(config: ServerConfig) {
  const logDir = join(config.stateDir, 'logs');
  mkdirSync(logDir, { recursive: true });

  return pino(
    {
      level: config.logLevel,
      timestamp: pino.stdTimeFunctions.isoTime,
      base: { service: 'lovelace-server' },
    },
    pino.destination({ dest: join(logDir, 'server.log'), sync: false }),
  );
}
