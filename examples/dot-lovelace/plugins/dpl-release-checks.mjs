#!/usr/bin/env node
// Release-checks plugin backed by `dpl status --json` (@technik-sde/online-deploy-cli).
// Usage in config.jsonc:
//   "plugins": { "releaseChecks": { "command": ["~/projects/.lovelace/plugins/dpl-release-checks.mjs", "/path/to/dpl"] } }
// The optional argument is the dpl executable; it defaults to `dpl` on PATH.
// dpl reads GITHUB_PAT; without it the GitHub CLI login is used.
import { execFile, execFileSync } from 'node:child_process';

const dpl = process.argv[2] ?? 'dpl';
const STATES = { included: 'done', not_included: 'pending' };

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const { repository, number } = JSON.parse(raw);

const env = { ...process.env };
if (!env.GITHUB_PAT) {
  try {
    env.GITHUB_PAT = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch {
    // dpl reports the missing token itself.
  }
}

const status = await new Promise((resolve, reject) => {
  execFile(dpl, ['status', '--pr', String(number), '--repo', repository, '--json'], { env }, (error, stdout, stderr) => {
    // dpl may exit non-zero and still report; only a missing report is a failure.
    try {
      resolve(JSON.parse(stdout));
    } catch {
      reject(new Error(stderr.trim() || error?.message || 'dpl printed no JSON'));
    }
  });
}).catch((error) => {
  console.error(error.message);
  process.exit(1);
});

// Every object with a `status` is a release target, e.g. `main` and `prod`.
const checks = Object.entries(status)
  .filter(([, target]) => target && typeof target === 'object' && 'status' in target)
  .map(([name, target]) => ({ name, state: STATES[target.status] ?? 'unknown', detail: target.reason ?? null, url: null }));

console.log(JSON.stringify({
  schemaVersion: 1,
  complete: checks.length > 0 && checks.every(check => check.state === 'done'),
  checks,
}));
