# @lovelace/model-catalog

Lists the models a coding harness accepts for `--model`, asking the harness's own CLI: `pi --list-models` (as `provider/model`) and `codex debug models` (models Codex hides are left out). Claude Code has no catalog command, so it offers its aliases (`fable`, `opus`, `sonnet`, `haiku`), which always resolve to the latest models. No caching, configuration or server dependencies; the server caches listings with `@lovelace/cache`.

```ts
import { listModels } from '@lovelace/model-catalog';

const models = await listModels('pi', '/opt/homebrew/bin/pi', { signal, env: { ...process.env, PATH: searchPath } });
// [{ id: 'anthropic/claude-opus-5-5' }, …]; Codex entries carry a display `label`.
```

A failed or timed-out listing (default 10 s) rejects; it never returns an empty list for a failure. Any other model name stays valid: the list is a suggestion, not a constraint.
