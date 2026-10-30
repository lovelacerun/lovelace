import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appendAgentContext } from './agent-context.js';
import { renderPrompt } from './prompt-service.js';

const logger = { warn() {} };

test('launch prompts keep their exact text and gain the context block', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-agent-context-'));
  await mkdir(join(root, 'prompts'));
  await writeFile(join(root, 'prompts', 'agent-context.md'), '\nRun {{cli}} work show\n');
  t.after(() => rm(root, { recursive: true, force: true }));
  const prompt = '  Exact user prompt\n\n   ';
  const config = { configDir: root, agentCli: { command: 'lovelace' } };
  assert.equal(appendAgentContext(prompt, config, logger), prompt + '\n\nRun lovelace work show');
  assert.equal(appendAgentContext(prompt, { configDir: root }, logger), prompt);
});

test('templates render without the context block; the default starts empty', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-agent-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rendered = renderPrompt(root, { promptId: 'implement', title: 'Fixture' })!.content;
  assert.match(rendered, /^Implement: Fixture/);
  assert.doesNotMatch(rendered, /Lovelace|{{/);
  assert.equal(renderPrompt(root, { promptId: 'default', title: 'Fixture' })!.content, '');
  await mkdir(join(root, 'prompts'));
  await writeFile(join(root, 'prompts', 'default.md'), 'Mine: {{title}}');
  assert.equal(renderPrompt(root, { promptId: 'default', title: 'Fixture' })!.content, 'Mine: Fixture');
});
