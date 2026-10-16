import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from './process.js';
import type { WorkspaceToolchain } from './types.js';

const REQUIRED_FILES = ['package.json', 'package-lock.json'] as const;
const OPTIONAL_FILES = ['.npmrc', '.node-version', '.nvmrc'] as const;

export function npmToolchain(): WorkspaceToolchain {
  return {
    id: 'npm',
    command: 'npm ci',

    async detect(path) {
      return REQUIRED_FILES.every((file) => existsSync(join(path, file)));
    },

    async fingerprint(path) {
      if (!REQUIRED_FILES.every((file) => existsSync(join(path, file)))) return null;
      const lock = JSON.parse(await readFile(join(path, 'package-lock.json'), 'utf8')) as { packages?: Record<string, unknown> };
      const workspacePackageFiles = Object.keys(lock.packages ?? {})
        .filter((entry) => entry && !entry.startsWith('node_modules/') && !entry.includes('/node_modules/'))
        .map((entry) => join(entry, 'package.json'))
        .filter((file) => existsSync(join(path, file)));
      const files = [...REQUIRED_FILES, ...OPTIONAL_FILES, ...workspacePackageFiles]
        .filter((file) => existsSync(join(path, file)))
        .sort();
      const hash = createHash('sha256');
      hash.update(`${process.platform}\0${process.arch}\0${process.version}\0`);
      for (const file of files) {
        hash.update(file);
        hash.update('\0');
        hash.update(await readFile(join(path, file)));
        hash.update('\0');
      }
      return hash.digest('hex');
    },

    async prepare(path) {
      await run('npm', ['ci'], path);
    },

    async artifacts(path) {
      return existsSync(join(path, 'node_modules')) ? ['node_modules'] : [];
    },
  };
}
