import assert from 'node:assert/strict';
import test from 'node:test';
import { createHerdrClient, herdrEnvironment, HerdrError, type HerdrExec } from './herdr-client.js';

function fakeExec(replies: Array<{ exitCode?: number; stdout?: string; stderr?: string }>) {
  const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const exec: HerdrExec = async (file, args, options) => {
    calls.push({ file, args, env: options.env });
    const reply = replies.shift() ?? {};
    return { exitCode: reply.exitCode ?? 0, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' };
  };
  return { exec, calls };
}

test('parses panes with agent state and the reported native conversation', async () => {
  const { exec, calls } = fakeExec([{ stdout: JSON.stringify({ result: { panes: [
    { pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', agent: 'claude', agent_status: 'working', agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: 'abc' } },
    { pane_id: 'w1:p2', tab_id: 'w1:t2', workspace_id: 'w1', agent_status: 'sleeping' },
  ] } }) }]);
  const herdr = createHerdrClient({ executable: '/fixture/herdr' }, exec);
  assert.deepEqual(await herdr.listPanes(), [
    { paneId: 'w1:p1', tabId: 'w1:t1', workspaceId: 'w1', agent: 'claude', agentStatus: 'working', agentSession: { kind: 'id', value: 'abc' } },
    { paneId: 'w1:p2', tabId: 'w1:t2', workspaceId: 'w1', agent: null, agentStatus: 'unknown', agentSession: null },
  ]);
  assert.deepEqual(calls[0]!.args, ['pane', 'list']);
  assert.equal(calls[0]!.file, '/fixture/herdr');
});

test('maps Herdr errors, treats a missing workspace as absent and accepts empty acknowledgements', async () => {
  const { exec, calls } = fakeExec([
    { exitCode: 1, stderr: JSON.stringify({ error: { code: 'workspace_not_found', message: 'workspace w9 not found' } }) },
    { exitCode: 1, stderr: JSON.stringify({ error: { code: 'pane_not_available', message: 'pane is busy' } }) },
    { stdout: '' },
  ]);
  const herdr = createHerdrClient({ executable: '/fixture/herdr' }, exec);
  assert.equal(await herdr.getWorkspace('w9'), null);
  await assert.rejects(herdr.startAgent({ name: 'll-1', kind: 'codex', paneId: 'w1:p1', args: ['resume', 'x'] }),
    (error: unknown) => error instanceof HerdrError && error.code === 'pane_not_available' && /pane is busy/.test(error.message));
  await herdr.promptAgent('ll-1', 'multi\nline prompt');
  assert.deepEqual(calls[1]!.args, ['agent', 'start', 'll-1', '--kind', 'codex', '--pane', 'w1:p1', '--timeout', '30000', '--', 'resume', 'x']);
  assert.deepEqual(calls[2]!.args, ['agent', 'prompt', 'll-1', 'multi\nline prompt']);
});

test('creates unfocused workspaces/tabs and reports workspace tokens', async () => {
  const { exec, calls } = fakeExec([
    { stdout: JSON.stringify({ result: { workspace: { workspace_id: 'w3' }, root_pane: { pane_id: 'w3:p1', tab_id: 'w3:t1' } } }) },
    { stdout: JSON.stringify({ result: { root_pane: { pane_id: 'w3:p2', tab_id: 'w3:t2' } } }) },
    { stdout: JSON.stringify({ result: {} }) },
  ]);
  const herdr = createHerdrClient({ executable: '/fixture/herdr' }, exec);
  assert.deepEqual(await herdr.createWorkspace({ cwd: '/work', label: 'PROJ-1' }), { workspaceId: 'w3', tabId: 'w3:t1', paneId: 'w3:p1' });
  assert.deepEqual(await herdr.createTab({ workspaceId: 'w3', cwd: '/work/repo', label: 'Codex' }), { tabId: 'w3:t2', paneId: 'w3:p2' });
  await herdr.reportWorkspaceTokens('w3', { lovelace: 'item' });
  assert.deepEqual(calls.map(call => call.args), [
    ['workspace', 'create', '--cwd', '/work', '--label', 'PROJ-1', '--no-focus'],
    ['tab', 'create', '--workspace', 'w3', '--cwd', '/work/repo', '--label', 'Codex', '--no-focus'],
    ['workspace', 'report-metadata', 'w3', '--source', 'lovelace', '--token', 'lovelace=item'],
  ]);
});

test('never inherits the caller pane context; an explicit socket selects another session', () => {
  const env = herdrEnvironment({ PATH: '/bin', HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', HERDR_TAB_ID: 'w1:t1', HERDR_WORKSPACE_ID: 'w1', HERDR_SOCKET_PATH: '/caller.sock' }, {});
  for (const key of ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'HERDR_SOCKET_PATH']) assert.equal(env[key], undefined);
  assert.equal(herdrEnvironment({}, { socketPath: '/probe.sock' }).HERDR_SOCKET_PATH, '/probe.sock');
});
