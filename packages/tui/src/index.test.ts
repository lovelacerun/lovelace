import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from './index.js';

describe('TUI argument validation', () => {
  const defaults = { url: 'http://127.0.0.1:27421' };
  for (const url of ['http://127.0.0.1:1234', 'http://localhost:1234', 'http://[::1]:1234']) {
    it('accepts loopback HTTP ' + url, () => {
      assert.equal(parseArgs(['--url', url], defaults).url, url);
    });
  }
  for (const url of ['http-not-a-url', 'https://localhost', 'file:///etc/passwd',
    'http://localhost.evil.invalid', 'http://192.0.2.1', 'http://user:pass@localhost',
    'http://localhost:invalid']) {
    it('rejects invalid or non-loopback URL ' + url, () => {
      assert.throws(() => parseArgs(['--url', url], defaults));
    });
  }
  for (const args of [['--url'], ['--sidebar'], ['--sidebar', 'middle'], ['--icons', 'emoji'], ['--theme', 'sepia'], ['--unknown'], ['-z'], ['unexpected']]) {
    it('rejects arguments ' + args.join(' '), () => {
      assert.throws(() => parseArgs(args, defaults));
    });
  }
  it('supports the sidebar, icon and theme overrides and help', () => {
    assert.deepEqual(parseArgs(['--sidebar', 'left', '--icons', 'unicode', '--theme', 'light', '-h'], defaults), {
      url: defaults.url, sidebarSide: 'left', icons: 'unicode', theme: 'light', help: true,
    });
  });

  const bin = fileURLToPath(new URL('../bin/lovelace-tui.ts', import.meta.url));
  it('allows help through pipes without emitting terminal escapes', async t => {
    const root = await mkdtemp(join(tmpdir(), 'lovelace-tui-help-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), bin, '--help'], {
      encoding: 'utf8', env: { ...process.env, LOVELACE_ROOT: root, LOVELACE_CONFIG: join(root, 'config.jsonc'), LOVELACE_HOST: '127.0.0.1', LOVELACE_PORT: '27421' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
    assert.ok(!result.stdout.includes('\x1b'));
    assert.equal(result.stderr, '');
  });
  it('refuses piped input/output with a friendly stderr error and no ANSI or HTTP calls', async t => {
    const root = await mkdtemp(join(tmpdir(), 'lovelace-tui-pipe-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), bin], {
      encoding: 'utf8', env: { ...process.env, LOVELACE_ROOT: root, LOVELACE_CONFIG: join(root, 'config.jsonc'), LOVELACE_HOST: '127.0.0.1', LOVELACE_PORT: '1' },
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /requires a TTY/);
    assert.ok(!result.stderr.includes('\x1b'));
  });
});
