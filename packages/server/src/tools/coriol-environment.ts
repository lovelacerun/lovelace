import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, sep } from 'node:path';
import type { CommandEnvironmentPolicy } from '@lovelace/coriol';
import { executableSearchPath, findExecutable } from './executables.js';

/** Lovelace's environment policy; Coriol itself only inherits its caller's environment. */
export function createCoriolEnvironmentPolicy(
  inherited: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): CommandEnvironmentPolicy {
  const env = { ...inherited, PATH: executableSearchPath(inherited, home) };
  const voltaHome = inherited.VOLTA_HOME?.trim() || join(home, '.volta');
  const voltaBin = join(voltaHome, 'bin');
  if (existsSync(voltaBin)) {
    const imagePrefix = join(voltaHome, 'tools', 'image') + sep;
    const entries = env.PATH.split(delimiter)
      .filter((entry) => entry !== voltaBin && !entry.startsWith(imagePrefix));
    Object.assign(env, { VOLTA_HOME: voltaHome, PATH: [voltaBin, ...entries].join(delimiter) });
  }
  const direnv = findExecutable('direnv', env.PATH);

  return (request) => ({
    ...request,
    ...(request.kind === 'toolchain' && direnv ? {
      command: direnv,
      args: ['exec', request.cwd, request.command, ...request.args],
    } : {}),
    env: { ...env },
  });
}
