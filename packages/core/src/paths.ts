import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function defaultDomainRoot(): string {
  return process.env.LOVELACE_ROOT
    ? resolve(process.env.LOVELACE_ROOT)
    : join(homedir(), 'projects');
}

export function lovelaceDir(root = defaultDomainRoot()): string {
  return join(root, '.lovelace');
}

/**
 * The operator's config file lives at a fixed location, independent of the
 * state root it may choose: `$LOVELACE_CONFIG`, else
 * `$XDG_CONFIG_HOME/lovelace/config.jsonc`, else `~/.config/lovelace/config.jsonc`.
 */
export function configPath(): string {
  if (process.env.LOVELACE_CONFIG) return resolve(process.env.LOVELACE_CONFIG);
  const base = process.env.XDG_CONFIG_HOME ? resolve(process.env.XDG_CONFIG_HOME) : join(homedir(), '.config');
  return join(base, 'lovelace', 'config.jsonc');
}
