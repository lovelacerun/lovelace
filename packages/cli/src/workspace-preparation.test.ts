import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('./index.ts', import.meta.url));
const loader = import.meta.resolve('tsx');

test('work-items add-worktree polls after submission and preserves final JSON including failed siblings', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-cli-workspaces-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'config.jsonc'), JSON.stringify({ port: 48999 }));
  const preload = join(root, 'fake-http.mjs');
  await writeFile(preload, `
    let posts = 0;
    const payload = (repoId, status) => ({
      repoId, status, worktreePath: '/work/' + repoId, branchName: 'feature', dependenciesReused: repoId === 'a',
      preparedAt: '2026-01-01T00:00:00Z', sourceExternalId: null,
      ...(status === 'failed' ? { errorMessage: 'fixture install failed' } : {}),
    });
    const details = (ready) => ({ workItem: { id: 'work' }, attachments: ['a','b'].map(repoId => ({
      id: repoId, type: 'worktree', payload: payload(repoId, ready ? (repoId === 'a' ? 'ready' : 'failed') : 'pending'),
    })) });
    const reply = data => Response.json({ result: { data } });
    globalThis.fetch = async (url, init) => {
      if (!String(url).startsWith('http://127.0.0.1:48999/trpc/')) throw new Error('Nonlocal fixture request');
      const path = new URL(url).pathname.slice('/trpc/'.length);
      if (path === 'repositories.list') return reply(['a','b'].map(id => ({ id, name: id, fullName: 'org/' + id })));
      if (path === 'workItems.addRepositories') {
        posts++;
        if (posts !== 1) throw new Error('Mutation resubmitted');
        const body = JSON.parse(init.body);
        if (body.id !== 'work' || body.wait !== false || JSON.stringify(body.repositories) !== JSON.stringify([{ repoId: 'a', branchName: 'feature', baseBranch: 'parent' }])) throw new Error('Wrong submission');
        return reply(details(false));
      }
      if (path === 'workItems.get' && JSON.parse(new URL(url).searchParams.get('input')).id === 'work') return reply(details(true));
      throw new Error('Unexpected request');
    };
  `);
  const result = spawnSync(process.execPath, ['--import', loader, '--import', preload, entry, 'work-items', 'add-worktree', 'work', 'a', '--branch', 'feature', '--base', 'parent'], {
    env: { ...process.env, LOVELACE_CONFIG: join(root, 'config.jsonc'), LOVELACE_NO_AUTOSTART: '1' }, encoding: 'utf8', timeout: 5_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '', 'non-TTY automation does not receive progress text');
  assert.deepEqual(JSON.parse(result.stdout), {
    workItem: { id: 'work' }, repositories: [
      { repoId: 'a', status: 'ready', worktreePath: '/work/a', branchName: 'feature', dependenciesReused: true },
      { repoId: 'b', status: 'failed', worktreePath: '/work/b', branchName: 'feature', dependenciesReused: false, errorMessage: 'fixture install failed' },
    ],
  });
});

test('Ctrl-C during workspace preparation emits a JSON interruption error with an inspection command', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-cli-workspace-interrupt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'config.jsonc'), JSON.stringify({ port: 48999 }));
  const preload = join(root, 'fake-http.mjs');
  await writeFile(preload, `globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('http://127.0.0.1:48999/trpc/')) throw new Error('Nonlocal fixture request');
    const path = new URL(url).pathname.slice('/trpc/'.length);
    if (path === 'repositories.list') return Response.json({ result: { data: [{ id: 'a', name: 'a', fullName: 'org/a' }] } });
    if (path === 'workItems.addRepositories') setTimeout(() => process.emit('SIGINT'), 25);
    return Response.json({ result: { data: { workItem: { id: 'work' }, attachments: [{ id: 'a', type: 'worktree', payload: { repoId: 'a', repoName: 'a', sourceExternalId: null, status: 'preparing' } }] } } });
  };`);
  const result = spawnSync(process.execPath, ['--import', loader, '--import', preload, entry, 'work-items', 'add-worktree', 'work', 'a'], {
    env: { ...process.env, LOVELACE_CONFIG: join(root, 'config.jsonc'), LOVELACE_NO_AUTOSTART: '1' }, encoding: 'utf8', timeout: 5_000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr).error;
  assert.match(error, /a: preparing/);
  assert.match(error, /not cancelled/);
  assert.match(error, /lovelace work-items workspaces work/);
});
