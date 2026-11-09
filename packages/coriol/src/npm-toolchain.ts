import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hasInstallHooks, moduleDirectories, packageFiles, projectPath, readNpmLock, validateNpmPackages } from './npm-project.js';
import { run } from './process.js';
import type { WorkspaceToolchain } from './types.js';

const REQUIRED_FILES = ['package.json', 'package-lock.json'] as const;
const OPTIONAL_FILES = ['.npmrc', '.node-version', '.nvmrc'] as const;
// Values, not config-file locations: seed and worktree paths differ. Never persist config or credentials.
const INSTALL_SETTINGS = [
  'npm-version', 'omit', 'include', 'ignore-scripts', 'install-links', 'install-strategy',
  'legacy-peer-deps', 'strict-peer-deps', 'engine-strict', 'bin-links', 'node-options',
  'workspaces', 'workspace', 'include-workspace-root', 'cpu', 'os', 'libc', 'registry',
] as const;

async function npmConfig(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await run('npm', ['config', 'list', '--json'], path));
}

export function npmToolchain(): WorkspaceToolchain {
  return {
    id: 'npm',
    command: 'npm ci',

    async detect(path) {
      return REQUIRED_FILES.every((file) => existsSync(join(path, file)));
    },

    async fingerprint(path) {
      if (!REQUIRED_FILES.every((file) => existsSync(join(path, file)))) return null;
      const lock = await readNpmLock(path);
      const files = [...REQUIRED_FILES, ...OPTIONAL_FILES, ...packageFiles(lock)]
        .filter((file) => existsSync(projectPath(path, file))).sort();
      const config = await npmConfig(path);
      // Project lifecycle scripts can generate files outside node_modules. Run them in each worktree.
      if (!config['ignore-scripts'] && await hasInstallHooks(path, files.filter(file => file.endsWith('package.json')))) return null;
      const runtime = await run('node', ['-p', 'JSON.stringify({ node: process.version, abi: process.versions.modules, platform: process.platform, arch: process.arch })'], path);
      const versions = JSON.parse(await run('npm', ['--versions', '--json'], path)) as { node: string; npm: string; modules: string };
      const hash = createHash('sha256');
      hash.update(`npm-v2\0${runtime}\0${JSON.stringify({ node: versions.node, npm: versions.npm, abi: versions.modules })}\0`);
      hash.update(JSON.stringify(INSTALL_SETTINGS.map(key => [key, config[key]])));
      for (const key of ['userconfig', 'globalconfig']) {
        const file = config[key];
        if (typeof file === 'string' && existsSync(file)) hash.update(await readFile(file));
        hash.update('\0');
      }
      for (const file of files) {
        hash.update(`${file}\0`);
        hash.update(await readFile(projectPath(path, file)));
        hash.update('\0');
      }
      return hash.digest('hex');
    },

    async prepare(path) {
      await run('npm', ['ci'], path);
    },

    async validate(path) {
      const lock = await readNpmLock(path);
      if (!lock.packages) {
        // npm's own validator covers legacy v1 lockfiles without rewriting them.
        try { await run('npm', ['ls', '--all', '--json', '--offline'], path); return true; }
        catch { return false; }
      }
      const config = await npmConfig(path);
      const omit = new Set(Array.isArray(config.omit) ? config.omit as string[] : []);
      for (const include of Array.isArray(config.include) ? config.include as string[] : []) omit.delete(include);
      return validateNpmPackages(path, lock, omit);
    },

    async artifacts(path) {
      return moduleDirectories(await readNpmLock(path)).filter((directory) => existsSync(projectPath(path, directory)));
    },
  };
}
