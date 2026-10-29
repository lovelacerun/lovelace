import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TRPCClientError } from '@trpc/client';
import { createLovelaceClient, errorStatus, isAborted, isTimeout, isUnreachable } from './client.js';
import { fakeClient, serverError } from './testing.js';

const SERVER = 'http://localhost:27421';

interface Call { path: string; method: string; input: unknown }

/** Records each procedure call and answers with tRPC's success envelope. */
function recording(respond: (call: Call) => unknown = () => null) {
  const calls: Call[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    // Queries carry their input in the URL, mutations in the body.
    const raw = init?.body ?? url.searchParams.get('input');
    const call = { path: url.pathname.replace(/^\/trpc\//, ''), method: init?.method ?? 'GET', input: raw ? JSON.parse(String(raw)) : undefined };
    calls.push(call);
    return Response.json({ result: { data: respond(call) } });
  };
  return { calls, client: createLovelaceClient(SERVER, fetchFn) };
}

/** A server rejection as tRPC's HTTP handler sends it. */
function rejecting(httpStatus: number, message: string): typeof fetch {
  return async () => Response.json({ error: { message, code: -32603, data: { code: 'BAD_REQUEST', httpStatus } } }, { status: httpStatus });
}

describe('createLovelaceClient', () => {
  it('accepts only HTTP loopback URLs without credentials, query or path', () => {
    for (const url of ['http://localhost:27421', 'http://127.0.0.1:27421/', 'http://[::1]:27421']) {
      assert.doesNotThrow(() => createLovelaceClient(url, rejecting(500, 'unused')));
    }
    for (const url of ['https://localhost:27421', 'http://example.com', 'http://user:pw@localhost:27421', 'http://localhost:27421/api', 'http://localhost:27421/?x=1', 'http://localhost:27421/#x']) {
      assert.throws(() => createLovelaceClient(url), /loopback/);
    }
  });

  it('sends queries as GET and mutations as POST to their procedure path with the exact input', async () => {
    const { calls, client } = recording(() => []);
    await client.repositories.list.query();
    await client.prompts.list.query();
    const selection = { repoIds: ['github:2', 'github:1'], promptId: 'refine' };
    await client.launches.quickStart.mutate({ prompt: '  exact\n', trackerIssueId: '42', ...selection });
    await client.launches.newSession.mutate({ workItemId: 'w/1', prompt: '  exact\n', ...selection });
    await client.workItems.setState.mutate({ id: 'abc', state: 'done' });
    assert.deepEqual(calls, [
      { path: 'repositories.list', method: 'GET', input: undefined },
      { path: 'prompts.list', method: 'GET', input: undefined },
      { path: 'launches.quickStart', method: 'POST', input: { prompt: '  exact\n', trackerIssueId: '42', ...selection } },
      { path: 'launches.newSession', method: 'POST', input: { workItemId: 'w/1', prompt: '  exact\n', ...selection } },
      { path: 'workItems.setState', method: 'POST', input: { id: 'abc', state: 'done' } },
    ]);
  });

  it('refreshes the repository catalog through the local server, never GitHub', async () => {
    const { calls, client } = recording(() => ({ ok: true, repoCount: 1, repos: [{ id: 'github:1', topics: ['cose'] }] }));
    const result = await client.repositories.sync.mutate();
    assert.equal(result.repoCount, 1);
    assert.deepEqual(result.repos[0]!.topics, ['cose']);
    assert.deepEqual(calls.map(call => call.path), ['repositories.sync']);
  });

  it('returns procedure output unchanged', async () => {
    const dashboard = {
      activeWorkItems: [],
      pendingJiraIssues: [],
      recent: { since: '2026-10-06T00:00:00.000Z', workItems: [], sessionCount: 0, completedCount: 0, activityCount: 0 },
      settings: { defaultAgent: 'pi', sidebarSide: 'left', repositoryTopics: [] },
      freshness: { jiraFetchedAt: null, githubFetchedAt: null, jiraStale: false, githubStale: false },
    };
    const { client } = recording(() => dashboard);
    assert.deepEqual(await client.dashboard.get.query(), dashboard);
  });

  it('opens a session by work item and session ID', async () => {
    const { calls, client } = recording(() => ({ action: 'continued', details: { workItem: {}, attachments: [] } }));
    assert.equal((await client.sessions.open.mutate({ workItemId: 'w/1', sessionId: 'm 1' })).action, 'continued');
    assert.deepEqual(calls, [{ path: 'sessions.open', method: 'POST', input: { workItemId: 'w/1', sessionId: 'm 1' } }]);
  });

  it('forwards launch selections, agent, options and request ID verbatim, whitespace included', async () => {
    const { calls, client } = recording(() => ({ details: { workItem: {}, attachments: [] }, launch: { state: 'running' } }));
    const exact = '  spaced\n\n  ';
    await client.launches.quickStart.mutate({ prompt: exact });
    await client.launches.quickStart.mutate({ prompt: 'p', trackerIssueId: 'JIRA-42', agentId: 'claude', options: { claude: { thinkingLevel: 'high' } }, requestId: 'uuid-abc' });
    await client.launches.newSession.mutate({ workItemId: 'wi-1', prompt: 'go', agentId: 'pi', options: { pi: { model: 'opus' } }, requestId: 'uuid-xyz' });
    assert.deepEqual(calls.map(call => call.input), [
      { prompt: exact },
      { prompt: 'p', trackerIssueId: 'JIRA-42', agentId: 'claude', options: { claude: { thinkingLevel: 'high' } }, requestId: 'uuid-abc' },
      { workItemId: 'wi-1', prompt: 'go', agentId: 'pi', options: { pi: { model: 'opus' } }, requestId: 'uuid-xyz' },
    ]);
  });

  describe('errors', () => {
    for (const status of [400, 404, 500]) {
      it(`keeps the server's message and HTTP ${status}`, async () => {
        const client = createLovelaceClient(SERVER, rejecting(status, 'invalid payload'));
        await assert.rejects(client.workItems.get.query({ id: 'nonexistent' }), error => {
          assert.ok(error instanceof TRPCClientError);
          assert.equal(error.message, 'invalid payload');
          assert.equal(errorStatus(error), status);
          assert.equal(isUnreachable(error), false);
          return true;
        });
      });
    }

    it('reports an offline server as unreachable without leaking transport details', async () => {
      const client = createLovelaceClient(SERVER, async () => { throw new Error('ECONNREFUSED http://localhost:27421/secret'); });
      await assert.rejects(client.dashboard.get.query(), error => {
        assert.ok(error instanceof TRPCClientError);
        assert.equal(errorStatus(error), 0);
        assert.equal(isUnreachable(error), true);
        assert.match(error.message, /Cannot reach Lovelace server/);
        assert.doesNotMatch(error.message, /secret/);
        return true;
      });
    });

    it('treats a reply that is not a tRPC envelope as unreadable', async () => {
      const client = createLovelaceClient(SERVER, async () => new Response('Bad Request', { status: 400, statusText: 'Bad Request' }));
      await assert.rejects(client.launches.quickStart.mutate({ prompt: 'test' }), error => {
        assert.equal(errorStatus(error), 0);
        assert.equal(isUnreachable(error), true);
        assert.equal(isAborted(error) || isTimeout(error), false);
        return true;
      });
    });
  });
});

describe('fakeClient', () => {
  it('calls the typed handler with the input', async () => {
    const inputs: unknown[] = [];
    const client = fakeClient({
      'workItems.setState': input => { inputs.push(input); return { id: input.id, state: input.state } as never; },
    });
    assert.deepEqual(await client.workItems.setState.mutate({ id: 'abc', state: 'done' }), { id: 'abc', state: 'done' });
    assert.deepEqual(inputs, [{ id: 'abc', state: 'done' }]);
  });

  it('reports serverError status and treats other errors as unreachable', async () => {
    const client = fakeClient({
      'workItems.get': () => { throw serverError(404, 'work item not found'); },
      'dashboard.get': () => { throw new Error('offline'); },
    });
    await assert.rejects(client.workItems.get.query({ id: 'x' }), error => {
      assert.equal(errorStatus(error), 404);
      assert.equal((error as Error).message, 'work item not found');
      assert.equal(isUnreachable(error), false);
      return true;
    });
    await assert.rejects(client.dashboard.get.query(), error => isUnreachable(error) && errorStatus(error) === 0);
    await assert.rejects(client.prompts.list.query(), /No fake for prompts.list/);
  });
});
