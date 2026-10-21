import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appendAgentContext } from './agent-context.js';

test('editable context template appends without trimming exact user prompt or inventing launch instructions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-agent-context-'));
  await mkdir(join(root, 'prompts'));
  await writeFile(join(root, 'prompts', 'agent-context.md'), '\nContext for {{workItemId}}');
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = { id: 'fixture-work', title: 'Fixture', state: 'active' as const, notes: null, createdAt: '', updatedAt: '', startedAt: null, completedAt: null };
  const logger = { warn() {} };
  const prompt = '  Exact user prompt\n\n   ';
  const config = { lovelaceDir: root, agentCli: { command: 'lovelace', skillPath: '/fixture/SKILL.md' } };
  const rendered = appendAgentContext(prompt, work, config, logger);
  assert.equal(rendered, prompt + '\nContext for fixture-work');
  assert.equal(appendAgentContext(null, work, config, logger), '\nContext for fixture-work');
  assert.equal(appendAgentContext(prompt, work, { lovelaceDir: root }, logger), prompt);
});
