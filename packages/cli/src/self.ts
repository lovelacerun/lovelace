import { readFileSync, realpathSync } from 'node:fs';

/**
 * The argv that runs this same CLI again. Homebrew's wrapper exports its
 * stable `opt` path as LOVELACE_EXECUTABLE, so the background server and agent prompts
 * survive upgrades; a checkout reruns the current Node with its loader flags.
 */
export function selfInvocation(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.LOVELACE_EXECUTABLE) return [env.LOVELACE_EXECUTABLE];
  return [process.execPath, ...process.execArgv, process.argv[1]!];
}

/**
 * How launched agents call this server back: plain `lovelace` when that is
 * this executable on PATH, and the port only when an override chose it.
 */
export function agentCommand(port: number, onPath: string | null, env: NodeJS.ProcessEnv = process.env): string {
  const argv = selfInvocation(env);
  const executable = argv.length === 1 && onPath && sameFile(onPath, argv[0]!) ? 'lovelace' : argv.map(shellQuote).join(' ');
  return env.LOVELACE_PORT ? `LOVELACE_PORT=${port} ${executable}` : executable;
}

function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

export function agentGuide(): string {
  return readFileSync(new URL('../SKILL.md', import.meta.url), 'utf8');
}

export const version: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
