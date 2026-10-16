import { isAbsolute, relative, resolve } from 'node:path';
import type { RepositoryDescriptor } from './types.js';

export function validateRepository(repository: RepositoryDescriptor): void {
  validateRepositoryId(repository.id);
  if (!repository.cloneUrl.trim()) throw new Error('Repository cloneUrl is required');
}

export function validateRepositoryId(value: string): string[] {
  if (!value || isAbsolute(value) || value.includes('\\')) throw new Error(`Invalid repository id: ${value}`);
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Invalid repository id: ${value}`);
  }
  return segments;
}

export function validatePathSegment(value: string, label: string): string {
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || isAbsolute(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return value;
}

export function assertInside(parent: string, child: string, label: string): void {
  const relation = relative(resolve(parent), resolve(child));
  if (!relation || relation.startsWith('..') || isAbsolute(relation)) {
    throw new Error(`${label} must be below ${parent}: ${child}`);
  }
}
