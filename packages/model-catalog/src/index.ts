import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);
/** Claude Code has no catalog command; its aliases always resolve to the latest models. */
const CLAUDE_ALIASES = ['fable', 'opus', 'sonnet', 'haiku'];

export type ModelHarness = 'pi' | 'codex' | 'claude';

/** A `--model` value the harness accepts; `label` is its display name when it has one. */
export interface HarnessModel {
  id: string;
  label?: string;
}

export interface ListModelsOptions {
  signal?: AbortSignal;
  /** Environment for the harness process, e.g. a fuller PATH than launchd's. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Default 10000. */
  timeoutMs?: number;
}

/** `pi --list-models` prints a table; Pi accepts `provider/model`. */
export function parsePiModels(output: string): HarnessModel[] {
  return output.split('\n').flatMap(line => {
    const [provider, model] = line.trim().split(/\s+/);
    return provider && model && provider !== 'provider' ? [{ id: `${provider}/${model}` }] : [];
  });
}

/** `codex debug models` prints the raw catalog; hidden models are internal. */
export function parseCodexModels(output: string): HarnessModel[] {
  const catalog = JSON.parse(output) as { models?: Array<{ slug?: unknown; display_name?: unknown; visibility?: unknown }> };
  return (catalog.models ?? []).flatMap(model => typeof model.slug === 'string' && model.visibility !== 'hide'
    ? [{ id: model.slug, ...(typeof model.display_name === 'string' && model.display_name !== model.slug ? { label: model.display_name } : {}) }]
    : []);
}

/**
 * Asks the harness's own CLI for the models it accepts. Rejects when the
 * listing fails; it never returns a partial or empty list for a failure.
 */
export async function listModels(harness: ModelHarness, executablePath: string, options: ListModelsOptions = {}): Promise<HarnessModel[]> {
  if (harness === 'claude') return CLAUDE_ALIASES.map(id => ({ id }));
  const { stdout } = await run(executablePath, harness === 'pi' ? ['--list-models'] : ['debug', 'models'], {
    cwd: homedir(), timeout: options.timeoutMs ?? 10_000, maxBuffer: 16 * 1024 * 1024, signal: options.signal, env: options.env ?? process.env,
  });
  return harness === 'pi' ? parsePiModels(stdout) : parseCodexModels(stdout);
}
