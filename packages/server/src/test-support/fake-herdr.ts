import { randomUUID } from 'node:crypto';
import { HerdrError, type HerdrClient, type HerdrPane, type HerdrWorkspace } from '../herdr/herdr-client.js';

/** In-memory Herdr session for fixture tests; never talks to a real host. */
export class FakeHerdr implements HerdrClient {
  readonly workspaces = new Map<string, HerdrWorkspace>();
  readonly panes = new Map<string, HerdrPane & { cwd: string; label: string }>();
  readonly calls: Array<{ method: string; args: unknown }> = [];
  readonly prompts: Array<{ name: string; text: string }> = [];
  /** Throws from startAgent when set. */
  failStart: Error | null = null;
  /** Agents open blocked on a startup dialog (Herdr reports `agent_not_ready`). */
  startBlocked = false;
  /** Starts refused as `agent_pane_busy` before a new shell is ready. */
  busyStarts = 0;
  /** Whether the harness integration reports its native conversation. */
  reportSessions = true;
  private names = new Map<string, string>();
  private next = 1;

  async getWorkspace(workspaceId: string) {
    this.calls.push({ method: 'getWorkspace', args: workspaceId });
    const workspace = this.workspaces.get(workspaceId);
    return workspace ? { ...workspace, tokens: { ...workspace.tokens } } : null;
  }
  async createWorkspace(input: { cwd: string; label: string }) {
    this.calls.push({ method: 'createWorkspace', args: input });
    const workspaceId = `w${this.next++}`;
    this.workspaces.set(workspaceId, { workspaceId, tokens: {} });
    return { workspaceId, ...this.addPane(workspaceId, input.cwd, '1') };
  }
  async reportWorkspaceTokens(workspaceId: string, tokens: Record<string, string>) {
    this.calls.push({ method: 'reportWorkspaceTokens', args: { workspaceId, tokens } });
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new HerdrError('workspace_not_found', 'missing workspace');
    Object.assign(workspace.tokens, tokens);
  }
  async createTab(input: { workspaceId: string; cwd: string; label: string }) {
    this.calls.push({ method: 'createTab', args: input });
    if (!this.workspaces.has(input.workspaceId)) throw new HerdrError('workspace_not_found', 'missing workspace');
    return this.addPane(input.workspaceId, input.cwd, input.label);
  }
  async listPanes() {
    return [...this.panes.values()].map(pane => ({ ...pane }));
  }
  async startAgent(input: { name: string; kind: string; paneId: string; args: string[] }) {
    this.calls.push({ method: 'startAgent', args: input });
    if (this.failStart) throw this.failStart;
    if (this.busyStarts > 0) { this.busyStarts--; throw new HerdrError('agent_pane_busy', 'pane is not an available shell'); }
    const pane = this.panes.get(input.paneId);
    if (!pane) throw new HerdrError('pane_not_found', 'missing pane');
    if (pane.agent) throw new HerdrError('pane_not_available', 'pane is not at a shell prompt');
    const sessionFlag = input.args.indexOf('--session-id');
    const value = input.kind === 'pi' ? `/fixture/pi/${randomUUID()}.jsonl` : sessionFlag >= 0 ? input.args[sessionFlag + 1]! : randomUUID();
    Object.assign(pane, { agent: input.kind, agentStatus: this.startBlocked ? 'blocked' : 'idle', agentSession: this.reportSessions ? { kind: input.kind === 'pi' ? 'path' : 'id', value } : null });
    this.names.set(input.name, pane.paneId);
    if (this.startBlocked) throw new HerdrError('agent_not_ready', 'agent is blocked during startup');
  }
  async promptAgent(name: string, text: string) {
    this.prompts.push({ name, text });
    const pane = this.panes.get(this.names.get(name) ?? '');
    if (!pane?.agent) throw new HerdrError('agent_not_found', 'missing agent');
    if (pane.agentStatus === 'blocked') throw new HerdrError('agent_blocked', 'agent is blocked');
    pane.agentStatus = 'working';
  }
  async focusTab(tabId: string) {
    this.calls.push({ method: 'focusTab', args: tabId });
  }

  /** The agent exits; its shell stays in the pane. */
  exitAgent(paneId: string) {
    const pane = this.panes.get(paneId)!;
    Object.assign(pane, { agent: null, agentStatus: 'unknown', agentSession: null });
  }
  closePane(paneId: string) {
    this.panes.delete(paneId);
  }
  /** Herdr restarts: workspaces survive, display tokens do not. */
  restart() {
    for (const workspace of this.workspaces.values()) workspace.tokens = {};
  }

  private addPane(workspaceId: string, cwd: string, label: string) {
    const tabId = `${workspaceId}:t${this.next++}`;
    const paneId = `${workspaceId}:p${this.next++}`;
    this.panes.set(paneId, { paneId, tabId, workspaceId, cwd, label, agent: null, agentStatus: 'unknown', agentSession: null });
    return { tabId, paneId };
  }
}
