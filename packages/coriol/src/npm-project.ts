import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertInside } from './paths.js';

export interface NpmPackage {
  version?: string;
  resolved?: string;
  link?: boolean;
  dev?: boolean;
  optional?: boolean;
  peer?: boolean;
}

export interface NpmLock {
  packages?: Record<string, NpmPackage>;
}

export async function readNpmLock(path: string): Promise<NpmLock> {
  return JSON.parse(await readFile(join(path, 'package-lock.json'), 'utf8'));
}

export function projectPath(root: string, entry: string): string {
  const path = join(root, entry);
  assertInside(root, path, 'npm package path');
  return path;
}

export function packageFiles(lock: NpmLock): string[] {
  return Object.keys(lock.packages ?? {})
    .filter((entry) => entry && !entry.split('/').includes('node_modules'))
    .map((entry) => join(entry, 'package.json'));
}

/** Includes non-hoisted workspace dependencies; descendants of these trees copy with them. */
export function moduleDirectories(lock: NpmLock): string[] {
  const directories = new Set(['node_modules']);
  for (const entry of Object.keys(lock.packages ?? {})) {
    const parts = entry.split('/');
    const index = parts.indexOf('node_modules');
    if (index > 0) directories.add(parts.slice(0, index + 1).join('/'));
  }
  return [...directories].sort();
}

export async function validateNpmPackages(path: string, lock: NpmLock, omit: Set<string>): Promise<boolean> {
  for (const [entry, expected] of Object.entries(lock.packages ?? {})) {
    if (!entry.split('/').includes('node_modules')) continue;
    if ((expected.dev && omit.has('dev')) || (expected.optional && omit.has('optional')) || (expected.peer && omit.has('peer'))) continue;
    const target = projectPath(path, entry);
    try {
      if (expected.link) {
        if (!expected.resolved || await realpath(target) !== await realpath(projectPath(path, expected.resolved))) return false;
      }
      const actual = JSON.parse(await readFile(join(target, 'package.json'), 'utf8')) as { version?: string };
      if (expected.version && actual.version?.replace(/^v/, '') !== expected.version.replace(/^v/, '')) return false;
    } catch (error) {
      // npm may omit optional packages, including dependencies of unavailable platform binaries.
      if (expected.optional && !existsSync(target)) continue;
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  return true;
}

export async function hasInstallHooks(path: string, files: string[]): Promise<boolean> {
  for (const file of files) {
    const pkg = JSON.parse(await readFile(projectPath(path, file), 'utf8')) as { scripts?: Record<string, string> };
    if (['preinstall', 'install', 'postinstall', 'prepare'].some((key) => pkg.scripts?.[key])) return true;
    // npm also supplies a default install script for node-gyp projects.
    if (existsSync(join(dirname(projectPath(path, file)), 'binding.gyp'))) return true;
  }
  return false;
}
