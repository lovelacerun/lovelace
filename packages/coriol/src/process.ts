import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, sep } from 'node:path';
import { execa } from 'execa';
import { AsyncLocalStorage } from 'node:async_hooks';

export type CommandRunner = (command: string, args: string[], cwd: string) => Promise<string>;
const runners = new AsyncLocalStorage<CommandRunner>();

/** Scope execution policy to one asynchronous operation, never process.env. */
export function withCommandRunner<T>(runner: CommandRunner, operation: () => Promise<T>): Promise<T> {
  return runners.run(runner, operation);
}

function toolchainEnvironment(): NodeJS.ProcessEnv {
  const voltaHome = process.env.VOLTA_HOME?.trim() || join(homedir(), '.volta');
  const voltaBin = join(voltaHome, 'bin');
  if (!existsSync(voltaBin)) return process.env;

  const imagePrefix = join(voltaHome, 'tools', 'image') + sep;
  const entries = (process.env.PATH ?? '')
    .split(delimiter)
    .filter((entry) => entry && entry !== voltaBin && !entry.startsWith(imagePrefix));

  return {
    ...process.env,
    VOLTA_HOME: voltaHome,
    PATH: [voltaBin, ...entries].join(delimiter),
  };
}

export async function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = toolchainEnvironment(),
  useDirenv = true,
): Promise<string> {
  const runner = runners.getStore();
  if (runner) return runner(command, args, cwd);
  const direnv = useDirenv ? findExecutable('direnv', env.PATH) : null;
  const executable = direnv ?? command;
  const executableArgs = direnv ? ['exec', cwd, command, ...args] : args;
  const result = await execa(executable, executableArgs, {
    cwd,
    env,
    reject: false,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `${command} ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

function findExecutable(name: string, searchPath: string | undefined): string | null {
  for (const directory of (searchPath ?? '').split(delimiter).filter(isAbsolute)) {
    const path = join(directory, name);
    try {
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) return path;
    } catch {
      // Missing, broken symlink, or not executable: try the next directory.
    }
  }
  return null;
}
