import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkItemDetails } from '@lovelace/core';
import { launchTools, openTool, type AgentCommandDeps } from './launch-tools.js';

let root: string; const originalConfig = process.env.LOVELACE_CONFIG;
before(async () => { root = await mkdtemp(join(tmpdir(), 'lovelace-cli-fixture-')); process.env.LOVELACE_CONFIG = join(root, 'config.jsonc'); });
after(async () => { if (originalConfig === undefined) delete process.env.LOVELACE_CONFIG; else process.env.LOVELACE_CONFIG = originalConfig; await rm(root, { recursive: true, force: true }); });
/** Exact file prompt: leading/trailing whitespace, astral, ZWJ, combining and CJK code points. */
const filePrompt = '\n  λ 👩🏽‍💻 é 漢字\n\n  ';
const details: WorkItemDetails = { workItem: { id: 'work', title: 'Fixture', state: 'active', notes: null, createdAt: '', updatedAt: '', startedAt: null, completedAt: null }, metas: [] };
function fixture() {
  const events: unknown[][] = [];
  const deps: AgentCommandDeps = {
    client: {
      newSession: async (id, prompt, agentId, options, requestId, ...rest) => {
        events.push(['newSession', { id, prompt, agentId, options, requestId }, rest]);
        return { details, launch: { ok: true, error: null, phase: 'started' } };
      },
      openSession: async (id, metaId) => { events.push(['open', id, metaId]); return { action: 'focused', details }; },
    },
    uuid: () => 'fixed-request-id',
    readPrompt: async path => { events.push(['readPrompt', path]); return filePrompt; },
  };
  return { deps, events };
}

test('explicit CLI launch asks the server to start the session with exact prompt, options and a fresh request ID', async () => {
  const f = fixture();
  const result = await launchTools(['work', 'pi', '--prompt-file', '/fixture/prompt.txt', '--model', 'chosen', '--thinking', 'high'], f.deps);
  assert.deepEqual(f.events.map(event => event[0]), ['readPrompt', 'newSession']);
  assert.equal(f.events[0]![1], '/fixture/prompt.txt');
  assert.deepEqual(f.events[1]![1], { id: 'work', prompt: filePrompt, agentId: 'pi', options: { pi: { model: 'chosen', thinkingLevel: 'high' } }, requestId: 'fixed-request-id' });
  assert.deepEqual(f.events[1]![2], [], 'no request options for a fresh launch');
  assert.deepEqual(result, { details, launch: { ok: true, error: null, phase: 'started' } });
});

test('CLI prompt argv whitespace stays exact and exactly one prompt source is required noninteractively', async () => {
  const f = fixture(); const prompt = '  exact\n\n ';
  await launchTools(['work', 'codex', '--prompt', prompt], f.deps);
  assert.deepEqual(f.events[0]![1], { id: 'work', prompt, agentId: 'codex', options: { codex: {} }, requestId: 'fixed-request-id' });
  f.events.length = 0;
  await assert.rejects(launchTools(['work', 'pi', '--prompt', 'x', '--prompt-file', 'x'], f.deps), /Usage: .*\(--prompt <text> \| --prompt-file <path>\)/);
  await assert.rejects(launchTools(['work', 'pi'], f.deps), /Usage: .*\(--prompt <text> \| --prompt-file <path>\)/);
  await assert.rejects(launchTools(['work', 'pi', '--model', 'chosen'], f.deps), /Usage:/);
  await assert.rejects(launchTools(['work', 'pi', '--thinking', 'bogus', '--prompt', 'x'], f.deps), /Invalid launch options for pi. Supported thinking levels: off, minimal/);
  assert.deepEqual(f.events, []);
});

test('open delegates focus or exact continuation to the server', async () => {
  const f = fixture();
  assert.deepEqual(await openTool(['work', 'meta'], f.deps), { action: 'focused', details });
  assert.deepEqual(f.events, [['open', 'work', 'meta']]);
  await assert.rejects(openTool(['work'], f.deps), /Usage: lovelace work-items open <id> <session-meta-id>/);
});
