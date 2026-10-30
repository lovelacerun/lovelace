import { execFile } from 'node:child_process';
import type { ChangeRequest, PluginCommand, ReleaseChecks } from '@lovelace/core';
import { z } from 'zod';

const MAX_OUTPUT_BYTES = 1024 * 1024;

const reply = z.object({
  schemaVersion: z.literal(1),
  complete: z.boolean(),
  checks: z.array(z.object({
    name: z.string().min(1),
    state: z.enum(['done', 'pending', 'unknown']),
    detail: z.string().nullish().transform(value => value ?? null),
    url: z.string().nullish().transform(value => value ?? null),
  })),
});

export type ReleaseCheckResult = Omit<ReleaseChecks, 'checkedAt' | 'error'>;

export interface ReleaseCheckPlugin {
  check(changeRequest: ChangeRequest): Promise<ReleaseCheckResult>;
}

/**
 * Runs the configured executable once per merged change request. It reads
 * `{ schemaVersion, repository, number, url }` on stdin and writes the reply on stdout.
 */
export function createReleaseCheckPlugin(plugin: PluginCommand, cwd: string): ReleaseCheckPlugin {
  const [file, ...args] = plugin.command as [string, ...string[]];
  return {
    async check({ repository, number, url }) {
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = execFile(file, args, { cwd, timeout: plugin.timeoutMs, maxBuffer: MAX_OUTPUT_BYTES }, (error, out, stderr) => {
          if (error) reject(new Error(`${file} failed: ${stderr.trim() || error.message}`));
          else resolve(out);
        });
        child.stdin?.end(JSON.stringify({ schemaVersion: 1, repository, number, url }));
      });
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        throw new Error(`${file} did not print JSON`);
      }
      const result = reply.safeParse(parsed);
      if (!result.success) throw new Error(`${file} printed an invalid reply: ${z.prettifyError(result.error)}`);
      const { schemaVersion: _, ...checks } = result.data;
      return checks;
    },
  };
}
