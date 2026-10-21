import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { CODING_HARNESSES, configPath, loadConfig } from '@lovelace/core';
import { findExecutable } from '@lovelace/server';
import {
  DEPENDENCIES, editConfigText, jiraApiBaseUrl, jiraCloudId, normalizeJiraSite, parseIntegrationStatus, parseTopics,
  readConfigText, type ConfigEdits,
} from './init-config.js';
import { backgroundDeps, serverCommand } from './background.js';

const KEYCHAIN_SERVICE = 'lovelace';

/**
 * Interactive first-run setup: checks dependencies, writes
 * ~/.config/lovelace/config.jsonc (keeping existing comments and settings),
 * stores tokens in the login Keychain and (re)starts the background server.
 * Tokens are typed into `security`, never into this process.
 */
export async function init(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('lovelace init is interactive and requires a TTY');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (question: string, fallback = '') => (await rl.question(fallback ? `${question} [${fallback}] ` : `${question} `)).trim() || fallback;
  const confirm = async (question: string, fallback: boolean) => {
    const answer = (await ask(`${question} (${fallback ? 'Y/n' : 'y/N'})`)).toLowerCase();
    return answer ? answer.startsWith('y') : fallback;
  };
  const run = (command: string, args: string[], interactive = false) => spawnSync(command, args, {
    encoding: 'utf8', stdio: interactive ? 'inherit' : 'pipe', timeout: interactive ? undefined : 15_000,
  });

  try {
    console.log('Lovelace setup\n\nDependencies');
    const found = new Map(DEPENDENCIES.map(dependency => [dependency.name, findExecutable(dependency.name)]));
    for (const dependency of DEPENDENCIES) {
      const path = found.get(dependency.name);
      console.log(`  ${path ? '✓' : dependency.required ? '✗' : '–'} ${dependency.name.padEnd(6)} ${path ?? `${dependency.purpose}: ${dependency.install}`}`);
    }
    const agents = CODING_HARNESSES.filter(harness => findExecutable(harness.id));
    console.log(`  ${agents.length ? '✓' : '✗'} agents ${agents.map(agent => agent.id).join(', ') || 'install Pi, Claude Code or Codex'}`);
    if (DEPENDENCIES.some(dependency => dependency.required && !found.get(dependency.name))) {
      console.log('\nInstall the missing required tools, then run lovelace init again.');
      return;
    }

    const herdr = found.get('herdr')!;
    const integrations = parseIntegrationStatus(run(herdr, ['integration', 'status']).stdout ?? '');
    for (const agent of agents) {
      const state = integrations.get(agent.id) ?? 'unknown';
      if (state === 'current' || state === 'unknown') continue;
      if (await confirm(`Herdr's ${agent.id} integration is ${state}; Lovelace needs it to see agent state. Install it now?`, true)) {
        run(herdr, ['integration', 'install', agent.id], true);
      }
    }

    const path = configPath();
    const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const current = readConfigText(text) as { github?: Record<string, unknown>; jira?: Record<string, unknown> };
    const defaults = loadConfig();
    console.log(`\n${text ? 'Updating' : 'Creating'} ${path}`);
    const edits: ConfigEdits = [];

    const root = await ask('Where should Lovelace keep clones, worktrees and state?', tildePath(defaults.domainRoot));
    edits.push([['domainRoot'], root]);

    console.log('\nGitHub');
    const gh = found.get('gh');
    const ghLogin = gh ? run(gh, ['api', 'user', '--jq', '.login']).stdout?.trim() : '';
    const account = await ask('GitHub login:', String(current.github?.account ?? ghLogin ?? ''));
    const org = await ask('Organization whose review requests you want to see (optional):', String(current.github?.org ?? ''));
    const topics = await ask('Repository topics to preselect when starting Jira work (comma-separated, optional):', defaults.github?.repositoryTopics?.join(', ') ?? '');
    if (account) edits.push([['github', 'account'], account]);
    if (org) edits.push([['github', 'org'], org]);
    edits.push([['github', 'repositoryTopics'], parseTopics(topics)]);
    const host = defaults.github?.host ?? 'github.com';
    const ghToken = Boolean(gh && account && run(gh, ['auth', 'token', '--hostname', host, '--user', account]).status === 0);
    if (ghToken) {
      console.log(`  Using the GitHub CLI login of ${account}.`);
    } else if (!keychainHas('github-token') && await confirm('No GitHub CLI login found. Store a GitHub token in the Keychain?', true)) {
      storeInKeychain('github-token');
    }

    console.log('\nJira');
    if (await confirm('Use Jira?', Boolean(current.jira?.siteUrl))) {
      const site = normalizeJiraSite(await ask('Jira site (company.atlassian.net):', String(current.jira?.siteUrl ?? '').replace(/^https:\/\//, '')));
      const email = await ask('Atlassian account email:', String(current.jira?.email ?? ''));
      const cloudId = await jiraCloudId(site);
      edits.push([['jira', 'siteUrl'], site], [['jira', 'baseUrl'], jiraApiBaseUrl(cloudId)], [['jira', 'email'], email]);
      console.log(`  Cloud ID ${cloudId}. Create an API token with scopes, scope read:jira-work, at\n  https://id.atlassian.com/manage-profile/security/api-tokens`);
      const reference = typeof current.jira?.apiToken === 'string' && current.jira.apiToken.startsWith('op://') ? current.jira.apiToken : '';
      if (reference) {
        console.log(`  Keeping the 1Password reference ${reference}.`);
      } else if (!keychainHas('jira-api-token') || await confirm('Replace the Jira token in the Keychain?', false)) {
        const op = found.get('op') ? await ask('Paste a 1Password reference (op://…), or press Enter to type the token into the Keychain:') : '';
        if (op.startsWith('op://')) edits.push([['jira', 'apiToken'], op]);
        else storeInKeychain('jira-api-token');
      }
    }

    console.log('');
    const agentIds = agents.map(agent => agent.id);
    if (agentIds.length) {
      const agent = await ask(`Default agent (${agentIds.join(', ')}):`, agentIds.includes(defaults.defaultAgent) ? defaults.defaultAgent : agentIds[0]);
      if (agentIds.includes(agent as never)) edits.push([['defaultAgent'], agent]);
    }

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, editConfigText(text, edits));
    chmodSync(path, 0o600);
    console.log(`Wrote ${path}`);

    // Any lovelace command starts the server on demand; restart it so it reads the new config.
    const started = await serverCommand('restart', backgroundDeps({ log: message => console.log(message) })) as { port: number };
    console.log(`Lovelace is running on port ${started.port}. Open it with: lovelace tui`);
  } finally {
    rl.close();
  }

  function keychainHas(account: string): boolean {
    return run('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account]).status === 0;
  }

  function storeInKeychain(account: string): void {
    console.log(`  Paste the token when security asks for the password of ${KEYCHAIN_SERVICE}/${account}.`);
    const result = run('/usr/bin/security', ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'], true);
    if (result.status !== 0) console.log('  The token was not stored; rerun lovelace init to try again.');
  }
}

function tildePath(path: string): string {
  const home = homedir();
  return path === home ? '~' : path.startsWith(`${home}/`) ? join('~', path.slice(home.length + 1)) : path;
}
