import { spawn } from 'node:child_process';
import type { WorkspaceManager } from '@lovelace/coriol';
import type {
  PullRequestReleaseConfig,
  PullRequestReleaseStatus,
  RepoRecord,
} from '@lovelace/core';
import type { DatabaseState } from '../database.js';
import type { GitHubPullRequestStatus } from '@lovelace/github-client';
import { asRecord, isRecord, managedRepositoryId } from '../helpers.js';

const DEFAULT_SCRIPT_TIMEOUT_MS = 10_000;
const MAX_SCRIPT_OUTPUT_BYTES = 1024 * 1024;

interface ReleaseLogger {
  warn(...args: unknown[]): void;
}

export interface PullRequestReleaseChecker {
  isComplete(repositoryFullName: string, statuses: PullRequestReleaseStatus[] | undefined): boolean;
  check(pullRequest: GitHubPullRequestStatus): Promise<PullRequestReleaseStatus[]>;
}

export function createPullRequestReleaseChecker(input: {
  config: PullRequestReleaseConfig | undefined;
  lovelaceDir: string;
  database: DatabaseState;
  workspaceManager: WorkspaceManager;
  logger: ReleaseLogger;
}): PullRequestReleaseChecker {
  const environments = normalizeEnvironments(input.config?.environments);
  const defaultCommand = normalizeCommand(input.config?.script);
  const scripts = input.config?.scripts ?? {};
  const timeoutMs = positiveInteger(input.config?.scriptTimeoutMs) ?? DEFAULT_SCRIPT_TIMEOUT_MS;

  return {
    isComplete(repositoryFullName, statuses) {
      const configured = Boolean(normalizeCommand(scripts[repositoryFullName]) ?? defaultCommand);
      if (!configured) return Array.isArray(statuses) && statuses.length === 0;
      if (!Array.isArray(statuses) || statuses.length === 0) return false;
      if (environments.length === 0) return statuses.every((status) => status.released === true);
      return environments.every((environment) => statuses.some(
        (status) => status.environment === environment && status.released === true,
      ));
    },
    async check(pullRequest) {
      if (pullRequest.status !== 'merged' || !pullRequest.mergeCommitSha) return [];
      const command = normalizeCommand(scripts[pullRequest.repoFullName]) ?? defaultCommand;
      if (!command) return [];

      const repository = findRepository(input.database, pullRequest.repoFullName);
      if (!repository) {
        return unknownStatuses(environments, command[0]!, `Repository is not in the Lovelace catalog: ${pullRequest.repoFullName}`);
      }

      return checkWithScript({
        pullRequest,
        repository,
        environments,
        command,
        timeoutMs,
        cwd: input.lovelaceDir,
        workspaceManager: input.workspaceManager,
        logger: input.logger,
      });
    },
  };
}

async function checkWithScript(input: {
  pullRequest: GitHubPullRequestStatus;
  repository: RepoRecord;
  environments: string[];
  command: string[];
  timeoutMs: number;
  cwd: string;
  workspaceManager: WorkspaceManager;
  logger: ReleaseLogger;
}): Promise<PullRequestReleaseStatus[]> {
  const checkedAt = new Date().toISOString();
  try {
    const checkout = await input.workspaceManager.refreshRepository({
      id: managedRepositoryId(input.repository),
      cloneUrl: input.repository.cloneUrl,
      defaultBranch: input.repository.defaultBranch,
    });
    const stdout = await runScript({ ...input, checkoutPath: checkout.path });
    const parsed = JSON.parse(stdout) as unknown;
    return normalizeScriptOutput(parsed, input.environments, checkedAt, input.command[0]!);
  } catch (error) {
    input.logger.warn(
      { err: error, repository: input.pullRequest.repoFullName, pullRequest: input.pullRequest.number, command: input.command[0] },
      'Pull request release script failed',
    );
    return unknownStatuses(input.environments, input.command[0]!, errorMessage(error), checkedAt);
  }
}

function runScript(input: {
  pullRequest: GitHubPullRequestStatus;
  environments: string[];
  command: string[];
  timeoutMs: number;
  cwd: string;
  checkoutPath: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const [executable, ...args] = input.command;
    const child = spawn(executable!, args, {
      cwd: input.cwd,
      env: {
        ...process.env,
        LOVELACE_RELEASE_REPOSITORY: input.pullRequest.repoFullName,
        LOVELACE_RELEASE_CHECKOUT: input.checkoutPath,
        LOVELACE_RELEASE_PULL_REQUEST: String(input.pullRequest.number),
        LOVELACE_RELEASE_COMMIT: input.pullRequest.mergeCommitSha ?? '',
        LOVELACE_RELEASE_ENVIRONMENTS: input.environments.join(','),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`Release script timed out after ${input.timeoutMs}ms`));
    }, input.timeoutMs);

    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value ?? '');
    };

    child.on('error', (error) => finish(error));
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_SCRIPT_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(new Error('Release script output exceeded 1 MiB'));
      } else {
        stdout.push(chunk);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= MAX_SCRIPT_OUTPUT_BYTES) return;
      stderr.push(chunk.subarray(0, MAX_SCRIPT_OUTPUT_BYTES - stderrBytes));
      stderrBytes += chunk.length;
    });
    child.on('close', (code, signal) => {
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString('utf8').trim();
        finish(new Error(`Release script exited with ${signal ? `signal ${signal}` : `code ${code}`}${detail ? `: ${detail}` : ''}`));
        return;
      }
      finish(undefined, Buffer.concat(stdout).toString('utf8'));
    });

    child.stdin.on('error', (error) => finish(error));
    child.stdin.end(JSON.stringify({
      schemaVersion: 1,
      repository: input.pullRequest.repoFullName,
      checkoutPath: input.checkoutPath,
      pullRequest: {
        number: input.pullRequest.number,
        url: input.pullRequest.url,
        mergeCommitSha: input.pullRequest.mergeCommitSha,
      },
      environments: input.environments,
    }));
  });
}

function normalizeScriptOutput(
  value: unknown,
  configuredEnvironments: string[],
  checkedAt: string,
  executable: string,
): PullRequestReleaseStatus[] {
  const object = asRecord(value);
  const array = Array.isArray(object.releaseStatuses) ? object.releaseStatuses : null;
  const records = new Map<string, unknown>();
  let environments = configuredEnvironments;
  if (array) {
    for (const item of array) {
      const entry = asRecord(item);
      if (typeof entry.environment === 'string' && entry.environment.trim()) records.set(entry.environment.trim(), entry);
    }
    if (environments.length === 0) environments = [...records.keys()];
  } else {
    const environmentObject = isRecord(object.environments) ? object.environments : object;
    if (environments.length === 0) environments = Object.keys(environmentObject);
    for (const environment of environments) records.set(environment, environmentObject[environment]);
  }

  return environments.map((environment) => {
    const raw = records.get(environment);
    const entry = asRecord(raw);
    const released = typeof raw === 'boolean' || raw === null
      ? raw
      : typeof entry.released === 'boolean' || entry.released === null
        ? entry.released
        : null;
    return releaseStatus(environment, released, checkedAt, {
      source: `script:${executable}`,
      releasedAt: stringOrNull(entry.releasedAt),
      revision: stringOrNull(entry.revision),
      url: stringOrNull(entry.url),
      description: stringOrNull(entry.description)
        ?? (raw === undefined ? `Script returned no result for ${environment}` : null),
    });
  });
}

function unknownStatuses(
  environments: string[],
  executable: string,
  description: string,
  checkedAt = new Date().toISOString(),
): PullRequestReleaseStatus[] {
  return environments.map((environment) => releaseStatus(environment, null, checkedAt, {
    source: `script:${executable}`,
    description,
  }));
}

function releaseStatus(
  environment: string,
  released: boolean | null,
  checkedAt: string,
  details: Partial<Omit<PullRequestReleaseStatus, 'environment' | 'released' | 'checkedAt'>>,
): PullRequestReleaseStatus {
  return {
    environment,
    released,
    checkedAt,
    releasedAt: details.releasedAt ?? null,
    revision: details.revision ?? null,
    url: details.url ?? null,
    source: details.source ?? 'unknown',
    description: details.description ?? null,
  };
}

function findRepository(database: DatabaseState, fullName: string): RepoRecord | null {
  return database.listRepos().find((repository) => repository.provider === 'github' && repository.fullName === fullName) ?? null;
}

function normalizeEnvironments(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function normalizeCommand(value: string | string[] | undefined): string[] | null {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return null;
  const command = value.map((part) => part.trim()).filter(Boolean);
  return command.length > 0 ? command : null;
}

function positiveInteger(value: number | undefined): number | null {
  return Number.isInteger(value) && value! > 0 ? value! : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
