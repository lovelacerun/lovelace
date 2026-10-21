#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { WorkItemDetails } from '@lovelace/core';
import { client, request } from './http.js';
import { launchTools, openTool } from './launch-tools.js';
import { selfInvocation, shellQuote, skillPath, version } from './self.js';

async function main() {
  const args = process.argv.slice(2).filter((value, index) => !(index === 0 && value === '--'));
  const [command = 'help', subcommand, ...rest] = args;

  switch (command) {
    case 'tui': {
      const { runTui } = await import('@lovelace/tui');
      return runTui(args.slice(1));
    }
    case 'server': {
      const { startServer } = await import('@lovelace/server');
      return startServer({
        // Pin the port so callbacks reach this server even when a worktree's direnv sets another.
        agentCli: port => ({ command: `LOVELACE_PORT=${port} ${selfInvocation().map(shellQuote).join(' ')}`, skillPath }),
      });
    }
    case 'service': {
      const { service } = await import('./service.js');
      return printJson(await service(args.slice(1)));
    }
    case 'init': {
      const { init } = await import('./init.js');
      return init();
    }
    case 'version':
    case '--version':
      return console.log(version);
    case 'dashboard':
      return printJson(await request('/dashboard'));
    case 'status':
      return printJson(await request('/status'));
    case 'repos':
      if (subcommand === 'sync') return printJson(await client().syncRepositories());
      return printJson(await request('/repos'));
    case 'inbox':
      if (subcommand === 'dismiss' || subcommand === 'start') return handleInbox(subcommand, rest);
      return printJson(await request('/inbox'));
    case 'work-items':
      return handleWorkItems(subcommand, rest);
    case 'cleanup':
      return printJson(await request('/workspaces/cleanup', { method: 'POST' }));
    case 'doctor':
      return printJson(await request('/workspaces/status'));
    case 'cache':
      return printJson(await request('/cache/snapshots'));
    case 'github':
      if (subcommand === 'reviews' && rest[0] === 'refresh') {
        return printJson(await request('/github/reviews/refresh', { method: 'POST' }));
      }
      if (subcommand === 'reviews') return printJson(await request('/github/reviews'));
      return printJson({ error: 'Usage: lovelace github reviews [refresh]' });
    case 'jira':
      if (subcommand === 'issues' && rest[0] === 'refresh') {
        return printJson(await request('/jira/issues/refresh', { method: 'POST' }));
      }
      if (subcommand === 'issues') return printJson(await request('/jira/issues'));
      return printJson({ error: 'Usage: lovelace jira issues [refresh]' });
    case 'help':
    default:
      return printHelp();
  }
}

async function handleInbox(subcommand: string | undefined, args: string[]) {
  switch (subcommand) {
    case 'start': {
      const sourceType = args[0]?.trim();
      if (!sourceType) {
        throw new Error('Usage: lovelace inbox start <work-item> <id> | <tracker-item|change-request> <provider> <externalId> <title>');
      }

      const body =
        sourceType === 'work-item'
          ? (() => {
              const id = args[1]?.trim();
              if (!id) throw new Error('Usage: lovelace inbox start work-item <id>');
              return { sourceType: 'work-item' as const, id };
            })()
          : (() => {
              const provider = args[1]?.trim();
              const externalId = args[2]?.trim();
              const title = args.slice(3).join(' ').trim();
              if (!provider || !externalId || !title) {
                throw new Error('Usage: lovelace inbox start <tracker-item|change-request> <provider> <externalId> <title>');
              }
              return {
                title,
                sources: [{ sourceType, provider, externalId }],
              };
            })();

      return printJson(
        await request('/inbox/activate', {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      );
    }
    case 'dismiss': {
      const sourceType = args[0]?.trim();
      if (!sourceType) {
        throw new Error('Usage: lovelace inbox dismiss <work-item> <id> | <tracker-item|change-request> <provider> <externalId> [externalId...]');
      }

      const body =
        sourceType === 'work-item'
          ? (() => {
              const id = args[1]?.trim();
              if (!id) throw new Error('Usage: lovelace inbox dismiss work-item <id>');
              return { sourceType: 'work-item' as const, id };
            })()
          : (() => {
              const provider = args[1]?.trim();
              const externalIds = args.slice(2).map((value) => value.trim()).filter(Boolean);
              if (!provider || externalIds.length === 0) {
                throw new Error('Usage: lovelace inbox dismiss <tracker-item|change-request> <provider> <externalId> [externalId...]');
              }
              return {
                sources: externalIds.map((externalId) => ({ sourceType, provider, externalId })),
              };
            })();

      return printJson(
        await request('/inbox/dismiss', {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      );
    }
    default:
      return printJson(await request('/inbox'));
  }
}

async function handleWorkItems(subcommand: string | undefined, args: string[]) {
  switch (subcommand) {
    case 'create': {
      const title = args.join(' ').trim();
      if (!title) throw new Error('Usage: lovelace work-items create <title>');
      return printJson(
        await request('/work-items/manual', {
          method: 'POST',
          body: JSON.stringify({ title }),
        }),
      );
    }
    case 'start': {
      const id = args[0]?.trim();
      if (!id) throw new Error('Usage: lovelace work-items start <id>');
      return printJson(
        await request(`/work-items/${id}/state`, {
          method: 'POST',
          body: JSON.stringify({ state: 'active' }),
        }),
      );
    }
    case 'done': {
      const id = args[0]?.trim();
      if (!id) throw new Error('Usage: lovelace work-items done <id>');
      return printJson(
        await request(`/work-items/${id}/state`, {
          method: 'POST',
          body: JSON.stringify({ state: 'done' }),
        }),
      );
    }
    case 'show': {
      const id = args[0]?.trim();
      if (!id) throw new Error('Usage: lovelace work-items show <id>');
      const details = (await request(`/work-items/${id}`)) as { workItem: unknown; metas: Array<{ metaType: string; provider: string | null; externalId: string | null; payloadJson: string | null }> };
      return printJson({ ...details, pullRequests: extractPullRequests(details.metas), jiraIssues: extractJiraIssues(details.metas) });
    }
    case 'update':
      return handleUpdate(args);
    case 'launch':
      return printJson(await launchTools(args));
    case 'open':
      return printJson(await openTool(args));
    case 'attach-pr':
      return handleAttachPr(args);
    case 'detach-pr':
      return handleDetachPr(args);
    case 'attach-jira':
      return handleAttachJira(args);
    case 'detach-jira':
      return handleDetachJira(args);
    case 'prs':
      return handlePrs(args);
    case 'add-worktree':
      return handleAddWorktree(args);
    case 'workspaces': {
      const id = args[0]?.trim();
      if (!id) throw new Error('Usage: lovelace work-items workspaces <id>');
      const details = (await request(`/work-items/${id}`)) as { metas: Array<{ metaType: string; payloadJson: string | null }> };
      return printJson(extractRepositoryWorkspaces(details.metas));
    }
    case 'list':
    default:
      return printJson(await request('/work-items'));
  }
}

const UPDATE_USAGE = 'Usage: lovelace work-items update <id> [--title <text>] [--notes <text> | --notes-file <path> | --clear-notes]';

async function handleUpdate(args: string[]) {
  const { values, positionals } = (() => {
    try {
      return parseArgs({
        args, allowPositionals: true,
        options: {
          title: { type: 'string' }, notes: { type: 'string' },
          'notes-file': { type: 'string' }, 'clear-notes': { type: 'boolean' },
        },
      });
    } catch {
      throw new Error(UPDATE_USAGE);
    }
  })();
  const id = positionals[0]?.trim();
  const notesSources = [values.notes, values['notes-file'], values['clear-notes']].filter((value) => value !== undefined);
  if (positionals.length !== 1 || !id || notesSources.length > 1 || (values.title === undefined && notesSources.length === 0)) {
    throw new Error(UPDATE_USAGE);
  }
  if (values.title !== undefined && !values.title.trim()) throw new Error('Title must not be empty');

  const notes = values['clear-notes']
    ? null
    : values['notes-file'] !== undefined ? await readFile(values['notes-file'], 'utf8') : values.notes;
  return printJson(
    await request(`/work-items/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ title: values.title, notes }) }),
  );
}

async function handleAttachPr(args: string[]) {
  const [id, ...refs] = args.map((value) => value.trim()).filter(Boolean);
  if (!id || refs.length === 0) throw new Error('Usage: lovelace work-items attach-pr <id> <pr...>');
  const metas = [];
  for (const ref of refs) {
    metas.push(await request(`/work-items/${id}/pull-requests`, { method: 'POST', body: JSON.stringify(bodyForPullRequestRef(ref)) }));
  }
  return printJson(metas);
}

async function handleDetachPr(args: string[]) {
  const [id, ref] = args.map((value) => value.trim()).filter(Boolean);
  if (!id || !ref) throw new Error('Usage: lovelace work-items detach-pr <id> <pr>');
  const parsed = parsePullRequestShorthand(ref);
  const externalId = parsed ? `${parsed.repoFullName}#${parsed.number}` : externalIdFromUrl(ref);
  if (!externalId) throw new Error('Pull request must be a GitHub URL or owner/repo#number');
  return printJson(await request(`/work-items/${id}/pull-requests/${encodeURIComponent(externalId)}`, { method: 'DELETE' }));
}

async function handleAttachJira(args: string[]) {
  const [id, ...refs] = args.map((value) => value.trim()).filter(Boolean);
  if (!id || refs.length === 0) throw new Error('Usage: lovelace work-items attach-jira <id> <issue...>');
  const metas = [];
  for (const ref of refs) {
    metas.push(await request(`/work-items/${id}/tracker-items`, { method: 'POST', body: JSON.stringify(bodyForJiraIssueRef(ref)) }));
  }
  return printJson(metas);
}

async function handleDetachJira(args: string[]) {
  const [id, ref] = args.map((value) => value.trim()).filter(Boolean);
  if (!id || !ref) throw new Error('Usage: lovelace work-items detach-jira <id> <issue>');
  const idOrKey = jiraKeyFromUrl(ref) ?? ref;
  return printJson(await request(`/work-items/${id}/tracker-items/${encodeURIComponent(idOrKey)}`, { method: 'DELETE' }));
}

function jiraKeyFromUrl(value: string): string | null {
  try {
    const parts = new URL(value).pathname.split('/').filter(Boolean);
    const key = parts[parts.indexOf('browse') + 1];
    return key && /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(key) ? key : null;
  } catch {
    return null;
  }
}

async function handlePrs(args: string[]) {
  const id = args[0]?.trim();
  if (!id) throw new Error('Usage: lovelace work-items prs <id> [--refresh]');
  const refresh = args.includes('--refresh');
  const metas = refresh
    ? ((await request(`/work-items/${id}/pull-requests/refresh`, { method: 'POST' })) as Array<{ metaType: string; externalId: string | null; payloadJson: string | null }>)
    : ((await request(`/work-items/${id}`)) as { metas: Array<{ metaType: string; externalId: string | null; payloadJson: string | null }> }).metas;
  return printJson(extractPullRequests(metas));
}

const ADD_WORKTREE_USAGE = 'Usage: lovelace work-items add-worktree <id> <repo> [--branch <name>] [--base <branch>]';

async function handleAddWorktree(args: string[]) {
  const { values, positionals } = (() => {
    try {
      return parseArgs({ args, allowPositionals: true, options: { branch: { type: 'string' }, base: { type: 'string' } } });
    } catch {
      throw new Error(ADD_WORKTREE_USAGE);
    }
  })();
  const [id, ref] = positionals.map((value) => value.trim());
  const branchName = values.branch?.trim();
  const baseBranch = values.base?.trim();
  if (positionals.length !== 2 || !id || !ref || branchName === '' || baseBranch === '') throw new Error(ADD_WORKTREE_USAGE);

  const repos = (await request('/repos')) as Array<{ id: string; name: string; fullName: string }>;
  const repo = repos.find((entry) => entry.id === ref || entry.name === ref || entry.fullName === ref);
  if (!repo) {
    const known = repos.map((entry) => entry.name).join(', ');
    throw new Error(`Unknown repo "${ref}". Known repos: ${known || '(none — run `lovelace repos sync` first)'}`);
  }
  const repositories = [{ repoId: repo.id, ...(branchName ? { branchName } : {}), ...(baseBranch ? { baseBranch } : {}) }];

  const controller = new AbortController();
  const interrupt = () => controller.abort(new DOMException('Workspace wait interrupted', 'AbortError'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  let details: WorkItemDetails;
  let previousProgress = '';
  try {
    details = await client().prepareRepositories(id, repositories, {
      signal: controller.signal,
      onProgress(workspaces) {
        if (!process.stderr.isTTY) return;
        const progress = workspaces.map(workspace =>
          `${workspace.repoName}: ${workspace.status}${workspace.preparationStep ? ` (${workspace.preparationStep})` : ''}`,
        ).join('; ');
        if (progress !== previousProgress) {
          process.stderr.write(`${progress}\n`);
          previousProgress = progress;
        }
      },
    });
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }

  return printJson({
    workItem: details.workItem,
    repositories: extractRepositoryWorkspaces(details.metas),
  });
}

function extractPullRequests(metas: Array<{ metaType: string; externalId: string | null; payloadJson: string | null }>) {
  return metas
    .filter((meta) => meta.metaType === 'pull-request' && meta.payloadJson)
    .map((meta) => {
      try {
        return { externalId: meta.externalId, ...JSON.parse(meta.payloadJson ?? '{}') };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function bodyForPullRequestRef(ref: string) {
  const parsed = parsePullRequestShorthand(ref);
  return parsed ?? { url: ref };
}

function bodyForJiraIssueRef(ref: string) {
  return /^([A-Za-z][A-Za-z0-9_]*-)?\d+$/.test(ref) ? { key: ref } : { url: ref };
}

function extractJiraIssues(metas: Array<{ metaType: string; provider: string | null; externalId: string | null; payloadJson: string | null }>) {
  return metas
    .filter((meta) => meta.metaType === 'tracker-item' && meta.provider === 'jira' && meta.payloadJson)
    .map((meta) => {
      try {
        return { externalId: meta.externalId, ...JSON.parse(meta.payloadJson ?? '{}') };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function parsePullRequestShorthand(value: string): { repoFullName: string; number: number } | null {
  const match = value.match(/^([^/]+\/[^#]+)#(\d+)$/);
  if (!match) return null;
  return { repoFullName: match[1], number: Number(match[2]) };
}

function externalIdFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[2] !== 'pull') return null;
    const number = Number(parts[3]);
    if (!parts[0] || !parts[1] || !Number.isInteger(number)) return null;
    return `${parts[0]}/${parts[1]}#${number}`;
  } catch {
    return null;
  }
}

function extractRepositoryWorkspaces(metas: Array<{ metaType: string; payloadJson: string | null }>) {
  const newestByWorktreePath = new Map<string, { repoId: string; status: string; worktreePath: string; branchName: string | null; dependenciesReused?: boolean; preparedAt: string; preparationStep?: string; errorMessage?: string | null }>();
  for (const meta of metas) {
    if (meta.metaType !== 'repository' || !meta.payloadJson) continue;
    try {
      const payload = JSON.parse(meta.payloadJson) as { repoId: string; status: string; worktreePath: string; branchName: string | null; dependenciesReused?: boolean; preparedAt: string; preparationStep?: string; errorMessage?: string | null };
      const existing = newestByWorktreePath.get(payload.worktreePath);
      if (!existing || existing.preparedAt < payload.preparedAt) {
        newestByWorktreePath.set(payload.worktreePath, payload);
      }
    } catch {
      // ignore malformed meta payloads
    }
  }
  return [...newestByWorktreePath.values()].map(({ repoId, status, worktreePath, branchName, dependenciesReused, preparationStep, errorMessage }) => ({
    repoId,
    status,
    worktreePath,
    branchName,
    dependenciesReused: dependenciesReused ?? false,
    ...(preparationStep ? { preparationStep } : {}),
    ...(errorMessage ? { errorMessage } : {}),
  }));
}

function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp() {
  console.log(`lovelace <command>

Setup:
  init                Check dependencies, write ~/.config/lovelace/config.jsonc and start the server
  server              Run the server in the foreground
  service install|uninstall|restart|status
                     Manage the macOS LaunchAgent that keeps the server running
  version             Print the Lovelace version

Commands:
  status              Show server status
  repos               List provider repositories
  repos sync          Sync repositories from configured providers
  inbox               List inbox work items
  inbox start         Mark an inbox item as active locally
  inbox dismiss       Dismiss an inbox item locally
                     External inbox actions take sourceType, provider and externalId
  work-items          List all work items
  work-items create   Create a manual work item
  work-items show     Show a work item with its workspaces, sessions and pull requests
  work-items update <id> [--title <text>] [--notes <text> | --notes-file <path> | --clear-notes]
                     Edit a work item's local title and notes; omitted fields are kept
  work-items attach-pr <id> <pr...> Attach GitHub PR URLs or owner/repo#number refs
  work-items detach-pr <id> <pr>    Detach a GitHub PR URL or owner/repo#number ref
  work-items attach-jira <id> <issue...> Attach Jira issues by key (PROJ-123) or browse URL
  work-items detach-jira <id> <issue>    Detach a Jira issue by key, id or browse URL
  work-items prs <id> [--refresh]   List attached pull requests
  work-items launch   Launch <id> <pi|codex|claude> [--model <model>] [--thinking <level>] (--prompt <text> | --prompt-file <path>)
                     Starts the agent in the work item's Herdr workspace without focusing it
  work-items open <id> <session-meta-id>  Focus the session in Herdr, or continue its ended conversation
  work-items start    Mark a work item as active
  work-items done     Mark a work item as done
  work-items add-worktree <id> <repo> [--branch <name>] [--base <branch>]
                     Prepare a repository worktree; the same repo and branch reuses it,
                     a new --branch adds a sibling (e.g. stacked on --base <parent branch>)
  work-items workspaces <id>  List workspace preparation state, paths and failures
  cleanup             Clean expired workspaces for completed work items
  doctor              Report Coriol copy-on-write workspace capabilities
  cache               List cache snapshots
  tui [--sidebar left|right]  Open the terminal dashboard explicitly
  dashboard                   Print the dashboard as JSON
  github reviews              List grouped GitHub review requests
  github reviews refresh      Force-refresh GitHub review requests
  jira issues                 List cached Jira assigned issues
  jira issues refresh         Force-refresh Jira assigned issues
`);
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
