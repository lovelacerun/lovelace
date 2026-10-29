import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServerConfig } from '@lovelace/core';
import { createJiraTracker } from './jira.js';

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

  const issues = await createJiraTracker(config(), { fetch }).fetchAssignedIssues();

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
  assert.equal(issues[0]?.done, false);
});

test('issues are done by status category, or by status name without one', async () => {
  const statuses = [{ name: 'Erledigt', statusCategory: { key: 'done' } }, { name: 'Closed' }, { name: 'In Progress', statusCategory: { key: 'indeterminate' } }];
  const fetch: typeof globalThis.fetch = async () => Response.json({
    issues: statuses.map((status, index) => ({ id: String(index), key: `TEST-${index}`, fields: { summary: 'S', status, updated: '2026-08-10T08:00:00.000Z' } })),
  });
  const issues = await createJiraTracker(config(), { fetch }).fetchAssignedIssues();
  assert.deepEqual(issues.map((issue) => issue.done), [true, true, false]);
});

test('issue references are keys, numeric IDs or browse URLs', () => {
  const jira = createJiraTracker(config());
  assert.equal(jira.parseIssueRef({ key: ' test-1 ' }), 'TEST-1');
  assert.equal(jira.parseIssueRef({ key: '10001' }), '10001');
  assert.equal(jira.parseIssueRef({ url: 'https://jira.atlassian.test/browse/TEST-2' }), 'TEST-2');
  assert.equal(jira.parseIssueRef({ key: 'nope', url: 'https://jira.atlassian.test/projects/TEST' }), null);
});

test('assigned issue sync reports non-successful Jira responses', async () => {
  const fetch: typeof globalThis.fetch = async () => new Response(null, { status: 502 });

  await assert.rejects(
    createJiraTracker(config(), { fetch }).fetchAssignedIssues(),
    /jira assigned issue sync failed \(502\)/,
  );
});

function config(): ServerConfig {
  return {
    domainRoot: '/tmp/lovelace-test',
    lovelaceDir: '/tmp/lovelace-test/.lovelace',
    port: 27421,
    logLevel: 'info',
    syncIntervalMs: 300_000,
    defaultAgent: 'pi',
    jira: {
      baseUrl: 'https://api.atlassian.test/ex/jira/cloud-id',
      siteUrl: 'https://jira.atlassian.test',
      email: 'user@example.com',
      apiToken: 'test-token',
    },
  };
}
