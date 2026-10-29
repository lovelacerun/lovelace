import { randomUUID } from 'node:crypto';
import type { AgentSession, Attachment, AttachmentType, LinkAttachmentType, WorkItemAttachment, Worktree } from '@lovelace/core';
import type { NewAttachment, Statement } from './database.js';

type JsonAttachmentType = Exclude<AttachmentType, 'worktree' | 'session'>;
const LINK_TYPES = new Set<AttachmentType>(['tracker-item', 'change-request', 'pull-request'] satisfies LinkAttachmentType[]);

const JSON_COLUMNS = 'id, work_item_id as workItemId, type, provider, external_id as externalId, payload_json as payloadJson, created_at as createdAt, updated_at as updatedAt';
const WORKTREE_COLUMNS = `id, work_item_id as workItemId, created_at as createdAt, updated_at as updatedAt,
  repo_id as repoId, repo_name as repoName, repo_path as repoPath, role, workspace_mode as workspaceMode,
  worktree_path as worktreePath, branch_name as branchName, base_branch as baseBranch, remote_branch as remoteBranch,
  source_external_id as sourceExternalId, install_command as installCommand, installed_at as installedAt,
  dependencies_reused as dependenciesReused, status, preparation_step as preparationStep,
  error_message as errorMessage, cleaned_at as cleanedAt, prepared_at as preparedAt`;
const SESSION_COLUMNS = `id, work_item_id as workItemId, created_at as createdAt, updated_at as updatedAt,
  tool_id as toolId, agent_name as agentName, terminal_workspace_id as terminalWorkspaceId, terminal_pane_id as terminalPaneId,
  native_session_id as nativeSessionId, native_session_path as nativeSessionPath, options_json as optionsJson,
  prompt_id as promptId, prompt, prompt_pending as promptPending, title, cwd, status, agent_state as agentState,
  metadata_json as metadataJson`;

const WORKTREE_VALUES = `repo_id = @repoId, repo_name = @repoName, repo_path = @repoPath, role = @role, workspace_mode = @workspaceMode,
  worktree_path = @worktreePath, branch_name = @branchName, base_branch = @baseBranch, remote_branch = @remoteBranch,
  source_external_id = @sourceExternalId, install_command = @installCommand, installed_at = @installedAt,
  dependencies_reused = @dependenciesReused, status = @status, preparation_step = @preparationStep,
  error_message = @errorMessage, cleaned_at = @cleanedAt, prepared_at = @preparedAt`;
const SESSION_VALUES = `tool_id = @toolId, agent_name = @agentName, terminal_workspace_id = @terminalWorkspaceId,
  terminal_pane_id = @terminalPaneId, native_session_id = @nativeSessionId, native_session_path = @nativeSessionPath,
  options_json = @optionsJson, prompt_id = @promptId, prompt = @prompt, prompt_pending = @promptPending, title = @title,
  cwd = @cwd, status = @status, agent_state = @agentState, metadata_json = @metadataJson`;

/**
 * Typed attachments over three tables: sessions and worktrees in their own
 * columns, everything else as JSON. Payloads are parsed here and nowhere else.
 */
export function attachmentStore(prepare: (sql: string) => Statement) {
  const statements = {
    json: {
      insert: prepare(`insert into work_item_attachments (id, work_item_id, type, provider, external_id, payload_json, created_at, updated_at)
        values (@id, @workItemId, @type, @provider, @externalId, @payloadJson, @createdAt, @updatedAt)`),
      update: prepare('update work_item_attachments set payload_json = @payloadJson, updated_at = @updatedAt where id = @id and type = @type'),
      delete: prepare('delete from work_item_attachments where id = ?'),
    },
    worktree: {
      insert: prepare(`insert into worktrees (id, work_item_id, created_at, updated_at, repo_id, repo_name, repo_path, role, workspace_mode,
        worktree_path, branch_name, base_branch, remote_branch, source_external_id, install_command, installed_at, dependencies_reused,
        status, preparation_step, error_message, cleaned_at, prepared_at)
        values (@id, @workItemId, @createdAt, @updatedAt, @repoId, @repoName, @repoPath, @role, @workspaceMode, @worktreePath, @branchName,
        @baseBranch, @remoteBranch, @sourceExternalId, @installCommand, @installedAt, @dependenciesReused, @status, @preparationStep,
        @errorMessage, @cleanedAt, @preparedAt)`),
      update: prepare(`update worktrees set ${WORKTREE_VALUES}, updated_at = @updatedAt where id = @id`),
      delete: prepare('delete from worktrees where id = ?'),
    },
    session: {
      insert: prepare(`insert into sessions (id, work_item_id, created_at, updated_at, tool_id, agent_name, terminal_workspace_id,
        terminal_pane_id, native_session_id, native_session_path, options_json, prompt_id, prompt, prompt_pending, title, cwd, status,
        agent_state, metadata_json)
        values (@id, @workItemId, @createdAt, @updatedAt, @toolId, @agentName, @terminalWorkspaceId, @terminalPaneId, @nativeSessionId,
        @nativeSessionPath, @optionsJson, @promptId, @prompt, @promptPending, @title, @cwd, @status, @agentState, @metadataJson)`),
      update: prepare(`update sessions set ${SESSION_VALUES}, updated_at = @updatedAt where id = @id`),
      delete: prepare('delete from sessions where id = ?'),
    },
  };

  function select(table: 'work_item_attachments' | 'worktrees' | 'sessions', where: { workItemId?: string; type?: AttachmentType; id?: string }) {
    const columns = table === 'worktrees' ? WORKTREE_COLUMNS : table === 'sessions' ? SESSION_COLUMNS : JSON_COLUMNS;
    const clauses = [
      ...where.workItemId ? ['work_item_id = @workItemId'] : [],
      ...where.id ? ['id = @id'] : [],
      ...where.type && table === 'work_item_attachments' ? ['type = @type'] : [],
    ];
    const sql = `select ${columns} from ${table}${clauses.length ? ` where ${clauses.join(' and ')}` : ''} order by created_at asc, rowid asc`;
    const rows = prepare(sql).all(where) as Array<Record<string, unknown>>;
    return rows.map(table === 'worktrees' ? fromWorktreeRow : table === 'sessions' ? fromSessionRow : fromJsonRow);
  }

  function list(workItemId?: string, type?: AttachmentType): WorkItemAttachment[] {
    if (type === 'worktree') return select('worktrees', { workItemId });
    if (type === 'session') return select('sessions', { workItemId });
    if (type) return select('work_item_attachments', { workItemId, type });
    return [...select('work_item_attachments', { workItemId }), ...select('worktrees', { workItemId }), ...select('sessions', { workItemId })]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  return {
    list: list as {
      (workItemId?: string): WorkItemAttachment[];
      <Type extends AttachmentType>(workItemId: string | undefined, type: Type): Array<Attachment<Type>>;
    },
    get<Type extends AttachmentType>(type: Type, id: string): Attachment<Type> | null {
      const table = type === 'worktree' ? 'worktrees' : type === 'session' ? 'sessions' : 'work_item_attachments';
      return (select(table, { id, type })[0] as Attachment<Type> | undefined) ?? null;
    },
    insert(input: NewAttachment): WorkItemAttachment {
      const now = new Date().toISOString();
      const attachment = { ...input, id: randomUUID(), createdAt: now, updatedAt: now } as WorkItemAttachment;
      statements[storage(attachment.type)].insert.run(toRow(attachment));
      return attachment;
    },
    update<Type extends AttachmentType>(type: Type, id: string, payload: Attachment<Type>['payload']): void {
      const row = toRow({ id, type, payload, updatedAt: new Date().toISOString() } as WorkItemAttachment);
      statements[storage(type)].update.run(row);
    },
    deleteLink(workItemId: string, type: LinkAttachmentType, provider: string, externalId: string): void {
      prepare('delete from work_item_attachments where work_item_id = ? and type = ? and provider = ? and external_id = ?')
        .run(workItemId, type, provider, externalId);
    },
    delete(type: AttachmentType, id: string): void {
      statements[storage(type)].delete.run(id);
    },
  };
}

function storage(type: AttachmentType): 'json' | 'worktree' | 'session' {
  return type === 'worktree' || type === 'session' ? type : 'json';
}

function toRow(attachment: WorkItemAttachment): Record<string, unknown> {
  const base = { id: attachment.id, workItemId: attachment.workItemId, createdAt: attachment.createdAt, updatedAt: attachment.updatedAt };
  if (attachment.type === 'worktree') {
    const worktree = attachment.payload;
    return {
      ...base, ...worktree,
      dependenciesReused: worktree.dependenciesReused ? 1 : 0,
      preparationStep: worktree.preparationStep ?? null,
      errorMessage: worktree.errorMessage ?? null,
    };
  }
  if (attachment.type === 'session') {
    const { terminalRef, options, promptPending, metadata, ...session } = attachment.payload;
    return {
      ...base, ...session,
      terminalWorkspaceId: terminalRef?.workspaceId ?? null,
      terminalPaneId: terminalRef?.paneId ?? null,
      optionsJson: options ? JSON.stringify(options) : null,
      promptId: session.promptId ?? null,
      prompt: session.prompt ?? null,
      promptPending: promptPending ? 1 : 0,
      metadataJson: metadata === undefined || metadata === null ? null : JSON.stringify(metadata),
    };
  }
  return {
    ...base,
    type: attachment.type,
    provider: LINK_TYPES.has(attachment.type) && 'provider' in attachment ? attachment.provider : null,
    externalId: LINK_TYPES.has(attachment.type) && 'externalId' in attachment ? attachment.externalId : null,
    payloadJson: JSON.stringify(attachment.payload),
  };
}

function fromJsonRow(row: Record<string, unknown>): WorkItemAttachment {
  const { payloadJson, provider, externalId, ...base } = row as {
    id: string; workItemId: string; type: JsonAttachmentType; provider: string | null; externalId: string | null;
    payloadJson: string; createdAt: string; updatedAt: string;
  };
  const payload: unknown = JSON.parse(payloadJson);
  return (LINK_TYPES.has(base.type) ? { ...base, provider, externalId, payload } : { ...base, payload }) as WorkItemAttachment;
}

function fromWorktreeRow(row: Record<string, unknown>): Attachment<'worktree'> {
  const { id, workItemId, createdAt, updatedAt, dependenciesReused, preparationStep, errorMessage, ...worktree } = row as Record<string, unknown>
    & Pick<Attachment<'worktree'>, 'id' | 'workItemId' | 'createdAt' | 'updatedAt'> & { dependenciesReused: number; preparationStep: string | null; errorMessage: string | null };
  const payload = {
    ...worktree as Omit<Worktree, 'dependenciesReused' | 'preparationStep' | 'errorMessage'>,
    dependenciesReused: Boolean(dependenciesReused),
    errorMessage,
    ...preparationStep === null ? {} : { preparationStep },
  };
  return { id, workItemId, type: 'worktree', payload, createdAt, updatedAt };
}

function fromSessionRow(row: Record<string, unknown>): Attachment<'session'> {
  const { id, workItemId, createdAt, updatedAt, terminalWorkspaceId, terminalPaneId, optionsJson, promptPending, metadataJson, ...session } = row as Record<string, unknown>
    & Pick<Attachment<'session'>, 'id' | 'workItemId' | 'createdAt' | 'updatedAt'>
    & { terminalWorkspaceId: string | null; terminalPaneId: string | null; optionsJson: string | null; promptPending: number; metadataJson: string | null };
  const payload: AgentSession = {
    ...session as Omit<AgentSession, 'terminalRef' | 'options' | 'promptPending' | 'metadata'>,
    terminalRef: terminalWorkspaceId && terminalPaneId ? { workspaceId: terminalWorkspaceId, paneId: terminalPaneId } : null,
    ...optionsJson ? { options: JSON.parse(optionsJson) as AgentSession['options'] } : {},
    promptPending: Boolean(promptPending),
    metadata: metadataJson ? JSON.parse(metadataJson) as unknown : null,
  };
  return { id, workItemId, type: 'session', payload, createdAt, updatedAt };
}
