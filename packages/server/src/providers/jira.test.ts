import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LovelaceConfig } from '@lovelace/core';
import { createJiraClient } from '../jira.js';

test('assigned issue sync uses fetch with the Jira search endpoint', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(
      JSON.stringify({
        issues: [
          {
            id: '10001',
            key: 'TEST-1',
            fields: {
              summary: 'Proxy-safe Jira sync',
              status: { name: 'In Progress' },
              issuetype: { name: 'Task' },
              project: { key: 'TEST' },
              reporter: { displayName: 'Test User' },
              updated: '2026-08-10T08:00:00.000Z',
            },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  const issues = await createJiraClient(config(), { fetch }).fetchAssignedIssues();

  assert.equal(requestUrl, 'https://api.atlassian.test/ex/jira/cloud-id/rest/api/3/search/jql');
  assert.equal(requestInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
    maxResults: 100,
    fields: ['summary', 'status', 'issuetype', 'description', 'project', 'reporter', 'updated'],
    expand: 'names,schema',
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.key, 'TEST-1');
  assert.equal(issues[0]?.url, 'https://jira.atlassian.test/browse/TEST-1');
});

test('assigned issue sync reports non-successful Jira responses', async () => {
  const fetch: typeof globalThis.fetch = async () => new Response(null, { status: 502 });

  await assert.rejects(
    createJiraClient(config(), { fetch }).fetchAssignedIssues(),
    /jira assigned issue sync failed \(502\)/,
  );
});

function config(): LovelaceConfig {
  return {
    domainRoot: '/tmp/lovelace-test',
    lovelaceDir: '/tmp/lovelace-test/.lovelace',
    port: 27421,
    logLevel: 'info',
    syncIntervalMs: 300_000,
    defaultAgent: 'pi', tui: { sidebarSide: 'right' },
    jira: {
      baseUrl: 'https://api.atlassian.test/ex/jira/cloud-id',
      siteUrl: 'https://jira.atlassian.test',
      email: 'user@example.com',
      apiToken: 'test-token',
    },
  };
}
