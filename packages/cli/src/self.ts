import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The argv that runs this same CLI again. Homebrew's wrapper exports its
 * stable `opt` path as LOVELACE_EXECUTABLE, so LaunchAgents and agent prompts
 * survive upgrades; a checkout reruns the current Node with its loader flags.
 */
export function selfInvocation(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.LOVELACE_EXECUTABLE) return [env.LOVELACE_EXECUTABLE];
  return [process.execPath, ...process.execArgv, process.argv[1]!];
}

export const skillPath = fileURLToPath(new URL('../SKILL.md', import.meta.url));

export const version: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
