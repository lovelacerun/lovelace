import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appendAgentContext } from './agent-context.js';
import { renderPrompt } from './prompt-service.js';

const logger = { warn() {} };

test('free-text prompts keep their exact text and gain the editable context block', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-agent-context-'));
  await mkdir(join(root, 'prompts'));
  await writeFile(join(root, 'prompts', 'agent-context.md'), '\nRun {{cli}} work show\n');
  t.after(() => rm(root, { recursive: true, force: true }));
  const prompt = '  Exact user prompt\n\n   ';
  const config = { lovelaceDir: root, agentCli: { command: 'lovelace' } };
  assert.equal(appendAgentContext(prompt, config, logger), prompt + '\n\nRun lovelace work show');
  assert.equal(appendAgentContext(prompt, { lovelaceDir: root }, logger), prompt);
});

test('built-in templates show the context block where the user can edit it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lovelace-agent-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = { promptId: 'implement', title: 'Fixture' };
  const rendered = renderPrompt({ lovelaceDir: root, agentCli: { command: '/opt/lovelace' } }, input, logger)!.content;
  assert.match(rendered, /^Implement: Fixture/);
  assert.match(rendered, /## Lovelace\n\n.*`\/opt\/lovelace agent-guide`.*`\/opt\/lovelace work show`/);
  assert.doesNotMatch(renderPrompt({ lovelaceDir: root }, input, logger)!.content, /Lovelace|{{/);
});
