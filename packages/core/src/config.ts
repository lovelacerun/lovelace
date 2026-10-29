import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { z } from 'zod';
import { CODING_HARNESSES, type CodingHarnessId } from './harnesses.js';
import { SIDEBAR_SIDES } from './dashboard.js';
import { configPath } from './paths.js';
import type { ClientSettings, ServerConfig } from './types.js';

const absolutePath = z.string().regex(/^\/[^\x00-\x1f]*$/, 'must be an absolute path');
const color = z.string().regex(/^(#[0-9a-f]{6}|none)$/i, 'must be #rrggbb or none');
const colors = z.record(z.string(), color).optional();

/** The operator's config file. Unknown keys are errors so typos and retired settings surface. */
const configFile = z.strictObject({
  domainRoot: z.string().default('~/projects'),
  port: z.int().min(1).max(65_535).default(27_421),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  syncIntervalMs: z.int().positive().default(5 * 60 * 1000),
  defaultAgent: z.enum(CODING_HARNESSES.map(harness => harness.id) as [CodingHarnessId, ...CodingHarnessId[]]).default('pi'),
  herdr: z.strictObject({ executable: absolutePath.optional(), socketPath: absolutePath.optional() }).prefault({}),
  tui: z.strictObject({
    sidebarSide: z.enum(SIDEBAR_SIDES).default('right'),
    icons: z.enum(['nerd', 'unicode']).default('nerd'),
    theme: z.enum(['dark', 'light']).default('dark'),
    colors: z.strictObject({ dark: colors, light: colors }).prefault({}),
  }).prefault({}),
  github: z.strictObject({
    token: z.string().optional(),
    org: z.string().optional(),
    host: z.string().optional(),
    apiBaseUrl: z.string().optional(),
    account: z.string().transform(account => account.trim() || undefined).optional(),
    repositoryTopics: z.array(z.string()).default([]),
  }).prefault({}),
  jira: z.strictObject({
    baseUrl: z.string().optional(),
    siteUrl: z.string().optional(),
    email: z.string().optional(),
    apiToken: z.string().optional(),
  }).prefault({}),
});

/** Everything the server needs; only the server and the CLI that manages it load this. */
export function loadServerConfig(): ServerConfig {
  const { tui: _, domainRoot, github, jira, ...file } = readConfigFile();
  const root = resolve(expandHome(domainRoot));
  return {
    ...file,
    domainRoot: root,
    lovelaceDir: join(root, '.lovelace'),
    github: { ...github, apiBaseUrl: github.apiBaseUrl ?? gitHubApiBaseUrl(github.host) },
    jira: { ...jira, siteUrl: jira.siteUrl ?? jira.baseUrl },
  };
}

/** What clients need to reach the server and render the TUI. */
export function loadClientSettings(): ClientSettings {
  const { port, tui } = readConfigFile();
  return { port, tui };
}

function readConfigFile(): z.output<typeof configFile> {
  const path = configPath();
  const errors: ParseError[] = [];
  const content = existsSync(path) ? parse(readFileSync(path, 'utf8'), errors, { allowTrailingComma: true }) : {};
  if (errors.length) {
    throw new Error(`Invalid config ${path}: ${errors.map(error => `${printParseErrorCode(error.error)} at offset ${error.offset}`).join(', ')}`);
  }
  const result = configFile.safeParse(content ?? {});
  if (!result.success) throw new Error(`Invalid config ${path}:\n${z.prettifyError(result.error)}`);
  return result.data;
}

function expandHome(path: string): string {
  return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

function gitHubApiBaseUrl(host: string | undefined): string | undefined {
  if (!host) return undefined;
  const normalized = host.replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (normalized === 'github.com') return 'https://api.github.com';
  return `https://${normalized}/api/v3`;
}
