import { CODING_HARNESSES, type AvailableHarness } from '@lovelace/core';
import { findExecutable } from './executables.js';

export type LoadedTool = Omit<AvailableHarness, 'models'>;

/** Only built-in coding harnesses are offered; the first detected one is preselected. */
export function detectTools(find = findExecutable): LoadedTool[] {
  return CODING_HARNESSES.flatMap(({ id, title, thinkingLevels }) => {
    const executablePath = find(id);
    return executablePath ? [{ id, title, thinkingLevels, executablePath }] : [];
  }).map((tool, index) => ({ ...tool, defaultSelected: index === 0 }));
}

export function loadTools(logger: { info(...args: unknown[]): void }): LoadedTool[] {
  const tools = detectTools();
  logger.info({ tools: tools.map(({ id, executablePath }) => ({ id, path: executablePath })) }, 'Detected coding harnesses');
  return tools;
}

export function refreshTools(tools: LoadedTool[]): void {
  tools.splice(0, tools.length, ...detectTools());
}
