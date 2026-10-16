# Example Lovelace home

Copy `config.jsonc.example` to `~/.config/lovelace/config.jsonc` and the other
examples into `<domainRoot>/.lovelace`:

- `config.jsonc.example`: state root, terminal dashboard/provider settings (no secrets).
- `prompts/`: user-owned launch templates.
- `release-checks/`: optional PR release scripts.

Users install and run Herdr and its agent integrations; Lovelace never starts
it. The server opens a Herdr workspace per work item and starts agents there.
Pi, Claude Code and Codex are detected automatically. The scripting CLI never
opens a TUI implicitly.

Keep tokens in the server environment. Builds never install or restart services.
Existing user overrides remain editable; release scripts, not Lovelace, define
environment release semantics.
