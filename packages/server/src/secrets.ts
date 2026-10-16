import type { LovelaceConfig } from '@lovelace/core';
import {
  command, findExecutable, isOnePasswordReference, keychain, onePassword, plaintext, resolveSecret,
  type CommandOptions, type ResolvedSecret,
} from '@lovelace/secrets';

type Logger = Pick<import('pino').Logger, 'info' | 'warn'>;

/** Generic-password service under which provider tokens live in the login Keychain. */
export const KEYCHAIN_SERVICE = 'lovelace';

/**
 * Replace configured provider tokens with resolved values; only the server calls this.
 * Order: Keychain, then an `op://` reference or the plaintext value, then (GitHub
 * only) the GitHub CLI login of `github.account`.
 */
export async function resolveProviderSecrets(config: LovelaceConfig, logger: Logger, options: CommandOptions = {}): Promise<void> {
  const onError = (error: unknown, source: string) => logger.warn({ source, err: { message: (error as Error).message } }, 'Secret source failed');
  const configured = (value: string | undefined) => isOnePasswordReference(value) ? onePassword(value, options) : plaintext(value);

  const github = await resolveSecret([
    keychain(KEYCHAIN_SERVICE, 'github-token', options),
    configured(config.github?.token),
    githubCli(config, logger, options),
  ], onError);
  const jira = await resolveSecret([keychain(KEYCHAIN_SERVICE, 'jira-api-token', options), configured(config.jira?.apiToken)], onError);

  if (config.github) config.github.token = github?.value;
  if (config.jira) config.jira.apiToken = jira?.value;
  logger.info({ github: sourceOf(github), jira: sourceOf(jira) }, 'Resolved provider secrets');
}

/**
 * Borrow the GitHub CLI login of the configured account only: `gh`'s active
 * account changes with `gh auth switch`, which must not change Lovelace's identity.
 */
function githubCli(config: LovelaceConfig, logger: Logger, options: CommandOptions) {
  const account = config.github?.account;
  if (!account) {
    // Only reached when nothing earlier supplied a token.
    return { name: 'gh', read: async () => { logger.warn('No GitHub token configured; set github.account to use a GitHub CLI login'); return undefined; } };
  }
  const host = config.github?.host?.replace(/^https?:\/\//, '').replace(/\/$/, '') || 'github.com';
  return command('gh', findExecutable('gh'), ['auth', 'token', '--hostname', host, '--user', account], options);
}

const sourceOf = (secret: ResolvedSecret | undefined) => secret?.source ?? null;
