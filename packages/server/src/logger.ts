import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pino } from 'pino';
import type { LovelaceConfig } from '@lovelace/core';

export function createLogger(config: LovelaceConfig) {
  const logDir = join(config.lovelaceDir, 'logs');
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
