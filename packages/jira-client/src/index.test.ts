import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiraClient } from './index.js';

const credentials = { baseUrl: 'https://api.atlassian.test/ex/jira/cloud-id', siteUrl: 'https://jira.test', email: 'fixture@example.test', apiToken: 'fixture-only-token' };
const issue = (id = '1') => ({ id, key: `TEST-${id}`, fields: { summary: 'Test issue', status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } }, project: { key: 'TEST' }, issuetype: { name: 'Task' }, reporter: { displayName: 'Fixture User' }, updated: '2026-10-01T00:00:00Z', description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Example description' }] }] } } });

test('assigned search paginates with nextPageToken, injects auth, converts ADF and preserves cloud URL paths', async () => {
  const bodies: Record<string, unknown>[] = [];
  const jira = createJiraClient({ ...credentials, fetch: async (url, init) => {
    assert.equal(String(url), `${credentials.baseUrl}/rest/api/3/search/jql`);
    assert.equal(new Headers(init?.headers).get('authorization'), 'Basic ' + Buffer.from('fixture@example.test:fixture-only-token').toString('base64'));
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    return Response.json(body.nextPageToken ? { issues: [issue('2')], isLast: true } : { issues: [issue()], isLast: false, nextPageToken: 'next' });
  } });
  const issues = await jira.fetchAssignedIssues();
  assert.deepEqual(issues.map((entry) => entry.key), ['TEST-1', 'TEST-2']);
  assert.equal(issues[0]?.url, 'https://jira.test/browse/TEST-1');
  assert.equal(issues[0]?.descriptionText, 'Example description');
  assert.equal(issues[0]?.author, 'Fixture User');
  assert.equal(issues[0]?.statusCategory, 'indeterminate');
  assert.equal(bodies[0]?.nextPageToken, undefined);
  assert.equal(bodies[1]?.nextPageToken, 'next');
  assert.match(String(bodies[0]?.jql), /statusCategory != Done/);
});

test('project search paginates using provider maxResults and browse site URL', async () => {
  const offsets: string[] = [];
  const jira = createJiraClient({ ...credentials, fetch: async (input) => {
    const url = new URL(String(input)); offsets.push(url.searchParams.get('startAt')!);
    assert.equal(url.pathname, '/ex/jira/cloud-id/rest/api/3/project/search');
    const last = url.searchParams.get('startAt') === '1';
    return Response.json({ values: [{ id: last ? '2' : '1', key: last ? 'TWO' : 'ONE', name: 'Project' }], maxResults: 1, isLast: last });
  } });
  const projects = await jira.fetchProjects();
  assert.deepEqual(offsets, ['0', '1']);
  assert.deepEqual(projects.map((project) => project.url), ['https://jira.test/browse/ONE', 'https://jira.test/browse/TWO']);
});

test('individual issue fetch encodes path, selects fields and treats 404 as null', async () => {
  const urls: string[] = [];
  const jira = createJiraClient({ ...credentials, fetch: async (input) => {
    urls.push(String(input));
    return urls.length === 1 ? Response.json(issue()) : new Response(null, { status: 404 });
  } });
  assert.equal((await jira.fetchIssue('TEST/1'))?.key, 'TEST-1');
  assert.equal(new URL(urls[0]!).pathname, '/ex/jira/cloud-id/rest/api/3/issue/TEST%2F1');
  assert.match(new URL(urls[0]!).searchParams.get('fields')!, /summary,status/);
  assert.equal(await jira.fetchIssue('missing'), null);
  assert.equal(await jira.fetchIssue('missing'), null);
  assert.equal(urls.length, 3);
});

test('partial, malformed and later-page errors reject instead of returning partial lists', async () => {
  let mode = 'partial';
  const jira = createJiraClient({ ...credentials, fetch: async (_, init) => {
    const token = JSON.parse(String(init?.body)).nextPageToken;
    if (mode === 'partial') return Response.json({ issues: [], errorMessages: ['Partial query failure'] });
    if (mode === 'missing') return Response.json({});
    if (mode === 'invalid') return Response.json({ issues: [issue(), {}] });
    if (mode === 'rate-limited') return new Response(null, { status: 429 });
    return token ? new Response(null, { status: 500 }) : Response.json({ issues: [issue('2')], nextPageToken: 'next' });
  } });
  for (mode of ['partial', 'missing', 'invalid', 'rate-limited', 'page']) await assert.rejects(jira.fetchAssignedIssues());
});

test('invalid project records and non-advancing pagination reject', async () => {
  let mode = 'invalid';
  const jira = createJiraClient({ ...credentials, fetch: async () => Response.json({
    values: mode === 'invalid' ? [{ id: '1' }] : [{ id: '1', key: 'TEST', name: 'Project' }],
    isLast: false, maxResults: 0,
  }) });
  await assert.rejects(jira.fetchProjects(), /Invalid Jira project/);
  mode = 'zero';
  await assert.rejects(jira.fetchProjects(), /pagination/);
});

test('missing credentials reject without calling the transport', async () => {
  const jira = createJiraClient({ baseUrl: credentials.baseUrl, fetch: async () => { throw new Error('must not call'); } });
  assert.equal(jira.isConfigured(), false);
  await assert.rejects(jira.fetchAssignedIssues(), /token missing/);
  await assert.rejects(jira.fetchProjects(), /token missing/);
  await assert.rejects(jira.fetchIssue('TEST-1'), /token missing/);
});

test('each request times out through its abort signal and a later request can succeed', async () => {
  let stalled = true;
  const jira = createJiraClient({ ...credentials, requestTimeoutMs: 20, fetch: async (_, init) => {
    if (!stalled) return Response.json(issue());
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
  } });
  await assert.rejects(jira.fetchIssue('TEST-1'), /Jira request timed out after 20ms/);
  stalled = false;
  assert.equal((await jira.fetchIssue('TEST-1'))?.key, 'TEST-1');
});

test('caller cancellation reaches every request', async () => {
  const signals: AbortSignal[] = [];
  const jira = createJiraClient({ ...credentials, fetch: async (_, init) => {
    signals.push(init!.signal!);
    return Response.json({ issues: [issue()] });
  } });
  const controller = new AbortController();
  await jira.fetchAssignedIssues({ signal: controller.signal });
  controller.abort();
  assert.equal(signals[0]?.aborted, true);
});

test('Jira validates the request timeout before any transport work', () => {
  for (const value of [0, -1, NaN, Infinity, 0.5]) {
    assert.throws(() => createJiraClient({ ...credentials, requestTimeoutMs: value }), /requestTimeoutMs/);
  }
});
