import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * One place a secret may live. `read` returns `undefined` when the secret is
 * simply not there and throws when the source is broken (locked, denied, failing).
 */
export interface SecretSource {
  name: string;
  read(): Promise<string | undefined>;
}

export interface ResolvedSecret { value: string; source: string }

/** Runs an executable and resolves its stdout; rejects with `code` set on a nonzero exit. */
export type Execute = (file: string, args: string[], options: { timeoutMs: number }) => Promise<string>;

export interface CommandOptions { execute?: Execute }

/** First source that yields a nonempty value wins; failing sources are reported and skipped. */
export async function resolveSecret(sources: Array<SecretSource | undefined>, onError?: (error: unknown, source: string) => void): Promise<ResolvedSecret | undefined> {
  for (const source of sources) {
    if (!source) continue;
    try {
      const value = (await source.read())?.trim();
      if (value) return { value, source: source.name };
    } catch (error) {
      onError?.(error, source.name);
    }
  }
  return undefined;
}

/** A literal value, e.g. from an environment variable or a config file. */
export function plaintext(value: string | undefined): SecretSource {
  return { name: 'plaintext', read: async () => value };
}

/** A macOS login Keychain generic password; absent on other platforms. */
export function keychain(service: string, account: string, options: CommandOptions = {}): SecretSource | undefined {
  if (process.platform !== 'darwin' && !options.execute) return undefined;
  const execute = options.execute ?? defaultExecute;
  return {
    name: 'keychain',
    async read() {
      try {
        return await execute('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w'], { timeoutMs: 30_000 });
      } catch (error) {
        // errSecItemNotFound: nothing stored under this service and account.
        if ((error as { code?: unknown }).code === 44) return undefined;
        throw error;
      }
    },
  };
}

export const isOnePasswordReference = (value: string | undefined): value is string => /^op:\/\//.test(value?.trim() ?? '');

/** A 1Password secret reference (`op://vault/item/field`) read through the `op` CLI. */
export function onePassword(reference: string, options: CommandOptions = {}): SecretSource {
  // Generous timeout: the 1Password app may ask for Touch ID first.
  return command('1password', findExecutable('op'), ['read', '--no-newline', reference.trim()], options, 120_000);
}

/** The stdout of a credential helper such as `gh auth token`. */
export function command(name: string, file: string, args: string[], options: CommandOptions = {}, timeoutMs = 30_000): SecretSource {
  const execute = options.execute ?? defaultExecute;
  return { name, read: () => execute(file, args, { timeoutMs }) };
}

/**
 * Resolve an executable in Homebrew or `/usr/local/bin` before falling back to
 * the search path; launchd agents start with a minimal PATH.
 */
export function findExecutable(name: string): string {
  return ['/opt/homebrew/bin', '/usr/local/bin'].map((dir) => `${dir}/${name}`).find((path) => existsSync(path)) ?? name;
}

const defaultExecute: Execute = (file, args, { timeoutMs }) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
    if (!error) return resolve(stdout);
    // Keep stderr's first line only: it explains the failure without echoing secrets.
    const reason = stderr.trim().split('\n')[0] || error.message.split('\n')[0];
    reject(Object.assign(new Error(`${file.split('/').at(-1)} failed: ${reason}`), { code: error.code }));
  });
});
