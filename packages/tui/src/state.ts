import type {
  AvailableHarness, CodingHarnessId, DashboardJiraIssue, ToolLaunchOptions, DashboardResponse, JiraIssueSummary, LaunchSelection, PromptTemplate, RepoRecord,
  ToolLaunchOptionsById,
  SidebarSide, WorkItemDetails, WorkItemState, WorkItemSummary,
} from '@lovelace/core';

type AppView = 'dashboard' | 'work-item' | 'jira';
/** Home's agent, thinking and model fields below the quick-start editor, in Tab order. */
export const LAUNCH_FOCUS = ['launch-agent', 'launch-thinking', 'launch-model'] as const;
export type LaunchFocus = (typeof LAUNCH_FOCUS)[number];
export type FocusTarget = 'content' | 'sidebar' | 'editor' | LaunchFocus;

export function isLaunchFocus(focus: FocusTarget): focus is LaunchFocus {
  return (LAUNCH_FOCUS as readonly string[]).includes(focus);
}

export interface NavigationEntry { kind: 'home' | 'work' | 'jira'; id: string }
type SidebarEntry = NavigationEntry & { label: string };

/**
 * Snapshot of the last launch attempt whose outcome is unresolved
 * (uncertain / pending). Used to replay the exact same request body + endpoint
 * on an explicit retry, even across navigation. See docs/v4-api.md:
 * reusing a UUID with a different body / endpoint
 * returns 409, so we pin the whole tuple.
 */
export interface PendingLaunch extends LaunchSelection {
  endpoint: 'quickStart' | 'newSession';
  workItemId?: string;
  jiraIssueId?: string;
  prompt: string;
  requestId: string;
  agentId?: CodingHarnessId;
  toolOptions?: ToolLaunchOptionsById;
}

interface Draft extends LaunchSelection {
  text: string;
  agentId?: CodingHarnessId;
  toolOptions?: ToolLaunchOptionsById;
  retryWorkId?: string;
  uncertain?: boolean;
  /**
   * Pinned endpoint, body and stable client-generated request UUID while the
   * launch outcome is unresolved, so a lost HTTP reply can be safely replayed
   * without duplicating work items or agent starts. Cleared on confirmed
   * success, confirmed failure or explicit abandonment; navigation and editing
   * retain it.
   */
  pendingLaunch?: PendingLaunch;
}

export type PendingConfirm =
  | { kind: 'state'; state: WorkItemState }
  | { kind: 'launch-abandon'; draftKey: string };

interface AppStateOptions {
  onInvalidate: () => void;
  /** CLI --sidebar override; takes priority over server-provided setting. */
  sidebarSide?: SidebarSide;
}

function clampSelection(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(index, count - 1));
}

/**
 * Pure application state. Views are rendered from this snapshot and
 * controllers mutate it through narrow methods. No I/O, no timers.
 */
export class AppState {
  view: AppView = 'dashboard';
  focus: FocusTarget = 'content';

  dashboardData: DashboardResponse | null = null;
  selectedWorkItemId: string | null = null;
  selectedWorkItemData: WorkItemDetails | null = null;
  selectedJira: DashboardJiraIssue | null = null;
  jiraDetails: JiraIssueSummary | null = null;

  repositories: RepoRecord[] | null = null;
  promptTemplates: PromptTemplate[] | null = null;
  /** Harnesses detected on the server; null until first loaded. */
  tools: AvailableHarness[] | null = null;
  /**
   * The harness and per-harness overrides new launches use. Kept for the TUI
   * session; a fresh TUI starts from the server's default agent.
   */
  launchChoice: { agentId?: CodingHarnessId; options: ToolLaunchOptionsById } = { options: {} };

  sidebarSelectedIndex = 0;
  contentSelectedIndex = 0;

  error: string | null = null;
  notice: string | null = null;
  /** For state-change shortcuts and intent discards needing y-to-confirm. */
  pendingConfirm: PendingConfirm | null = null;

  mutationInFlight = false;
  isLoading = true;
  offline = false;

  sidebarSide: SidebarSide = 'right';
  /**
   * Layout of the last frame. Without the sidebar, Home lists active work and
   * Tab skips the sidebar; compact views use one row per entry.
   */
  layout = { sidebar: true, compact: false };

  readonly drafts = new Map<string, Draft>();
  /** Per-view scroll offset. Keyed by `draftKey`. */
  readonly scrollOffsets: Record<string, number> = {};

  private readonly cliSidebarSide?: SidebarSide;

  constructor(private readonly options: AppStateOptions) {
    this.cliSidebarSide = options.sidebarSide;
    if (options.sidebarSide) this.sidebarSide = options.sidebarSide;
  }

  changed(): void {
    this.options.onInvalidate();
  }

  // Derived collections ------------------------------------------------------

  get activeWorkItems(): WorkItemSummary[] {
    return this.dashboardData?.activeWorkItems ?? [];
  }

  get pendingJiraIssues(): DashboardJiraIssue[] {
    return this.dashboardData?.pendingJiraIssues ?? [];
  }

  /** Home, then active work, then pending Jira. Non-active local work is deliberately hidden. */
  get sidebarEntries(): SidebarEntry[] {
    return [
      { kind: 'home', id: 'home', label: 'Home' },
      ...this.activeWorkItems.map(item => ({ kind: 'work' as const, id: item.id, label: item.title })),
      ...this.pendingJiraIssues.map(issue => ({ kind: 'jira' as const, id: issue.id, label: `${issue.key} ${issue.title}` })),
    ];
  }

  get draftKey(): string {
    if (this.view === 'work-item') return `work:${this.selectedWorkItemId ?? ''}`;
    if (this.view === 'jira') return `jira:${this.selectedJira?.id ?? ''}`;
    return 'home';
  }

  get draft(): Draft {
    let draft = this.drafts.get(this.draftKey);
    if (!draft) {
      draft = { text: '' };
      this.drafts.set(this.draftKey, draft);
    }
    return draft;
  }

  setDraft(patch: Partial<Draft>): void {
    this.setDraftForKey(this.draftKey, patch);
  }

  setDraftForKey(key: string, patch: Partial<Draft>): void {
    const current = this.drafts.get(key) ?? { text: '' };
    this.drafts.set(key, { ...current, ...patch });
    this.changed();
  }

  getScrollOffset(): number {
    return this.scrollOffsets[this.draftKey] ?? 0;
  }

  setScrollOffset(value: number): void {
    this.scrollOffsets[this.draftKey] = Math.max(0, value);
  }

  // Launch choice -------------------------------------------------------------

  /** The chosen harness, else the configured default when detected, else the first detected one. */
  get launchAgent(): CodingHarnessId | undefined {
    if (this.launchChoice.agentId) return this.launchChoice.agentId;
    const preferred = this.dashboardData?.settings.defaultAgent;
    if (!this.tools) return preferred;
    return this.tools.find(tool => tool.id === preferred)?.id ?? this.tools[0]?.id ?? preferred;
  }

  /** The chosen harness's overrides, or undefined when it keeps its own defaults. */
  get launchToolOptions(): ToolLaunchOptionsById | undefined {
    const agent = this.launchAgent;
    const options = agent ? this.launchChoice.options[agent] : undefined;
    return agent && (options?.model || options?.thinkingLevel) ? { [agent]: options } : undefined;
  }

  setTools(tools: AvailableHarness[]): void {
    this.tools = tools;
    this.changed();
  }

  setLaunchAgent(agentId: CodingHarnessId): void {
    this.launchChoice = { ...this.launchChoice, agentId };
    this.changed();
  }

  /** Merges into the current harness's overrides; undefined clears a field. */
  setLaunchOverrides(patch: ToolLaunchOptions): void {
    const agent = this.launchAgent;
    if (!agent) return;
    const merged = { ...this.launchChoice.options[agent], ...patch };
    const next: ToolLaunchOptions = {
      ...(merged.model ? { model: merged.model } : {}), ...(merged.thinkingLevel ? { thinkingLevel: merged.thinkingLevel } : {}),
    };
    this.launchChoice = { agentId: agent, options: { ...this.launchChoice.options, [agent]: next } };
    this.changed();
  }

  // Status --------------------------------------------------------------------

  setError(message: string | null): void {
    this.error = message;
    this.changed();
  }

  setNotice(message: string | null): void {
    this.notice = message;
    this.changed();
  }

  setFocus(target: FocusTarget): void {
    const homeOnly = target === 'editor' || isLaunchFocus(target);
    this.focus = homeOnly && this.view !== 'dashboard' ? 'content' : target;
    this.changed();
  }

  setOffline(): void {
    this.offline = true;
    this.changed();
  }

  // Dashboard application ----------------------------------------------------

  applyDashboardResponse(data: DashboardResponse): void {
    const previouslySelected = this.sidebarEntries[this.sidebarSelectedIndex];

    this.dashboardData = data;
    this.sidebarSide = this.cliSidebarSide ?? data.settings.sidebarSide;

    if (previouslySelected) {
      const index = this.sidebarEntries.findIndex(
        (entry) => entry.kind === previouslySelected.kind && entry.id === previouslySelected.id,
      );
      if (index >= 0) this.sidebarSelectedIndex = index;
    }
    this.sidebarSelectedIndex = clampSelection(this.sidebarSelectedIndex, this.sidebarEntries.length);
    this.isLoading = false;
    this.offline = false;
    this.changed();
  }

  setWorkItemData(details: WorkItemDetails): void {
    this.selectedWorkItemData = details;
    this.changed();
  }

  setJiraDetails(details: JiraIssueSummary | null): void {
    this.jiraDetails = details;
    this.changed();
  }

  // Navigation ---------------------------------------------------------------

  navigate(entry: NavigationEntry): void {
    if (entry.kind === 'home') {
      this.view = 'dashboard';
      this.selectedWorkItemId = null;
      this.selectedWorkItemData = null;
      this.selectedJira = null;
      this.jiraDetails = null;
    } else if (entry.kind === 'work') {
      this.view = 'work-item';
      this.selectedWorkItemId = entry.id;
      this.selectedWorkItemData = null;
      this.selectedJira = null;
      this.jiraDetails = null;
    } else {
      this.view = 'jira';
      this.selectedJira = this.pendingJiraIssues.find((issue) => issue.id === entry.id) ?? null;
      this.jiraDetails = null;
      this.selectedWorkItemId = null;
      this.selectedWorkItemData = null;
    }
    // The sidebar marks where the operator is, however they got there.
    const index = this.sidebarEntries.findIndex(item => item.kind === entry.kind && item.id === entry.id);
    if (index >= 0) this.sidebarSelectedIndex = index;
    this.contentSelectedIndex = 0;
    this.focus = 'content';
    this.error = null;
    this.notice = null;
    this.pendingConfirm = null;
    this.changed();
  }

  navigateToDashboard(): void {
    this.navigate({ kind: 'home', id: 'home' });
  }

  navigateToWorkItem(id: string): void {
    this.navigate({ kind: 'work', id });
  }

  // Movement -----------------------------------------------------------------

  move(delta: number, contentCount: number): void {
    if (this.focus === 'sidebar') {
      this.sidebarSelectedIndex = clampSelection(
        this.sidebarSelectedIndex + delta,
        this.sidebarEntries.length,
      );
    } else if (this.focus === 'content') {
      this.contentSelectedIndex = clampSelection(this.contentSelectedIndex + delta, contentCount);
    }
    // Any selection shift cancels an in-flight confirm.
    if (this.pendingConfirm !== null) {
      this.pendingConfirm = null;
      this.notice = null;
    }
    this.changed();
  }

  toggleFocus(contentCount = 0, direction: 1 | -1 = 1): void {
    // Home retains group navigation; detail pages tab through every selectable item.
    if (this.view !== 'dashboard' && this.focus === 'content' && contentCount > 0) {
      const current = clampSelection(this.contentSelectedIndex, contentCount);
      const next = current + direction;
      if (next >= 0 && next < contentCount) {
        this.contentSelectedIndex = next;
        this.move(0, contentCount);
        return;
      }
    }
    const order: FocusTarget[] = this.view === 'dashboard' ? ['content', 'sidebar', 'editor', ...LAUNCH_FOCUS] : ['content', 'sidebar'];
    if (!this.layout.sidebar) order.splice(1, 1);
    this.focus = order[(order.indexOf(this.focus) + direction + order.length) % order.length]!;
    if (this.view !== 'dashboard' && this.focus === 'content') {
      this.contentSelectedIndex = direction === 1 ? 0 : Math.max(0, contentCount - 1);
    }
    this.move(0, contentCount);
  }
}
