import { applyEdits, modify, parse } from 'jsonc-parser';

export interface Dependency {
  name: string;
  required: boolean;
  purpose: string;
  install: string;
}

export const DEPENDENCIES: Dependency[] = [
  { name: 'git', required: true, purpose: 'clones and worktrees', install: 'xcode-select --install' },
  { name: 'herdr', required: true, purpose: 'terminal host for agent sessions', install: 'brew install herdr' },
  { name: 'gh', required: false, purpose: 'borrow a GitHub CLI login instead of storing a token', install: 'brew install gh' },
  { name: 'op', required: false, purpose: 'read tokens from 1Password (op:// references)', install: 'brew install --cask 1password-cli' },
];

export type IntegrationState = 'current' | 'outdated' | 'not installed' | 'unknown';

/** Parses `herdr integration status` lines such as `claude: outdated (v10 < v11) (/path)`. */
export function parseIntegrationStatus(output: string): Map<string, IntegrationState> {
  const states = new Map<string, IntegrationState>();
  for (const match of output.matchAll(/^\s*([\w-]+):\s*(current|outdated|not installed)\b/gm)) {
    states.set(match[1]!, match[2] as IntegrationState);
  }
  return states;
}

/** Accepts `company`, `company.atlassian.net` or a full site URL. */
export function normalizeJiraSite(value: string): string {
  const host = value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return `https://${host.includes('.') ? host : `${host}.atlassian.net`}`;
}

/** Jira Cloud publishes each site's cloud ID without authentication. */
export async function jiraCloudId(siteUrl: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await fetchImpl(new URL('/_edge/tenant_info', siteUrl), { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${siteUrl} did not return a Jira cloud ID (${response.status})`);
  const { cloudId } = (await response.json()) as { cloudId?: unknown };
  if (typeof cloudId !== 'string' || !cloudId) throw new Error(`${siteUrl} did not return a Jira cloud ID`);
  return cloudId;
}

export const jiraApiBaseUrl = (cloudId: string) => `https://api.atlassian.com/ex/jira/${cloudId}`;

export function readConfigText(text: string): Record<string, unknown> {
  const parsed = parse(text);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

export type ConfigEdits = Array<[path: string[], value: unknown]>;

/** Applies edits to the existing JSONC text, keeping the user's comments and other settings. */
export function editConfigText(text: string, edits: ConfigEdits): string {
  let next = text.trim() ? text : '{}\n';
  for (const [path, value] of edits) {
    next = applyEdits(next, modify(next, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } }));
  }
  return next.endsWith('\n') ? next : `${next}\n`;
}

export function parseTopics(value: string): string[] {
  return value.split(/[\s,]+/).map(topic => topic.trim()).filter(Boolean);
}
