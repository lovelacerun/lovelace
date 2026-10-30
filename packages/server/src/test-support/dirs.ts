import type { LovelaceDirs } from '@lovelace/core';

/** Every Lovelace directory in one temporary place. */
export const testDirs = (dir: string): LovelaceDirs => ({ configDir: dir, dataDir: dir, stateDir: dir, cacheDir: dir });
