import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiError, LovelaceClient } from './client.js';

function makeFetch(status: number, body: unknown, shouldThrow?: Error): typeof fetch {
  return async (_input, _init) => {
    if (shouldThrow) throw shouldThrow;
    const json = JSON.stringify(body);
    return new Response(json, {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

describe('LovelaceClient', () => {
  it('loads launch catalogs only from server routes and forwards selections verbatim', async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    const client = new LovelaceClient('http://localhost:27421', async (input, init) => {
      calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return Response.json([]);
    });
    await client.getRepositories();
    await client.getPromptTemplates();
    const selection = { repoIds: ['github:2', 'github:1'], promptId: 'refine' };
    await client.quickStart('  exact\n', '42', undefined, undefined, undefined, selection);
    await client.newSession('w/1', '  exact\n', undefined, undefined, undefined, selection);
    assert.deepEqual(calls.slice(0, 2).map(call => call.url), ['http://localhost:27421/repos', 'http://localhost:27421/prompts']);
    assert.deepEqual(calls[2]!.body, { prompt: '  exact\n', jiraIssueId: '42', ...selection });
    assert.deepEqual(calls[3]!.body, { prompt: '  exact\n', ...selection });
  });

  it('refreshes the repository catalog through the local server, never GitHub', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const client = new LovelaceClient('http://localhost:27421', async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET' });
      return Response.json({ ok: true, repoCount: 1, repos: [{ id: 'github:1', topics: ['cose'] }] });
    });
    const result = await client.syncRepositories();
    assert.equal(result.repoCount, 1);
    assert.deepEqual(result.repos[0]!.topics, ['cose']);
    assert.deepEqual(calls, [{ url: 'http://localhost:27421/repos/sync', method: 'POST' }]);
  });

  describe('getDashboard', () => {
    it('returns dashboard data on 200', async () => {
      const mockData = {
        activeWorkItems: [],
        pendingJiraIssues: [],
        recent: { since: '2026-10-06T00:00:00.000Z', workItems: [], sessionCount: 0, completedCount: 0, activityCount: 0 },
        settings: { defaultAgent: 'pi', sidebarSide: 'left', repositoryTopics: [] },
        freshness: { jiraFetchedAt: null, githubFetchedAt: null, jiraStale: false, githubStale: false },
      };
      const client = new LovelaceClient('http://localhost:27421', makeFetch(200, mockData));
      const result = await client.getDashboard();
      assert.deepEqual(result, mockData);
    });

    it('throws ApiError on 500', async () => {
      const client = new LovelaceClient('http://localhost:27421', makeFetch(500, { error: 'internal server error' }));
      await assert.rejects(() => client.getDashboard(), (err) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 500);
        return true;
      });
    });

    it('throws ApiError with status 0 when server is offline', async () => {
      const client = new LovelaceClient('http://localhost:27421', makeFetch(0, null, new Error('ECONNREFUSED')));
      await assert.rejects(() => client.getDashboard(), (err) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 0);
        // Client sanitizes transport errors to avoid leaking URLs/credentials.
        assert.match(err.message, /Cannot reach Lovelace server/);
        return true;
      });
    });
  });

  describe('openSession', () => {
    it('posts to the session open route and returns the action', async () => {
      let captured = { url: '', method: '' };
      const fetchFn: typeof fetch = async (input, init) => {
        captured = { url: input.toString(), method: init?.method ?? 'GET' };
        return new Response(JSON.stringify({ action: 'continued', details: { workItem: {}, metas: [] } }), { status: 200, headers: { 'content-type': 'application/json' } });
      };
      const client = new LovelaceClient('http://localhost:27421', fetchFn);
      assert.equal((await client.openSession('w/1', 'm 1')).action, 'continued');
      assert.deepEqual(captured, { url: 'http://localhost:27421/work-items/w%2F1/sessions/m%201/open', method: 'POST' });
    });
  });

  describe('getWorkItem', () => {
    it('returns work item details on 200', async () => {
      const mockDetails = {
        workItem: { id: 'abc', title: 'Test', state: 'active', notes: null, createdAt: '', updatedAt: '', startedAt: null, completedAt: null },
        metas: [],
      };
      const client = new LovelaceClient('http://localhost:27421', makeFetch(200, mockDetails));
      const result = await client.getWorkItem('abc');
      assert.deepEqual(result, mockDetails);
    });

    it('throws ApiError with status 404 on not found', async () => {
      const client = new LovelaceClient('http://localhost:27421', makeFetch(404, { error: 'work item not found' }));
      await assert.rejects(() => client.getWorkItem('nonexistent'), (err) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 404);
        return true;
      });
    });
  });

  describe('quickStart', () => {
    it('sends prompt in body', async () => {
      let capturedBody: unknown;
      const fetchFn: typeof fetch = async (_input, init) => {
        capturedBody = JSON.parse(init?.body as string);
        const resp = { details: { workItem: {}, metas: [] }, launch: { ok: true, error: null } };
        return new Response(JSON.stringify(resp), { status: 200, headers: { 'content-type': 'application/json' } });
      };
      const client = new LovelaceClient('http://localhost:27421', fetchFn);
      await client.quickStart('Build the feature');
      assert.deepEqual(capturedBody, { prompt: 'Build the feature' });
    });

    it('forwards jiraIssueId, agentId, options and requestId when provided', async () => {
      let capturedBody: unknown;
      const fetchFn: typeof fetch = async (_input, init) => {
        capturedBody = JSON.parse(init?.body as string);
        const resp = { details: { workItem: {}, metas: [] }, launch: { ok: true, error: null } };
        return new Response(JSON.stringify(resp), { status: 200, headers: { 'content-type': 'application/json' } });
      };
      const client = new LovelaceClient('http://localhost:27421', fetchFn);
      await client.quickStart('p', 'JIRA-42', 'claude', { claude: { thinkingLevel: 'high' } }, 'uuid-abc');
      assert.deepEqual(capturedBody, { prompt: 'p', jiraIssueId: 'JIRA-42', agentId: 'claude', options: { claude: { thinkingLevel: 'high' } }, requestId: 'uuid-abc' });
    });

    it('preserves exact prompt whitespace in the body (no trim)', async () => {
      let capturedBody: unknown;
      const fetchFn: typeof fetch = async (_input, init) => {
        capturedBody = JSON.parse(init?.body as string);
        const resp = { details: { workItem: {}, metas: [] }, launch: { ok: true, error: null } };
        return new Response(JSON.stringify(resp), { status: 200, headers: { 'content-type': 'application/json' } });
      };
      const client = new LovelaceClient('http://localhost:27421', fetchFn);
      const exact = '  spaced\n\n  ';
      await client.quickStart(exact);
      assert.deepEqual(capturedBody, { prompt: exact });
    });
  });

  describe('newSession', () => {
    it('forwards prompt, agentId, options and requestId', async () => {
      let capturedUrl = '';
      let capturedBody: unknown;
      const fetchFn: typeof fetch = async (input, init) => {
        capturedUrl = input.toString();
        capturedBody = JSON.parse(init?.body as string);
        const resp = { details: { workItem: {}, metas: [] }, launch: { ok: true, error: null } };
        return new Response(JSON.stringify(resp), { status: 200, headers: { 'content-type': 'application/json' } });
      };
      const client = new LovelaceClient('http://localhost:27421', fetchFn);
      await client.newSession('wi-1', 'go', 'pi', { pi: { model: 'opus' } }, 'uuid-xyz');
      assert.equal(capturedUrl, 'http://localhost:27421/work-items/wi-1/new-session');
      assert.deepEqual(capturedBody, { prompt: 'go', agentId: 'pi', options: { pi: { model: 'opus' } }, requestId: 'uuid-xyz' });
    });
  });

  describe('setWorkItemState', () => {
    it('sends state to /work-items/:id/state', async () => {
      let capturedUrl = '';
      let capturedBody: unknown;
      const fetchFn: typeof fetch = async (input, init) => {
        capturedUrl = input.toString();
        capturedBody = JSON.parse(init?.body as string);
        const wi = { id: 'abc', title: 'T', state: 'done', notes: null, createdAt: '', updatedAt: '', startedAt: null, completedAt: null };
        return new Response(JSON.stringify(wi), { status: 200, headers: { 'content-type': 'application/json' } });
      };
      const client = new LovelaceClient('http://localhost:27421', fetchFn);
      await client.setWorkItemState('abc', 'done');
      assert.equal(capturedUrl, 'http://localhost:27421/work-items/abc/state');
      assert.deepEqual(capturedBody, { state: 'done' });
    });
  });

  describe('error handling', () => {
    it('uses message field from error body', async () => {
      const client = new LovelaceClient('http://localhost:27421', makeFetch(400, { message: 'invalid payload' }));
      await assert.rejects(() => client.quickStart('test'), (err) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.message, 'invalid payload');
        return true;
      });
    });

    it('falls back to statusText when body has no message', async () => {
      const fetchFn: typeof fetch = async () => {
        return new Response('Bad Request', { status: 400, statusText: 'Bad Request' });
      };
      const client = new LovelaceClient('http://localhost:27421', fetchFn);
      await assert.rejects(() => client.quickStart('test'), (err) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 400);
        return true;
      });
    });
  });
});
