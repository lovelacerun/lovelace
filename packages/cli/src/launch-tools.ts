import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { CODING_HARNESSES, isToolLaunchOptionsById, loadConfig, type CodingHarnessId } from '@lovelace/core';
import { LovelaceClient } from '@lovelace/client';

export interface AgentCommandDeps {
  client: Pick<LovelaceClient, 'newSession' | 'openSession'>;
  uuid: () => string;
  readPrompt: (path: string) => Promise<string>;
}
function dependencies(overrides: Partial<AgentCommandDeps>): AgentCommandDeps {
  return {
    client: new LovelaceClient(`http://127.0.0.1:${loadConfig().port}`),
    uuid: randomUUID, readPrompt: path => readFile(path, 'utf8'), ...overrides,
  };
}

/** Start a new agent session in the work item's Herdr workspace. Never focuses it. */
export async function launchTools(args: string[], overrides: Partial<AgentCommandDeps> = {}): Promise<unknown> {
  const deps = dependencies(overrides);
  const { values, positionals } = parseArgs({
    args, allowPositionals: true,
    options: {
      model: { type: 'string' }, thinking: { type: 'string' },
      prompt: { type: 'string' }, 'prompt-file': { type: 'string' },
    },
  });
  const [workItemId, toolId] = positionals;
  if (positionals.length !== 2 || !workItemId || !CODING_HARNESSES.some(({ id }) => id === toolId)
    || (values.prompt === undefined) === (values['prompt-file'] === undefined)) {
    throw new Error('Usage: lovelace work-items launch <id> <pi|codex|claude> [--model <model>] [--thinking <level>] (--prompt <text> | --prompt-file <path>)');
  }
  const agentId = toolId as CodingHarnessId;
  const options = { [agentId]: { ...(values.model ? { model: values.model } : {}), ...(values.thinking ? { thinkingLevel: values.thinking } : {}) } };
  if (!isToolLaunchOptionsById(options)) {
    const levels = CODING_HARNESSES.find(({ id }) => id === agentId)!.thinkingLevels.join(', ');
    throw new Error(`Invalid launch options for ${toolId}. Supported thinking levels: ${levels}.`);
  }
  const prompt = values['prompt-file'] !== undefined ? await deps.readPrompt(values['prompt-file']) : values.prompt!;
  return deps.client.newSession(workItemId, prompt, agentId, options, deps.uuid());
}

/** Focus the session's Herdr pane, or continue its exact conversation when the agent ended. */
export async function openTool(args: string[], overrides: Partial<AgentCommandDeps> = {}): Promise<unknown> {
  const deps = dependencies(overrides);
  if (args.length !== 2 || !args[0] || !args[1]) throw new Error('Usage: lovelace work-items open <id> <session-meta-id>');
  return deps.client.openSession(args[0], args[1]);
}
