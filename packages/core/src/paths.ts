import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * The operator's config file: `$LOVELACE_CONFIG`, else
 * `$XDG_CONFIG_HOME/lovelace/config.jsonc`, else `~/.config/lovelace/config.jsonc`.
 */
export function configPath(): string {
  if (process.env.LOVELACE_CONFIG) return resolve(process.env.LOVELACE_CONFIG);
  return join(xdgHome('XDG_CONFIG_HOME', '.config'), 'lovelace', 'config.jsonc');
}

/** Where Lovelace keeps its files, following the XDG base directories on macOS and Linux alike. */
export interface LovelaceDirs {
  /** Next to the config file: prompt templates and plugins the operator edits. */
  configDir: string;
  /** `$XDG_DATA_HOME/lovelace`: the database, its backups, clones and worktrees. */
  dataDir: string;
  /** `$XDG_STATE_HOME/lovelace`: logs and the supervisor's pid file. */
  stateDir: string;
  /** `$XDG_CACHE_HOME/lovelace`: anything Lovelace can rebuild. */
  cacheDir: string;
}

export function lovelaceDirs(): LovelaceDirs {
  return {
    configDir: dirname(configPath()),
    dataDir: join(xdgHome('XDG_DATA_HOME', '.local/share'), 'lovelace'),
    stateDir: join(xdgHome('XDG_STATE_HOME', '.local/state'), 'lovelace'),
    cacheDir: join(xdgHome('XDG_CACHE_HOME', '.cache'), 'lovelace'),
  };
}

function xdgHome(variable: string, fallback: string): string {
  const value = process.env[variable];
  // The spec ignores relative values.
  return value?.startsWith('/') ? resolve(value) : join(homedir(), fallback);
}
