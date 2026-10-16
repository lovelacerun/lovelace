import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'jsonc-parser';
import { isSidebarSide, type SidebarSide } from './dashboard.js';
import { isCodingHarnessId, type CodingHarnessId } from './harnesses.js';
import { configPath, defaultDomainRoot, lovelaceDir } from './paths.js';
import type { LovelaceConfig, TuiThemeMode } from './types.js';

interface ConfigFileShape {
  domainRoot?: string;
  lovelaceDir?: string;
  port?: number;
  logLevel?: LovelaceConfig['logLevel'];
  syncIntervalMs?: number;
  defaultAgent?: string;
  herdr?: LovelaceConfig['herdr'];
  tui?: { sidebarSide?: string; icons?: string; theme?: string; colors?: unknown };
  pullRequestReleases?: LovelaceConfig['pullRequestReleases'];
  github?: LovelaceConfig['github'];
  jira?: LovelaceConfig['jira'];
}

export function loadConfig(): LovelaceConfig {
  const fileConfig = readConfigFile(configPath());

  const domainRoot = !process.env.LOVELACE_ROOT && fileConfig.domainRoot
    ? resolve(expandHome(fileConfig.domainRoot))
    : defaultDomainRoot();
  const lovelaceHome = fileConfig.lovelaceDir ?? lovelaceDir(domainRoot);

  return {
    domainRoot,
    lovelaceDir: lovelaceHome,
    port: parseInteger(process.env.LOVELACE_PORT) ?? fileConfig.port ?? 27421,
    logLevel: parseLogLevel(process.env.LOVELACE_LOG_LEVEL) ?? fileConfig.logLevel ?? 'info',
    syncIntervalMs:
      parseInteger(process.env.LOVELACE_SYNC_INTERVAL_MS) ?? fileConfig.syncIntervalMs ?? 5 * 60 * 1000,
    defaultAgent: parseAgentId(process.env.LOVELACE_DEFAULT_AGENT) ?? parseAgentId(fileConfig.defaultAgent) ?? 'pi',
    herdr: parseHerdrConfig(fileConfig.herdr),
    tui: {
      sidebarSide:
        parseSidebarSide(process.env.LOVELACE_TUI_SIDEBAR)
        ?? parseSidebarSide(fileConfig.tui?.sidebarSide)
        ?? 'right',
      icons: parseIconSet(process.env.LOVELACE_TUI_ICONS) ?? parseIconSet(fileConfig.tui?.icons) ?? 'nerd',
      theme: parseThemeMode(process.env.LOVELACE_TUI_THEME) ?? parseThemeMode(fileConfig.tui?.theme) ?? 'dark',
      colors: parseTuiColors(fileConfig.tui?.colors),
    },
    pullRequestReleases: fileConfig.pullRequestReleases,
    github: {
      token: process.env.GITHUB_TOKEN ?? fileConfig.github?.token,
      org: process.env.GITHUB_ORG ?? fileConfig.github?.org,
      host: process.env.GITHUB_HOST ?? fileConfig.github?.host,
      apiBaseUrl:
        fileConfig.github?.apiBaseUrl ?? resolveGitHubApiBaseUrl(process.env.GITHUB_HOST ?? fileConfig.github?.host),
      account: fileConfig.github?.account?.trim() || undefined,
      repositoryTopics:
        parseList(process.env.GITHUB_REPOSITORY_TOPICS) ?? fileConfig.github?.repositoryTopics ?? [],
    },
    jira: {
      baseUrl: process.env.JIRA_BASE_URL ?? fileConfig.jira?.baseUrl,
      siteUrl: process.env.JIRA_SITE_URL ?? fileConfig.jira?.siteUrl ?? fileConfig.jira?.baseUrl,
      email: process.env.JIRA_EMAIL ?? fileConfig.jira?.email,
      apiToken: process.env.JIRA_API_TOKEN ?? fileConfig.jira?.apiToken,
    },
  };
}

function readConfigFile(path: string): ConfigFileShape {
  if (!existsSync(path)) return {};

  const content = readFileSync(path, 'utf8');
  const parsed = parse(content);
  return parsed && typeof parsed === 'object' ? (parsed as ConfigFileShape) : {};
}

function expandHome(path: string): string {
  return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

function parseInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseAgentId(value: string | undefined): CodingHarnessId | undefined {
  return isCodingHarnessId(value) ? value : undefined;
}

export function parseThemeMode(value: string | undefined): TuiThemeMode | undefined {
  return value === 'dark' || value === 'light' ? value : undefined;
}

/** Keep `#rrggbb` and `none` values per theme; the TUI ignores unknown tokens. */
function parseTuiColors(value: unknown): NonNullable<LovelaceConfig['tui']['colors']> {
  const colors: NonNullable<LovelaceConfig['tui']['colors']> = {};
  if (!value || typeof value !== 'object') return colors;
  for (const mode of ['dark', 'light'] as const) {
    const entries = (value as Record<string, unknown>)[mode];
    if (!entries || typeof entries !== 'object') continue;
    colors[mode] = Object.fromEntries(Object.entries(entries).filter((entry): entry is [string, string] =>
      typeof entry[1] === 'string' && /^(#[0-9a-f]{6}|none)$/i.test(entry[1])));
  }
  return colors;
}

export function parseIconSet(value: string | undefined): 'nerd' | 'unicode' | undefined {
  return value === 'nerd' || value === 'unicode' ? value : undefined;
}

function parseSidebarSide(value: string | undefined): SidebarSide | undefined {
  return isSidebarSide(value) ? value : undefined;
}

function parseLogLevel(value: string | undefined): LovelaceConfig['logLevel'] | undefined {
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') return value;
  return undefined;
}

function resolveGitHubApiBaseUrl(host: string | undefined): string | undefined {
  if (!host) return undefined;
  const normalized = host.replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (normalized === 'github.com') return 'https://api.github.com';
  return `https://${normalized}/api/v3`;
}

function parseHerdrConfig(value: LovelaceConfig['herdr']): NonNullable<LovelaceConfig['herdr']> {
  if (value === undefined) return {};
  const path = (v: unknown) => v === undefined || (typeof v === 'string' && v.startsWith('/') && !/[\x00-\x1f]/.test(v));
  if (value && typeof value === 'object' && !Array.isArray(value) && path(value.executable) && path(value.socketPath)
    && Object.keys(value).every(key => key === 'executable' || key === 'socketPath')) return value;
  throw new Error('Invalid herdr configuration: executable and socketPath must be absolute paths');
}

function parseList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const entries = value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries : undefined;
}
