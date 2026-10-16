import assert from 'node:assert/strict';
import test from 'node:test';
import { listModels, parseCodexModels, parsePiModels } from './index.js';

test('parses the Pi model table and the visible Codex catalog', () => {
  assert.deepEqual(parsePiModels([
    'provider        model                       context  max-out  thinking  images',
    'anthropic       claude-opus-5-5             1M       128K     yes       yes',
    'openai-codex    gpt-6.1-sol                 400K     128K     yes       yes',
    '',
  ].join('\n')), [{ id: 'anthropic/claude-opus-5-5' }, { id: 'openai-codex/gpt-6.1-sol' }]);
  assert.deepEqual(parseCodexModels(JSON.stringify({ models: [
    { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list' },
    { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide' },
    { slug: 'plain', display_name: 'plain' },
  ] })), [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }, { id: 'plain' }]);
});

test('Claude Code offers its aliases without running anything; failed listings reject', async () => {
  assert.deepEqual((await listModels('claude', '/missing/claude')).map(model => model.id), ['fable', 'opus', 'sonnet', 'haiku']);
  await assert.rejects(listModels('pi', '/missing/pi'));
});
