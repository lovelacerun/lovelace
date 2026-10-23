import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentCli } from '@lovelace/core';

interface ContextLogger {
  warn(...args: unknown[]): void;
}

interface ContextConfig {
  lovelaceDir: string;
  agentCli?: AgentCli;
}

/**
 * Tells the agent how to call back into Lovelace. Built-in templates show it
 * as `{{lovelace}}` so the user sees and may remove it; free-text prompts get
 * it appended at launch.
 *
 * Users can override this template at `<lovelaceDir>/prompts/agent-context.md`.
 * Available variables: {{cli}}.
 */
const DEFAULT_TEMPLATE = `## Lovelace

This session belongs to a Lovelace work item. Run \`{{cli}} agent-guide\` before your first Lovelace command. From any of its workspaces, \`{{cli}} work show\` prints the work item, its repositories and sessions. Attach pull requests you open with \`{{cli}} work attach-pr <url>\`.`;

/** The rendered context block, or '' when the server was started without a CLI (e.g. in tests). */
export function renderAgentContext(config: ContextConfig, logger: ContextLogger): string {
  const cli = config.agentCli;
  if (!cli) return '';
  return loadTemplate(config.lovelaceDir, logger).replaceAll('{{cli}}', cli.command).trim();
}

/** Appends the context block to a free-text launch prompt, keeping the prompt exact. */
export function appendAgentContext(prompt: string, config: ContextConfig, logger: ContextLogger): string {
  const context = renderAgentContext(config, logger);
  return context ? `${prompt}\n\n${context}` : prompt;
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
