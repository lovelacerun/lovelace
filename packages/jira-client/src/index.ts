import { adfToText } from '@lovelace/adf-converter';
import {
  getIssue, searchAndReconsileIssuesUsingJqlPost, searchProjects,
  type Client, type IssueBean, type PageBeanProject, type RequestConfig, type ResponseConfig, type SearchAndReconcileResults,
} from '@lovelace/jira-platform-client';
import type { JiraIssueSummary, JiraProjectSummary } from './types.js';
export type * from './types.js';

export interface JiraClientOptions {
  baseUrl?: string;
  siteUrl?: string;
  email?: string;
  apiToken?: string;
  fetch?: typeof fetch;
  /** Per-request budget, including JSON body parsing (default 15000). */
  requestTimeoutMs?: number;
  now?: () => number;
}
export interface RequestOptions { signal?: AbortSignal }
export interface JiraClient {
  isConfigured(): boolean;
  fetchAssignedIssues(options?: RequestOptions): Promise<JiraIssueSummary[]>;
  fetchIssue(keyOrId: string, options?: RequestOptions): Promise<JiraIssueSummary | null>;
  fetchProjects(options?: RequestOptions): Promise<JiraProjectSummary[]>;
}

type ErrorPayload = { errorMessages?: string[]; errors?: Record<string, unknown> };
type CallConfig = { baseURL: string; signal: AbortSignal; client: Client };
const ISSUE_FIELDS = ['summary', 'status', 'issuetype', 'description', 'project', 'reporter', 'updated'] as const;

export function createJiraClient(options: JiraClientOptions): JiraClient {
  options = { ...options };
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1) throw new Error('requestTimeoutMs must be a positive integer');
  const now = options.now ?? Date.now;
  const fetchRequest = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl?.replace(/\/$/, '') ?? '';
  const browseBaseUrl = (options.siteUrl ?? baseUrl).replace(/\/$/, '');
  const auth = Buffer.from(`${options.email ?? ''}:${options.apiToken ?? ''}`).toString('base64');
  const configured = () => Boolean(baseUrl && options.email && options.apiToken);
  // Transport for the generated operations: injected fetch, Basic auth, JSON only for successful responses.
  async function client<TData>(config: RequestConfig): Promise<ResponseConfig<TData>> {
    const url = new URL(`${config.baseURL ?? ''}${config.url ?? ''}`);
    for (const [key, value] of Object.entries(config.params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const response = await fetchRequest(url, {
      method: config.method, signal: config.signal,
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', ...(config.data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: config.data === undefined ? undefined : JSON.stringify(config.data),
    });
    config.signal?.throwIfAborted();
    const data = response.ok ? await response.json() as TData : undefined as TData;
    return { data, status: response.status, statusText: response.statusText, headers: response.headers };
  }
  /** One request, aborted after `requestTimeoutMs` or when the caller cancels. */
  async function request<T>(label: string, signal: AbortSignal | undefined, call: (config: CallConfig) => Promise<ResponseConfig<T>>, allowNotFound = false): Promise<T | null> {
    if (!configured()) throw new Error('Jira base URL, email or API token missing');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`Jira request timed out after ${requestTimeoutMs}ms`)), requestTimeoutMs);
    try {
      const response = await call({ baseURL: baseUrl, signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal, client });
      if (allowNotFound && response.status === 404) return null;
      if (response.status < 200 || response.status >= 300) throw new Error(`jira ${label} failed (${response.status})`);
      return response.data;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    isConfigured: configured,
    async fetchAssignedIssues(fetchOptions) {
      const signal = fetchOptions?.signal;
      const issues: JiraIssueSummary[] = [];
      const seen = new Set<string>();
      let nextPageToken: string | undefined;
      // Explicit cap fails rather than publishing a silently truncated snapshot.
      for (let page = 0; page < 100; page++) {
        const payload = await request('assigned issue sync', signal, (config) => searchAndReconsileIssuesUsingJqlPost({ data: {
          jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
          maxResults: 100, fields: [...ISSUE_FIELDS], expand: 'names,schema',
          ...(nextPageToken ? { nextPageToken } : {}),
        } }, config)) as ErrorPayload & SearchAndReconcileResults;
        if (payload.errorMessages?.length || Object.keys(payload.errors ?? {}).length) throw new Error('Partial Jira assigned issue response');
        if (!Array.isArray(payload.issues)) throw new Error('Incomplete Jira assigned issue response');
        issues.push(...payload.issues.map((issue) => toIssueSummary(issue, browseBaseUrl, now)));
        if (payload.isLast === true || !payload.nextPageToken) {
          if (payload.isLast === false) throw new Error('Invalid Jira issue pagination');
          return issues;
        }
        if (seen.has(payload.nextPageToken)) throw new Error('Repeated Jira pagination token');
        nextPageToken = payload.nextPageToken;
        seen.add(nextPageToken);
      }
      throw new Error('Jira issue pagination limit exceeded');
    },
    async fetchIssue(keyOrId, fetchOptions) {
      // Generated paths interpolate raw parameters; encode keys ourselves.
      const payload = await request('issue fetch', fetchOptions?.signal, (config) => getIssue({
        issueIdOrKey: encodeURIComponent(keyOrId), params: { fields: [...ISSUE_FIELDS] },
      }, config), true);
      return payload === null ? null : toIssueSummary(payload, browseBaseUrl, now);
    },
    async fetchProjects(fetchOptions) {
      const signal = fetchOptions?.signal;
      const projects: JiraProjectSummary[] = [];
      let startAt = 0;
      for (let page = 0; page < 100; page++) {
        const payload = await request('project sync', signal, (config) => searchProjects({ params: { startAt, maxResults: 100 } }, config)) as ErrorPayload & PageBeanProject;
        if (payload.errorMessages?.length || Object.keys(payload.errors ?? {}).length) throw new Error('Partial Jira project response');
        if (!Array.isArray(payload.values)) throw new Error('Incomplete Jira project response');
        for (const project of payload.values) {
          const id = readString(project?.id), key = readString(project?.key), name = readString(project?.name);
          if (!id || !key || !name) throw new Error('Invalid Jira project response');
          projects.push({ id, key, name, url: `${browseBaseUrl}/browse/${encodeURIComponent(key)}` });
        }
        if (payload.isLast || (payload.total !== undefined && startAt + payload.values.length >= payload.total)) return projects;
        if (!payload.values.length) {
          if (payload.isLast === false) throw new Error('Incomplete Jira project pagination');
          return projects;
        }
        const step = payload.maxResults ?? payload.values.length;
        if (!Number.isInteger(step) || step <= 0) throw new Error('Invalid Jira project pagination');
        startAt += step;
      }
      throw new Error('Jira project pagination limit exceeded');
    },
  };
}

function toIssueSummary(issue: IssueBean, browseBaseUrl: string, now: () => number): JiraIssueSummary {
  if (!issue || !readString(issue.id) || !readString(issue.key) || !issue.fields || !readString(issue.fields.summary)) {
    throw new Error('Invalid Jira issue response');
  }
  const fields = issue.fields;
  const project = readNestedString(fields.project, 'key') ?? readNestedString(fields.project, 'name');
  const issueType = readNestedString(fields.issuetype, 'name');
  const status = fields.status && typeof fields.status === 'object' ? fields.status as Record<string, unknown> : null;
  return {
    id: issue.id!, key: issue.key!, title: readString(fields.summary)!,
    url: `${browseBaseUrl}/browse/${encodeURIComponent(issue.key!)}`, project,
    status: readNestedString(fields.status, 'name'), statusCategory: readNestedString(status?.statusCategory, 'key'), issueType, type: issueType,
    author: readNestedString(fields.reporter, 'displayName') ?? readNestedString(fields.reporter, 'emailAddress'),
    descriptionText: toDescriptionText(fields.description), updatedAt: readString(fields.updated) ?? new Date(now()).toISOString(),
  };
}
function readString(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value : null; }
function readNestedString(value: unknown, key: string): string | null {
  return value && typeof value === 'object' ? readString((value as Record<string, unknown>)[key]) : null;
}
function toDescriptionText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (value && typeof value === 'object' && 'type' in value) {
    return adfToText(value as Parameters<typeof adfToText>[0]).trim() || null;
  }
  return null;
}
