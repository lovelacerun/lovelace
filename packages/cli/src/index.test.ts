import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('./index.ts', import.meta.url));
const loader = import.meta.resolve('tsx');

test('no-argument CLI prints help; JSON agent/server commands never open TUI; explicit tui requires TTY', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-cli-entry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const preload = join(root, 'fake-http.mjs');
  await writeFile(preload, `globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('http://127.0.0.1:48999/')) throw new Error('Nonlocal fixture request');
    return Response.json({ path: new URL(url).pathname, body: init?.body ? JSON.parse(init.body) : null });
  };\n`);
  const run = (args: string[]) => spawnSync(process.execPath, ['--import', loader, '--import', preload, entry, ...args], {
    env: { ...process.env, LOVELACE_ROOT: root, LOVELACE_CONFIG: join(root, 'config.jsonc'), LOVELACE_PORT: '48999', LOVELACE_NO_AUTOSTART: '1' }, encoding: 'utf8', timeout: 5_000,
  });
  for (const args of [[], ['--'], ['help'], ['--help']]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /lovelace <command>/);
    assert.doesNotMatch(result.stdout, /\x1b|dashboard \(default\)/);
    assert.equal(result.stderr, '');
  }
  for (const [args, path] of [[['status'], '/status'], [['inbox'], '/inbox'], [['work-items', 'start', 'work'], '/work-items/work/state']] as const) {
    const result = run([...args]);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.path, path);
    assert.equal(result.stderr, '');
  }
  const invalid = run(['work-items', 'launch']);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '');
  assert.match(JSON.parse(invalid.stderr).error, /Usage/);
  const tui = run(['tui']);
  assert.equal(tui.status, 1);
  assert.equal(tui.stdout, '');
  assert.match(tui.stderr, /requires a TTY/);
});

test('work-items update sends only passed fields', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-cli-update-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const preload = join(root, 'fake-http.mjs');
  await writeFile(preload, `globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('http://127.0.0.1:48999/')) throw new Error('Nonlocal fixture request');
    const { pathname } = new URL(url);
    if (!init?.method || init.method === 'GET') return Response.json({ path: pathname, method: 'GET' });
    return Response.json({ path: pathname, method: init.method, body: JSON.parse(init.body) });
  };\n`);
  const notesFile = join(root, 'notes.md');
  await writeFile(notesFile, 'From file\n');
  const run = (args: string[]) => spawnSync(process.execPath, ['--import', loader, '--import', preload, entry, ...args], {
    env: { ...process.env, LOVELACE_ROOT: root, LOVELACE_CONFIG: join(root, 'config.jsonc'), LOVELACE_PORT: '48999', LOVELACE_NO_AUTOSTART: '1' }, encoding: 'utf8', timeout: 5_000,
  });
  const cases: Array<[string[], { title?: string; notes?: string | null }]> = [
    [['--title', 'New title'], { title: 'New title' }],
    [['--notes', 'New notes'], { notes: 'New notes' }],
    [['--notes-file', notesFile], { notes: 'From file\n' }],
    [['--title', 'New title', '--clear-notes'], { title: 'New title', notes: null }],
  ];
  for (const [flags, body] of cases) {
    const result = run(['work-items', 'update', 'work', ...flags]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { path: '/work-items/work', method: 'PATCH', body });
  }
  for (const args of [['work'], ['work', '--notes', 'a', '--clear-notes'], ['work', '--title', ' '], ['--title', 'x'], ['work', '--bogus']]) {
    const result = run(['work-items', 'update', ...args]);
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(result.stdout, '');
    assert.ok(JSON.parse(result.stderr).error);
  }
});
