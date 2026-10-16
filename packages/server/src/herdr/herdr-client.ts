import { execFile } from 'node:child_process';
import type { CodingHarnessId, HerdrConfig } from '@lovelace/core';
import safeParse from '@nkzw/core/safeParse.js';
import { asRecord } from '../helpers.js';
import { executableSearchPath, findExecutable } from '../tools/executables.js';

export class HerdrError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'HerdrError';
  }
}

type HerdrAgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export interface HerdrPane {
  paneId: string;
  tabId: string;
  workspaceId: string;
  agent: string | null;
  agentStatus: HerdrAgentStatus;
  /** Native conversation identity reported by Herdr's agent integration. */
  agentSession: { kind: 'id' | 'path'; value: string } | null;
}

export interface HerdrWorkspace {
  workspaceId: string;
  tokens: Record<string, string>;
}

export interface HerdrClient {
  getWorkspace(workspaceId: string): Promise<HerdrWorkspace | null>;
  /** Creates an unfocused workspace and returns its root shell pane. */
  createWorkspace(input: { cwd: string; label: string }): Promise<{ workspaceId: string; tabId: string; paneId: string }>;
  /** Display-only workspace tokens. Herdr forgets them on restart. */
  reportWorkspaceTokens(workspaceId: string, tokens: Record<string, string>): Promise<void>;
  /** Creates an unfocused tab and returns its root shell pane. */
  createTab(input: { workspaceId: string; cwd: string; label: string }): Promise<{ tabId: string; paneId: string }>;
  listPanes(): Promise<HerdrPane[]>;
  /** Starts a harness in an idle shell pane; resolves once Herdr detects it ready for input. */
  startAgent(input: { name: string; kind: CodingHarnessId; paneId: string; args: string[] }): Promise<void>;
  promptAgent(name: string, text: string): Promise<void>;
  focusTab(tabId: string): Promise<void>;
}

export type HerdrExec = (file: string, args: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number }) =>
  Promise<{ exitCode: number; stdout: string; stderr: string }>;

const AGENT_START_TIMEOUT_MS = 30_000;

/** Talks to the running Herdr session through its CLI. */
export function createHerdrClient(config: HerdrConfig = {}, exec: HerdrExec = execHerdr): HerdrClient {
  const env = herdrEnvironment(process.env, config);
  const executable = () => {
    const path = config.executable ?? findExecutable('herdr');
    if (!path) throw new HerdrError('herdr_unavailable', 'Herdr is not installed or not on the server search path. Set herdr.executable in config.jsonc.');
    return path;
  };
  const call = async (args: string[], timeoutMs = 10_000): Promise<Record<string, unknown>> => {
    const response = await exec(executable(), args, { env, timeoutMs });
    const envelope = asRecord(safeParse(response.exitCode === 0 ? response.stdout : response.stderr));
    if (response.exitCode !== 0 || envelope.error) {
      const error = asRecord(envelope.error);
      const code = typeof error.code === 'string' ? error.code : 'herdr_failed';
      const message = typeof error.message === 'string' ? error.message : (response.stderr.trim() || `herdr ${args.slice(0, 2).join(' ')} failed`);
      throw new HerdrError(code, `Herdr: ${message}`);
    }
    // Herdr acknowledges some commands (for example `agent prompt`) without output.
    return asRecord(envelope.result);
  };

  return {
    async getWorkspace(workspaceId) {
      try {
        return toWorkspace((await call(['workspace', 'get', workspaceId])).workspace);
      } catch (error) {
        if (error instanceof HerdrError && error.code === 'workspace_not_found') return null;
        throw error;
      }
    },
    async createWorkspace({ cwd, label }) {
      const result = await call(['workspace', 'create', '--cwd', cwd, '--label', label, '--no-focus']);
      const pane = asRecord(result.root_pane);
      return { workspaceId: text(asRecord(result.workspace).workspace_id), tabId: text(pane.tab_id), paneId: text(pane.pane_id) };
    },
    async reportWorkspaceTokens(workspaceId, tokens) {
      await call(['workspace', 'report-metadata', workspaceId, '--source', 'lovelace',
        ...Object.entries(tokens).flatMap(([name, value]) => ['--token', `${name}=${value}`])]);
    },
    async createTab({ workspaceId, cwd, label }) {
      const pane = asRecord((await call(['tab', 'create', '--workspace', workspaceId, '--cwd', cwd, '--label', label, '--no-focus'])).root_pane);
      return { tabId: text(pane.tab_id), paneId: text(pane.pane_id) };
    },
    async listPanes() {
      const panes = (await call(['pane', 'list'])).panes;
      return Array.isArray(panes) ? panes.map(toPane) : [];
    },
    async startAgent({ name, kind, paneId, args }) {
      await call(['agent', 'start', name, '--kind', kind, '--pane', paneId, '--timeout', String(AGENT_START_TIMEOUT_MS), '--', ...args], AGENT_START_TIMEOUT_MS + 5_000);
    },
    async promptAgent(name, prompt) {
      await call(['agent', 'prompt', name, prompt]);
    },
    async focusTab(tabId) {
      await call(['tab', 'focus', tabId]);
    },
  };
}

/** Explicit IDs only: never inherit the caller's pane context, e.g. when the dev server runs inside Herdr. */
export function herdrEnvironment(base: NodeJS.ProcessEnv, config: HerdrConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, PATH: executableSearchPath(base) };
  for (const key of ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'HERDR_SOCKET_PATH']) delete env[key];
  if (config.socketPath) env.HERDR_SOCKET_PATH = config.socketPath;
  return env;
}

function execHerdr(file: string, args: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number }) {
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(file, args, { env: options.env, timeout: options.timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error?.killed) {
        reject(new HerdrError('herdr_timeout', `Herdr did not answer within ${options.timeoutMs} ms.`));
        return;
      }
      if (error && typeof error.code !== 'number') {
        reject(new HerdrError('herdr_unavailable', `Herdr CLI failed to run: ${error.message}`));
        return;
      }
      resolve({ exitCode: error ? Number(error.code) : 0, stdout, stderr });
    });
  });
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new HerdrError('herdr_invalid_response', 'Herdr returned an unexpected response.');
  return value;
}

const AGENT_STATUSES: HerdrAgentStatus[] = ['idle', 'working', 'blocked', 'done', 'unknown'];

function toPane(value: unknown): HerdrPane {
  const pane = asRecord(value);
  const session = asRecord(pane.agent_session);
  return {
    paneId: text(pane.pane_id),
    tabId: text(pane.tab_id),
    workspaceId: text(pane.workspace_id),
    agent: typeof pane.agent === 'string' ? pane.agent : null,
    agentStatus: AGENT_STATUSES.includes(pane.agent_status as HerdrAgentStatus) ? pane.agent_status as HerdrAgentStatus : 'unknown',
    agentSession: (session.kind === 'id' || session.kind === 'path') && typeof session.value === 'string' && session.value
      ? { kind: session.kind, value: session.value } : null,
  };
}

function toWorkspace(value: unknown): HerdrWorkspace {
  const workspace = asRecord(value);
  const tokens = Object.fromEntries(Object.entries(asRecord(workspace.tokens)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  return { workspaceId: text(workspace.workspace_id), tokens };
}
