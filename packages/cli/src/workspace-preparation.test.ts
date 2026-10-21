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
  const preload = join(root, 'fake-http.mjs');
  await writeFile(preload, `
    let posts = 0;
    const payload = (repoId, status) => ({
      repoId, status, worktreePath: '/work/' + repoId, branchName: 'feature', dependenciesReused: repoId === 'a',
      preparedAt: '2026-01-01T00:00:00Z', sourceExternalId: null,
      ...(status === 'failed' ? { errorMessage: 'fixture install failed' } : {}),
    });
    const details = (ready) => ({ workItem: { id: 'work' }, metas: ['a','b'].map(repoId => ({
      id: repoId, metaType: 'repository', payloadJson: JSON.stringify(payload(repoId, ready ? (repoId === 'a' ? 'ready' : 'failed') : 'pending')),
    })) });
    globalThis.fetch = async (url, init) => {
      if (!String(url).startsWith('http://127.0.0.1:48999/')) throw new Error('Nonlocal fixture request');
      const path = new URL(url).pathname;
      if (path === '/repos') return Response.json(['a','b'].map(id => ({ id, name: id, fullName: 'org/' + id })));
      if (init?.method === 'POST') {
        posts++;
        if (posts !== 1) throw new Error('Mutation resubmitted');
        const body = JSON.parse(init.body);
        if (path !== '/work-items/work/repositories' || body.wait !== false || JSON.stringify(body.repositories) !== JSON.stringify([{ repoId: 'a', branchName: 'feature', baseBranch: 'parent' }])) throw new Error('Wrong submission');
        return Response.json(details(false), { status: 202 });
      }
      if (path === '/work-items/work') return Response.json(details(true));
      throw new Error('Unexpected request');
    };
  `);
  const result = spawnSync(process.execPath, ['--import', loader, '--import', preload, entry, 'work-items', 'add-worktree', 'work', 'a', '--branch', 'feature', '--base', 'parent'], {
    env: { ...process.env, LOVELACE_ROOT: root, LOVELACE_CONFIG: join(root, 'config.jsonc'), LOVELACE_PORT: '48999', LOVELACE_NO_AUTOSTART: '1' }, encoding: 'utf8', timeout: 5_000,
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
  const preload = join(root, 'fake-http.mjs');
  await writeFile(preload, `globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('http://127.0.0.1:48999/')) throw new Error('Nonlocal fixture request');
    if (new URL(url).pathname === '/repos') return Response.json([{ id: 'a', name: 'a', fullName: 'org/a' }]);
    if (init?.method === 'POST') setTimeout(() => process.emit('SIGINT'), 25);
    return Response.json({ workItem: { id: 'work' }, metas: [{ id: 'a', metaType: 'repository', payloadJson: JSON.stringify({ repoId: 'a', repoName: 'a', sourceExternalId: null, status: 'preparing' }) }] });
  };`);
  const result = spawnSync(process.execPath, ['--import', loader, '--import', preload, entry, 'work-items', 'add-worktree', 'work', 'a'], {
    env: { ...process.env, LOVELACE_ROOT: root, LOVELACE_CONFIG: join(root, 'config.jsonc'), LOVELACE_PORT: '48999', LOVELACE_NO_AUTOSTART: '1' }, encoding: 'utf8', timeout: 5_000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr).error;
  assert.match(error, /a: preparing/);
  assert.match(error, /not cancelled/);
  assert.match(error, /lovelace work-items workspaces work/);
});
