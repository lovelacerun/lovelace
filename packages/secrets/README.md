# @lovelace/secrets

Resolve a secret from an ordered list of sources: the first source with a value
wins. It imports no application types, configuration or environment variables.

```ts
import { command, findExecutable, isOnePasswordReference, keychain, onePassword, plaintext, resolveSecret } from '@lovelace/secrets';

const configured = process.env.API_TOKEN;
const token = await resolveSecret([
  keychain('my-app', 'api-token'),
  isOnePasswordReference(configured) ? onePassword(configured) : plaintext(configured),
  command('gh', findExecutable('gh'), ['auth', 'token', '--user', 'me']),
], (error, source) => log.warn({ error, source }));
// { value, source: 'keychain' | '1password' | 'plaintext' | 'gh' } or undefined
```

## Sources

- `keychain(service, account)`: macOS login Keychain generic password through
  `/usr/bin/security`; a missing item is absent, other failures are errors. On
  other platforms it is `undefined` and skipped.
- `onePassword(reference)`: an `op://vault/item/field` reference through `op read`.
- `plaintext(value)`: a literal value from the environment or a config file.
- `command(name, file, args)`: the stdout of a credential helper.

A source returns `undefined` when the secret is not there and throws when the
source fails; `resolveSecret` reports failures to `onError` and moves on.
Commands run through an injectable `execute` option, so tests never touch real
keychains or CLIs. `findExecutable` also looks in Homebrew and `/usr/local/bin`,
because launchd agents start with a minimal search path.
