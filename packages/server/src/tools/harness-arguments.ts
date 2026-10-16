import type { CodingHarnessId, ToolLaunchOptions } from '@lovelace/core';

import { UUID } from '../helpers.js';

export function isNativeSessionId(value: unknown): value is string { return typeof value === 'string' && UUID.test(value); }

/**
 * Native CLI flags only, leaving model/provider defaults alone unless
 * overridden. `resume` is the exact recorded conversation: a session ID for
 * Claude/Codex, a session file for Pi.
 */
export function harnessArguments(id: CodingHarnessId, options: ToolLaunchOptions = {}, resume?: string | null): string[] {
  if (resume && (id === 'pi' ? !resume.startsWith('/') : !isNativeSessionId(resume))) throw new Error(`Invalid ${id} native session identity`);
  const args: string[] = !resume ? []
    : id === 'codex' ? ['resume', resume] : id === 'claude' ? ['--resume', resume] : ['--session', resume];
  if (options.model?.trim()) args.push('--model', options.model.trim());
  if (options.thinkingLevel) {
    if (id === 'codex') args.push('-c', `model_reasoning_effort=${JSON.stringify(options.thinkingLevel)}`);
    else args.push(id === 'pi' ? '--thinking' : '--effort', options.thinkingLevel);
  }
  return args;
}
