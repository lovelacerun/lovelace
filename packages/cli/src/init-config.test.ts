import assert from 'node:assert/strict';
import test from 'node:test';
import { editConfigText, jiraCloudId, normalizeJiraSite, parseIntegrationStatus, parseTopics, readConfigText } from './init-config.js';

test('config edits keep comments and unrelated settings', () => {
  const text = '{\n  // Where state lives.\n  "domainRoot": "~/old",\n  "tui": { "sidebarSide": "left" }\n}\n';
  const next = editConfigText(text, [[['domainRoot'], '~/projects'], [['github', 'account'], 'octocat'], [['github', 'repositoryTopics'], ['infra']]]);
  assert.match(next, /\/\/ Where state lives\./);
  assert.deepEqual(readConfigText(next), {
    domainRoot: '~/projects', tui: { sidebarSide: 'left' }, github: { account: 'octocat', repositoryTopics: ['infra'] },
  });
  assert.deepEqual(readConfigText(editConfigText('', [[['defaultAgent'], 'codex']])), { defaultAgent: 'codex' });
  assert.deepEqual(readConfigText('[]'), {});
});

test('jira sites and cloud IDs resolve from the public tenant endpoint', async () => {
  for (const input of ['company', 'company.atlassian.net', 'https://company.atlassian.net/jira/your-work']) {
    assert.equal(normalizeJiraSite(input), 'https://company.atlassian.net');
  }
  const requested: string[] = [];
  const fetchImpl = (async (url: URL) => {
    requested.push(String(url));
    return Response.json({ cloudId: 'cloud-1' });
  }) as typeof fetch;
  assert.equal(await jiraCloudId('https://company.atlassian.net', fetchImpl), 'cloud-1');
  assert.deepEqual(requested, ['https://company.atlassian.net/_edge/tenant_info']);
  await assert.rejects(jiraCloudId('https://x.atlassian.net', (async () => new Response('', { status: 404 })) as typeof fetch), /404/);
  await assert.rejects(jiraCloudId('https://x.atlassian.net', (async () => Response.json({})) as typeof fetch), /cloud ID/);
});

test('herdr integration status and topic lists parse', () => {
  const states = parseIntegrationStatus('pi: current (v9) (/p)\nclaude: outdated (v10 < v11) (/c)\ncodex: not installed (/x)\n');
  assert.deepEqual([...states], [['pi', 'current'], ['claude', 'outdated'], ['codex', 'not installed']]);
  assert.deepEqual(parseTopics(' infra, examplecom  web '), ['infra', 'examplecom', 'web']);
  assert.deepEqual(parseTopics(''), []);
});
