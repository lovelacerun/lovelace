import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

/** launchd has a minimal PATH. Check common install locations without sourcing a shell. */
export function executableSearchPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return [...new Set([
    ...(env.PATH ?? '').split(delimiter),
    join(home, '.local', 'bin'), join(home, '.npm-global', 'bin'), join(home, 'bin'),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  ].filter((directory) => isAbsolute(directory)))].join(delimiter);
}

export function findExecutable(name: string, searchPath = executableSearchPath()): string | null {
  for (const directory of searchPath.split(delimiter).filter(isAbsolute)) {
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
