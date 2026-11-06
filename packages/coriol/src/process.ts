import { AsyncLocalStorage } from 'node:async_hooks';
import { execa } from 'execa';

export interface WorkspaceCommand {
  command: string;
  args: string[];
  cwd: string;
  kind: 'git' | 'toolchain';
  /** When supplied, replaces the inherited environment. */
  env?: Record<string, string | undefined>;
}

/** Resolve command wrappers and environment without changing process-wide state. */
export type CommandEnvironmentPolicy = (command: WorkspaceCommand) => WorkspaceCommand | Promise<WorkspaceCommand>;
const policies = new AsyncLocalStorage<CommandEnvironmentPolicy | undefined>();

/** Scope the manager's built-in command execution to one asynchronous operation. */
export function withEnvironmentPolicy<T>(policy: CommandEnvironmentPolicy | undefined, operation: () => Promise<T>): Promise<T> {
  return policies.run(policy, operation);
}

export async function run(
  command: string,
  args: string[],
  cwd: string,
  kind: WorkspaceCommand['kind'] = 'toolchain',
): Promise<string> {
  const request: WorkspaceCommand = { command, args, cwd, kind };
  const resolved = await (policies.getStore()?.(request) ?? request);
  const result = await execa(resolved.command, resolved.args, {
    cwd: resolved.cwd,
    env: resolved.env,
    extendEnv: resolved.env === undefined,
    reject: false,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `${command} ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}
