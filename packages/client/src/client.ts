import type {
  AvailableHarness, CodingHarnessId, DashboardResponse, JiraIssueSummary, LaunchSelection, NewSessionRequest, PromptTemplate, RepoRecord,
  QuickStartResponse, RenderPromptInput, RenderedPrompt, SessionOpenResponse, StartWorkRepositoryInput, WorkItem, WorkItemDetails, WorkItemState,
} from '@lovelace/core';
import { prepareRepositories, type PrepareRepositoriesOptions } from './workspace-preparation.js';

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** Includes response-body consumption. Default: 15 seconds. */
  timeoutMs?: number;
}
export interface LaunchRequestOptions extends RequestOptions, LaunchSelection {
  /** false requests immediate acceptance; preparation/agent startup stay on the server. */
  wait?: boolean;
}
export type NewSessionOptions = NewSessionRequest['options'];
/** Herdr agent startup may take up to 30 seconds before a launch reply. */
const LAUNCH_TIMEOUT_MS = 60_000;

/** Thin server-only HTTP transport. Never retries mutations automatically. */
export class LovelaceClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(baseUrl: string, fetchFn: typeof fetch = globalThis.fetch.bind(globalThis)) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('Lovelace client requires an HTTP loopback server URL without credentials, query or path.');
    }
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchFn = fetchFn;
  }

  /** Actual configured local server address, for honest client status displays. */
  get serverUrl(): string { return this.baseUrl; }

  private async request<T>(path: string, init: RequestInit = {}, options: RequestOptions = {}): Promise<T> {
    const timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('timeoutMs must be positive');
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    let rejectAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(controller.signal.reason);
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const bounded = <T>(work: Promise<T>): Promise<T> => Promise.race([work, aborted]);
    const timer = setTimeout(() => controller.abort(new DOMException('Server request timed out', 'TimeoutError')), timeoutMs);
    const headers = new Headers(init.headers);
    if (init.body) headers.set('content-type', 'application/json');
    try {
      controller.signal.throwIfAborted();
      const response = await bounded(this.fetchFn(`${this.baseUrl}${path}`, {
        ...init, headers, signal: controller.signal, redirect: 'error',
      }));
      if (!response.ok) {
        let message = `Server request failed (${response.status})`;
        try {
          const body = await bounded(response.json()) as { error?: unknown; message?: unknown };
          if (typeof body.error === 'string') message = body.error;
          else if (typeof body.message === 'string') message = body.message;
        } catch { /* Keep the HTTP status when error bodies are not JSON. */ }
        controller.signal.throwIfAborted();
        throw new ApiError(response.status, message);
      }
      const body = await bounded(response.json()) as T;
      controller.signal.throwIfAborted();
      return body;
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof ApiError) throw error;
      // Do not leak URLs, request payloads or transport credentials in errors.
      throw new ApiError(0, 'Cannot reach Lovelace server or read its response. Check the server URL and retry.');
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      options.signal?.removeEventListener('abort', abort);
    }
  }

  /** Escape hatch for CLI-only server routes; never accepts a provider URL. */
  requestJson<T = unknown>(path: string, init?: RequestInit, options?: RequestOptions): Promise<T> {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Expected a local server route');
    return this.request(path, init, options);
  }

  getDashboard(options?: RequestOptions): Promise<DashboardResponse> {
    return this.request('/dashboard', {}, options);
  }
  renderPrompt(input: RenderPromptInput, options?: RequestOptions): Promise<RenderedPrompt> {
    return this.request('/prompts/render', { method: 'POST', body: JSON.stringify(input) }, options);
  }
  getRepositories(options?: RequestOptions): Promise<RepoRecord[]> {
    return this.request('/repos', {}, options);
  }
  syncRepositories(options?: RequestOptions): Promise<{ ok: boolean; repoCount: number; repos: RepoRecord[] }> {
    return this.request('/repos/sync', { method: 'POST' }, { ...options, timeoutMs: options?.timeoutMs ?? 60_000 });
  }
  /** Coding harnesses detected on the server, re-detected on every call. */
  getTools(options?: RequestOptions): Promise<AvailableHarness[]> {
    return this.request('/tools', {}, options);
  }
  getPromptTemplates(options?: RequestOptions): Promise<PromptTemplate[]> {
    return this.request('/prompts', {}, options);
  }
  getJiraIssues(options?: RequestOptions): Promise<JiraIssueSummary[]> {
    return this.request('/jira/issues', {}, options);
  }
  getWorkItem(id: string, options?: RequestOptions): Promise<WorkItemDetails> {
    return this.request(`/work-items/${encodeURIComponent(id)}`, {}, options);
  }
  /** Inspects the exact request identity without launching, including after a lost acceptance reply. */
  getLaunchOperation(requestId: string, options?: RequestOptions): Promise<QuickStartResponse> {
    return this.request(`/launch-operations/${encodeURIComponent(requestId)}`, {}, options);
  }
  /** Submits once and polls durable workspace state; cancellation only stops waiting. */
  prepareRepositories(id: string, repositories: StartWorkRepositoryInput[], options?: PrepareRepositoriesOptions): Promise<WorkItemDetails> {
    return prepareRepositories(this, id, repositories, options);
  }
  /** Omitted fields keep their current value; `notes: null` clears notes. */
  updateWorkItem(id: string, patch: { title?: string; notes?: string | null }, options?: RequestOptions): Promise<WorkItem> {
    return this.request(`/work-items/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }, options);
  }
  setWorkItemState(id: string, state: WorkItemState, options?: RequestOptions): Promise<WorkItem> {
    return this.request(`/work-items/${encodeURIComponent(id)}/state`, { method: 'POST', body: JSON.stringify({ state }) }, options);
  }
  quickStart(prompt: string, jiraIssueId?: string, agentId?: CodingHarnessId, overrides?: NewSessionOptions, requestId?: string, options?: LaunchRequestOptions): Promise<QuickStartResponse> {
    return this.request('/work-items/quick-start', {
      method: 'POST', body: JSON.stringify({ prompt, jiraIssueId, agentId, options: overrides, requestId, repoIds: options?.repoIds, promptId: options?.promptId, wait: options?.wait }),
    }, launchOptions(options));
  }
  /** By default waits for Herdr startup; wait:false returns durable acceptance instead. */
  newSession(id: string, prompt: string, agentId?: CodingHarnessId, overrides?: NewSessionOptions, requestId?: string, options?: LaunchRequestOptions): Promise<QuickStartResponse> {
    return this.request(`/work-items/${encodeURIComponent(id)}/new-session`, {
      method: 'POST', body: JSON.stringify({ prompt, agentId, options: overrides, requestId, repoIds: options?.repoIds, promptId: options?.promptId, wait: options?.wait }),
    }, launchOptions(options));
  }
  /** Focuses the session's Herdr pane, or continues its exact conversation when the agent ended. */
  openSession(id: string, metaId: string, options?: RequestOptions): Promise<SessionOpenResponse> {
    return this.request(`/work-items/${encodeURIComponent(id)}/sessions/${encodeURIComponent(metaId)}/open`, { method: 'POST' }, launchOptions(options));
  }
}

function launchOptions(options?: RequestOptions & { wait?: boolean }): RequestOptions {
  return options?.wait === false ? options : { ...options, timeoutMs: options?.timeoutMs ?? LAUNCH_TIMEOUT_MS };
}
