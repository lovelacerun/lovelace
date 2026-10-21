import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentCli, WorkItem } from '@lovelace/core';

interface ContextLogger {
  warn(...args: unknown[]): void;
}

/**
 * Appended to agent prompts at launch so the agent can call back into
 * Lovelace (add repos to the work item, mark it done, ...).
 *
 * Users can override this template at `<lovelaceDir>/prompts/agent-context.md`.
 * Available variables: {{workItemId}}, {{workItemTitle}}, {{cliCommand}}, {{skillPath}}.
 */
const DEFAULT_TEMPLATE = `

---

## Lovelace context

This session was launched by Lovelace for work item \`{{workItemId}}\` ("{{workItemTitle}}").

Invoke the Lovelace CLI as follows; it targets the server that launched this session:

    {{cliCommand}}

Read the usage guide at {{skillPath}} before first use. Most useful commands:

- \`{{cliCommand}} work-items show {{workItemId}}\` — inspect this work item and its prepared workspaces
- \`{{cliCommand}} work-items add-worktree {{workItemId}} <repo-name> [--branch <name>] [--base <branch>]\` — attach another repository, or another branch of one (e.g. stacked on --base); Lovelace prepares a warm worktree and reports its path
- \`{{cliCommand}} work-items attach-pr {{workItemId}} <pr-url>\` — after opening a pull request, attach it so Lovelace tracks its status
- \`{{cliCommand}} work-items done {{workItemId}}\` — mark this work item as done
- \`{{cliCommand}} repos\` — list repositories known to Lovelace
`;

/**
 * Appends the Lovelace agent context block to a launch prompt.
 *
 * Returns the prompt unchanged when the server was started without a CLI
 * (e.g. in tests) so a missing callback never blocks a tool launch.
 */
export function appendAgentContext(
  prompt: string | null,
  workItem: WorkItem,
  serverConfig: { lovelaceDir: string; agentCli?: AgentCli },
  logger: ContextLogger,
): string | null {
  const cli = serverConfig.agentCli;
  if (!cli) return prompt;

  const context = loadTemplate(serverConfig.lovelaceDir, logger)
    .replaceAll('{{workItemId}}', workItem.id)
    .replaceAll('{{workItemTitle}}', workItem.title)
    .replaceAll('{{cliCommand}}', cli.command)
    .replaceAll('{{skillPath}}', cli.skillPath);

  const base = prompt ?? '';
  return `${base}${context}`;
}

function loadTemplate(lovelaceDir: string, logger: ContextLogger): string {
  const overridePath = join(lovelaceDir, 'prompts', 'agent-context.md');
  try {
    return readFileSync(overridePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({ err: error, overridePath }, 'Failed to read agent context template override, using default');
    }
    return DEFAULT_TEMPLATE;
  }
}
