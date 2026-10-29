import type { Component, Editor, TuiAltScreen, TuiMouseEvent, TuiMouseEventResult } from '@earendil-works/pi-tui';
import { Input, isKeyRelease, matchesKey, stripTerminalSequences } from '@earendil-works/pi-tui';
import type { LovelaceClient } from '@lovelace/client';
import type { DashboardIssue, TrackerIssue, PromptTemplate, Repository } from '@lovelace/core';
import type { AppState } from './state.js';
import { filterRepositories } from './jira-start.js';
import {
  Dropdown, fitEditorLines, linkCell, padRight, PasteTracker, replaceEditorText, safeText, SplitPane, truncate, wrap,
} from '@lovelace/tui-components';
import { bold, accent, canvas, cardBg, muted, icons, danger, reset, selectedBand, selectedBg, splitPaneTheme } from './theme.js';
import { clickable, type ClickTarget } from './clickable.js';
import { dialogEditor } from './dialog-editor.js';
import { LAUNCH_FIELDS, LaunchOptionsRow, selectTheme, type LaunchField } from './launch-options.js';

const control = (text: string, data: string) => clickable(text, { kind: 'modal', data });
const button = (label: string, selected: boolean, data: string) =>
  control((selected ? selectedBg : '') + accent + label + reset, data);

type DialogFocus = 'name' | 'topics' | 'selection' | 'repositories' | 'template' | 'prompt' | LaunchField | 'actions';
const isLaunchField = (focus: DialogFocus): focus is LaunchField => (LAUNCH_FIELDS as readonly string[]).includes(focus);
const repositoryFocus: DialogFocus[] = ['name', 'topics', 'selection', 'repositories'];
/** Below this inner width the dialog shows one pane at a time, following focus. */
const SPLIT_MIN_WIDTH = 56;

/**
 * What the dialog starts: work on an issue, in repositories and from a
 * template chosen here, or another session in a work item's ready worktrees.
 */
export type LaunchSubject =
  | { kind: 'issue'; issue: DashboardIssue | TrackerIssue }
  | { kind: 'session'; title: string };

interface LaunchDialogOptions {
  tui: TuiAltScreen;
  state: AppState;
  client: LovelaceClient;
  signal: AbortSignal;
  subject: LaunchSubject;
  onClose: () => void;
  onStart: (prompt: string) => Promise<void>;
}

/**
 * The one launch dialog: a prompt above the shared agent, thinking and model
 * fields, plus repositories and templates when starting work on an issue. A
 * native overlay; its controls never navigate or dispatch dashboard shortcuts.
 */
export class LaunchDialog implements Component {
  focused = true;
  focus: DialogFocus;
  readonly nameFilter = new Input({ prompt: 'Name: ', placeholder: 'Search repositories' });
  readonly topicFilter = new Input({ prompt: 'Topic: ', placeholder: 'infra, examplecom' });
  readonly editor: Editor;
  readonly launchOptions: LaunchOptionsRow;
  readonly templateMenu = new Dropdown(selectTheme('template'), value => void this.chooseTemplate(value || undefined));
  repositories: Repository[];
  templates: PromptTemplate[];
  loading: boolean;
  renderingPrompt = false;
  refreshing = false;
  launching = false;
  showArchived = false;
  selectedIndex = 0;
  error: string | null = null;
  private actionIndex = 0;
  private selectionActionIndex = 0;
  private scrollOffset = 0;
  private promptRows = 5;
  /** Body rows of the last render, shared by both panes. */
  private body = { width: 1, height: 1, compact: false };
  /** Repositories on the left, the prompt on the right. */
  private readonly split = new SplitPane(
    { render: width => this.renderPromptPane(width), handleMouse: event => this.scroll(event, 'prompt'), invalidate: () => {} },
    { render: width => this.renderRepositoryPane(width), handleMouse: event => this.scroll(event, 'repositories'), invalidate: () => {} },
    splitPaneTheme,
    { side: 'start', size: width => width < SPLIT_MIN_WIDTH ? 0 : Math.max(14, Math.floor((width - 3) * 0.38)), gap: 1 },
  );
  private readonly paste = new PasteTracker();
  private closed = false;
  private templateRequest = 0;
  private templateId?: string;
  private readonly lifetime = new AbortController();
  private readonly draftKey: string;
  private subject: LaunchSubject;
  private readonly focusOrder: DialogFocus[];
  private readonly abort = () => this.lifetime.abort();

  constructor(private readonly options: LaunchDialogOptions) {
    this.draftKey = options.state.draftKey;
    this.subject = options.subject;
    const issue = this.subject.kind === 'issue';
    this.focus = issue ? 'repositories' : 'prompt';
    this.focusOrder = [...(issue ? ['name', 'topics', 'selection', 'repositories', 'template'] as const : []), 'prompt', ...LAUNCH_FIELDS, 'actions'];
    this.loading = issue;
    this.repositories = options.state.repositories ?? [];
    this.templates = options.state.promptTemplates ?? [];
    this.templateId = options.state.draft.promptId;
    this.topicFilter.setValue((options.state.dashboardData?.settings.repositoryTopics ?? []).join(', '));
    this.topicFilter.handleInput('\x1b[F');
    this.launchOptions = new LaunchOptionsRow(options.state);
    this.editor = dialogEditor(options.tui, () => this.promptRows);
    this.editor.onChange = () => {
      if (this.active) this.setDraft({ text: this.editor.getExpandedText() });
    };
    // Templates must stay visible/editable, not collapse into native paste markers.
    replaceEditorText(this.editor, options.state.draft.text);
    options.signal.addEventListener('abort', this.abort, { once: true });
    if (options.signal.aborted) this.abort();
  }

  private get active(): boolean {
    return !this.closed && !this.lifetime.signal.aborted && this.options.state.draftKey === this.draftKey;
  }

  private get locked(): boolean {
    return this.launching || Boolean(this.options.state.draft.requestId);
  }

  private setDraft(patch: Parameters<AppState['setDraft']>[0]): void {
    this.options.state.setDraftForKey(this.draftKey, patch);
  }

  private changed(): void { if (this.active) this.options.tui.requestRender(); }

  /** Templates, repositories and the full issue for starting work; nothing for a session. */
  async load(): Promise<void> {
    const subject = this.subject;
    if (subject.kind !== 'issue') return;
    this.loading = true;
    const { client, state } = this.options;
    const signal = this.lifetime.signal;
    const [templates, repositories, issues, tools] = await Promise.allSettled([
      client.prompts.list.query(undefined, { signal }), client.repositories.list.query(undefined, { signal }), client.tracker.issues.query(undefined, { signal }), client.tools.list.query(undefined, { signal }),
    ]);
    if (!this.active) return;
    let loadError: string | null = null;
    if (tools.status === 'fulfilled') state.setTools(tools.value);
    for (const result of [templates, repositories, issues, tools]) {
      if (result.status === 'rejected') loadError = result.reason instanceof Error ? result.reason.message : 'Could not load start-work options.';
    }
    if (templates.status === 'fulfilled') state.promptTemplates = this.templates = templates.value;
    if (repositories.status === 'fulfilled') state.repositories = this.repositories = repositories.value;
    if (issues.status === 'fulfilled') this.subject = { kind: 'issue', issue: issues.value.find(issue => issue.id === subject.issue.id) ?? subject.issue };
    if (!state.draft.text.trim()) {
      const template = this.templates.find(template => template.id === (state.draft.promptId ?? 'implement')) ?? this.templates[0];
      if (template) await this.chooseTemplate(template.id);
    }
    if (!this.active) return;
    this.loading = false;
    this.error ??= loadError;
    this.changed();
  }

  async chooseTemplate(promptId?: string): Promise<void> {
    const subject = this.subject;
    if (!this.active || this.locked || subject.kind !== 'issue') return;
    const request = ++this.templateRequest;
    this.templateId = promptId;
    if (!promptId) {
      this.renderingPrompt = false;
      this.setDraft({ promptId: undefined });
      this.changed();
      return;
    }
    this.renderingPrompt = true;
    this.error = null;
    this.changed();
    try {
      const rendered = await this.options.client.prompts.render.mutate({
        promptId, title: `${subject.issue.key}: ${subject.issue.title}`,
        sources: [{ sourceType: 'tracker-item', provider: 'jira', externalId: subject.issue.id, payload: subject.issue }],
      }, { signal: this.lifetime.signal });
      if (!this.active || request !== this.templateRequest) return;
      // Rendered prompts embed provider text; it must not carry terminal links or controls.
      const content = stripTerminalSequences(rendered.content);
      this.setDraft({ text: content, promptId });
      replaceEditorText(this.editor, content);
      this.editor.handleInput('\x1b[1;5H'); // Preview starts at the top, not the last line.
    } catch (error) {
      if (!this.active || request !== this.templateRequest) return;
      this.templateId = this.options.state.draft.promptId;
      this.error = error instanceof Error ? error.message : 'Could not render the template.';
    } finally {
      if (request === this.templateRequest) this.renderingPrompt = false;
      this.changed();
    }
  }

  private syncTemplateMenu(): void {
    this.templateMenu.setItems([{ value: '', label: 'Manual prompt' }, ...this.templates.map(template => ({ value: template.id, label: template.title }))], this.templateId ?? '');
  }

  get visibleRepositories(): Repository[] {
    const topics = this.topicFilter.getValue().split(/[\s,]+/).filter(Boolean).join(',');
    return filterRepositories(this.repositories, `${this.nameFilter.getValue()} ${topics ? 'topic:' + topics : ''}`)
      .filter(repo => this.showArchived || !repo.isArchived);
  }

  toggleRepository(repoId: string): void {
    if (this.locked || !this.repositories.some(repo => repo.id === repoId)) return;
    const selected = this.options.state.draft.repoIds ?? [];
    if (!selected.includes(repoId) && selected.length >= 100) {
      this.error = 'Select at most 100 repositories.';
      this.changed();
      return;
    }
    this.setDraft({ repoIds: selected.includes(repoId) ? selected.filter(id => id !== repoId) : [...selected, repoId] });
    this.error = null;
    this.changed();
  }

  selectAll(): void {
    if (!this.active || this.locked) return;
    const selected = new Set(this.options.state.draft.repoIds ?? []);
    for (const repo of this.visibleRepositories) selected.add(repo.id);
    if (selected.size > 100) {
      this.error = 'Select at most 100 repositories. Narrow the filters before selecting all.';
    } else {
      this.setDraft({ repoIds: [...selected] });
      this.error = null;
    }
    this.changed();
  }

  unselectAll(): void {
    if (!this.active || this.locked) return;
    this.setDraft({ repoIds: [] });
    this.error = null;
    this.changed();
  }

  async refreshRepositories(): Promise<void> {
    if (this.refreshing || !this.active) return;
    this.refreshing = true;
    this.error = null;
    this.changed();
    try {
      const result = await this.options.client.repositories.sync.mutate(undefined, { signal: this.lifetime.signal });
      if (!this.active) return;
      this.options.state.repositories = this.repositories = result.repos;
      this.selectedIndex = 0;
      this.scrollOffset = 0;
    } catch (error) {
      if (!this.active) return;
      this.error = error instanceof Error ? error.message : 'GitHub refresh failed; keeping cached repositories.';
    } finally {
      this.refreshing = false;
      this.changed();
    }
  }

  async start(): Promise<void> {
    if (!this.active || this.launching || this.loading || this.renderingPrompt) return;
    if (!this.editor.getExpandedText().trim()) {
      this.error = `Write a prompt before starting ${this.subject.kind === 'issue' ? 'work' : 'the session'}.`;
      this.focus = 'prompt';
      this.changed();
      return;
    }
    this.launching = true;
    this.error = null;
    this.changed();
    try {
      await this.options.onStart(this.editor.getExpandedText());
      if (!this.active) return;
      this.error = this.options.state.error;
    } catch (error) {
      if (this.active) this.error = error instanceof Error ? error.message : 'Could not start.';
    } finally {
      this.launching = false;
      this.changed();
    }
  }

  close(): void {
    if (this.closed) return;
    this.dispose();
    this.options.onClose();
  }

  dispose(): void {
    this.closed = true;
    this.lifetime.abort();
    this.options.signal.removeEventListener('abort', this.abort);
    this.editor.focused = this.nameFilter.focused = this.topicFilter.focused = false;
  }

  invalidate(): void {
    this.editor.invalidate();
    this.nameFilter.invalidate();
    this.topicFilter.invalidate();
  }

  /** Clicked controls arrive as links; see `control`. */
  openLink(link: ClickTarget): void {
    if (!this.active || link.kind !== 'modal') return;
    const field = this.launchOptions.openLink(link.data);
    if (field || link.data.startsWith('template:')) {
      this.focus = field ?? 'template';
      if (!field) {
        this.syncTemplateMenu();
        this.templateMenu.openLink(link.data.slice('template:'.length));
      }
      this.changed();
      return;
    }
    const [target, value] = link.data.split(':') as [string, string?];
    if (target === 'repo') {
      this.focus = 'repositories';
      this.selectedIndex = Number(value);
      const repo = this.visibleRepositories[this.selectedIndex];
      if (repo) this.toggleRepository(repo.id);
    } else if (target === 'focus') this.focus = value as DialogFocus;
    // Clicks move the keyboard selection too, so Enter repeats what was clicked.
    else if (target === 'all' || target === 'none') {
      this.focus = 'selection';
      this.selectionActionIndex = target === 'all' ? 0 : 1;
      if (target === 'all') this.selectAll(); else this.unselectAll();
    } else if (target === 'start') { this.focus = 'actions'; this.actionIndex = 0; void this.start(); }
    else if (target === 'cancel') { this.close(); return; }
    this.changed();
  }

  /** The wheel scrolls the repository list, or the prompt once it is being edited. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== 'wheel' || !this.active) return undefined;
    if (this.single === 'repositories') return this.scroll(event, 'repositories');
    // Skip the frame's border and padding.
    return this.split.handleMouse({ ...event, x: event.x - 2, width: this.body.width });
  }

  private scroll(event: TuiMouseEvent, pane: 'prompt' | 'repositories'): TuiMouseEventResult | undefined {
    if (event.type !== 'wheel') return undefined;
    const step = Math.sign(event.wheelDelta ?? 0);
    if (pane === 'prompt') {
      if (this.focus === 'prompt') this.editor.handleInput(step < 0 ? '\x1b[A' : '\x1b[B');
    } else this.selectedIndex = Math.max(0, Math.min(this.visibleRepositories.length - 1, this.selectedIndex + step));
    this.changed();
    return { handled: true };
  }

  handleInput(data: string): void {
    if (!this.active || isKeyRelease(data)) return;
    const textInput = this.focus === 'prompt' || this.focus === 'name' || this.focus === 'topics';
    if (textInput && this.paste.feed(data)) {
      this.handleTextInput(data, true);
      return;
    }
    if (matchesKey(data, 'ctrl+s') || matchesKey(data, 'ctrl+enter')) { void this.start(); return; }
    // Select fields take their keys first; Tab, Esc and keys of a closed field fall through.
    if (this.focus === 'template' && !this.locked) this.syncTemplateMenu();
    const menuUsed = this.focus === 'template' ? !this.locked && this.templateMenu.handleInput(data)
      : isLaunchField(this.focus) && this.launchOptions.handleInput(this.focus, data);
    if (menuUsed) { this.changed(); return; }
    if (matchesKey(data, 'escape')) { this.close(); return; }
    if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
      const delta = matchesKey(data, 'shift+tab') ? -1 : 1;
      const order = this.focusOrder;
      this.focus = order[(order.indexOf(this.focus) + delta + order.length) % order.length]!;
    } else if (textInput) {
      if (this.focus !== 'prompt' && matchesKey(data, 'enter')) this.focus = 'repositories';
      else this.handleTextInput(this.focus === 'prompt' && matchesKey(data, 'enter') ? '\n' : data);
    } else if ((this.focus === 'selection' || this.focus === 'repositories') && matchesKey(data, 'ctrl+a')) {
      this.selectAll();
    } else if ((this.focus === 'selection' || this.focus === 'repositories') && matchesKey(data, 'ctrl+u')) {
      this.unselectAll();
    } else if (this.focus === 'selection') {
      if (matchesKey(data, 'left') || matchesKey(data, 'right')) this.selectionActionIndex = 1 - this.selectionActionIndex;
      else if (matchesKey(data, 'enter') || matchesKey(data, 'space')) {
        if (this.selectionActionIndex) this.unselectAll();
        else this.selectAll();
      } else if (matchesKey(data, 'down')) this.focus = 'repositories';
    } else if (this.focus === 'repositories' && this.subject.kind === 'issue') {
      if (matchesKey(data, 'down') || data === 'j') this.selectedIndex = Math.min(this.visibleRepositories.length - 1, this.selectedIndex + 1);
      else if (matchesKey(data, 'up') || data === 'k') this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      else if (matchesKey(data, 'space') || matchesKey(data, 'enter')) {
        const repo = this.visibleRepositories[this.selectedIndex];
        if (repo) this.toggleRepository(repo.id);
      } else if (matchesKey(data, '/')) this.focus = 'name';
      else if (data === 't') this.focus = 'topics';
      else if (data === 'a') { this.showArchived = !this.showArchived; this.selectedIndex = 0; }
      else if (data === 'r') void this.refreshRepositories();
      else if (matchesKey(data, 'right')) this.focus = 'template';
    } else if (this.focus === 'actions') {
      if (matchesKey(data, 'left') || matchesKey(data, 'right')) this.actionIndex = 1 - this.actionIndex;
      else if (matchesKey(data, 'enter')) {
        if (this.actionIndex) this.close();
        else void this.start();
      }
    }
    this.changed();
  }

  private handleTextInput(data: string, pasted = false): void {
    if (this.focus === 'prompt') {
      const previous = this.editor.getExpandedText();
      this.editor.handleInput(data);
      // Do not cancel rendering just for cursor movement, but never let a
      // late template response overwrite edits or an in-progress paste.
      if (this.editor.getExpandedText() !== previous || pasted) {
        ++this.templateRequest;
        this.renderingPrompt = false;
        this.templateId = this.options.state.draft.promptId;
      }
    } else {
      (this.focus === 'name' ? this.nameFilter : this.topicFilter).handleInput(data);
      this.selectedIndex = 0;
      this.scrollOffset = 0;
    }
    this.changed();
  }

  /** The only pane shown for a session or on narrow terminals, or undefined when both fit. */
  private get single(): 'repositories' | 'prompt' | undefined {
    if (this.subject.kind !== 'issue') return 'prompt';
    if (this.body.width >= SPLIT_MIN_WIDTH) return undefined;
    return repositoryFocus.includes(this.focus) ? 'repositories' : 'prompt';
  }

  render(width: number): string[] {
    const height = Math.max(8, Math.min(32, this.options.tui.terminal.rows - 2));
    const innerWidth = Math.max(1, width - 4);
    const compact = height < 16;
    this.body = { width: innerWidth, height: height - (compact ? 5 : 7), compact };
    const { secondaryWidth: leftWidth, primaryWidth: rightWidth } = this.split.layout(innerWidth);
    const issue = this.subject.kind === 'issue' ? this.subject.issue : undefined;
    this.editor.focused = this.focused && this.focus === 'prompt';
    this.nameFilter.focused = this.focused && this.focus === 'name';
    this.topicFilter.focused = this.focused && this.focus === 'topics';
    this.editor.borderColor = text => (this.focus === 'prompt' ? accent : muted) + text + reset;
    const selected = this.options.state.draft.repoIds?.length ?? 0;
    const lines = [
      muted + '╭' + '─'.repeat(Math.max(0, width - 2)) + '╮' + reset,
      this.row(bold + (issue ? 'Start work' : 'New session') + reset + '  ' + safeText(issue ? `${issue.key}: ${issue.title}` : this.subject.kind === 'session' ? this.subject.title : ''), innerWidth),
      ...(compact ? [] : [this.separator(leftWidth, rightWidth, '┬')]),
      ...(this.single === 'repositories' ? this.renderRepositoryPane(innerWidth)
        : this.single === 'prompt' ? this.renderPromptPane(innerWidth) : this.split.render(innerWidth))
        .map(line => this.row(line, innerWidth)),
    ];
    const action = (label: string, index: number) =>
      button(`[ ${label} ]`, this.focus === 'actions' && this.actionIndex === index, index ? 'cancel' : 'start');
    if (!compact) lines.push(this.separator(leftWidth, rightWidth, '┴'));
    const start = this.launching ? 'Starting…' : this.locked ? 'Retry start' : issue ? 'Start work' : 'Start session';
    lines.push(this.row(action(start, 0) + '  ' + action('Cancel', 1) + (issue ? muted + `  ${selected} repositories · r refresh · a archived` + reset : ''), innerWidth));
    const status = this.error ?? (this.launching ? 'Saving the launch request…' : this.refreshing ? 'Refreshing GitHub repositories…' : this.loading ? 'Loading templates and repositories…' : this.help(innerWidth));
    lines.push(this.row((this.error ? danger : muted) + safeText(status) + reset, innerWidth));
    lines.push(muted + '╰' + '─'.repeat(Math.max(0, width - 2)) + '╯' + reset);
    // A raised surface over the page.
    return lines.map(line => canvas(line, width, cardBg));
  }

  private renderRepositoryPane(width: number): string[] {
    const { height, compact } = this.body;
    const selected = new Set(this.options.state.draft.repoIds ?? []);
    const repositories = this.visibleRepositories;
    const selectionAction = (label: string, index: number) => button(width >= 31 ? `[ ${label} ]` : `[${label}]`,
      this.focus === 'selection' && this.selectionActionIndex === index, index ? 'none' : 'all');
    const selectionActions = selectionAction(width >= 31 ? 'Select all' : 'All', 0) + ' ' + selectionAction(width >= 31 ? 'Unselect all' : 'None', 1);
    const lines = [
      compact ? selectionActions : bold + (width < 26 ? `Repos (${selected.size})` : 'Repositories') + reset + (width < 26 ? '' : accent + `  ${selected.size} selected` + reset),
      this.renderFilter(this.nameFilter, width, 'name'),
      this.renderFilter(this.topicFilter, width, 'topics'),
      ...(compact ? [] : [selectionActions]),
    ];
    const listRows = Math.max(1, height - lines.length - 1);
    const pageSize = Math.max(1, Math.floor(listRows / 2));
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, repositories.length - 1));
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, this.selectedIndex));
    if (this.selectedIndex >= this.scrollOffset + pageSize) this.scrollOffset = this.selectedIndex - pageSize + 1;
    for (const [index, repo] of repositories.slice(this.scrollOffset, this.scrollOffset + pageSize).entries()) {
      const active = this.focus === 'repositories' && this.scrollOffset + index === this.selectedIndex;
      const label = (selected.has(repo.id) ? accent + icons.checkboxOn : muted + icons.checkboxOff) + reset + ' ' + safeText(repo.name);
      lines.push(control(active ? selectedBand(accent + label, width) : padRight(label, width), 'repo:' + (this.scrollOffset + index)));
      const owner = repo.fullName.split('/')[0] ?? '';
      if (listRows > 1) lines.push(muted + safeText(`  ${owner} · ${repo.isArchived ? 'archived' : repo.topics.join(', ') || 'no topics'}`) + reset);
    }
    if (!repositories.length) lines.push(muted + (this.loading ? 'Loading repositories…' : this.repositories.length ? 'No matches. Edit filters / a.' : 'No cached repos. r refresh.') + reset);
    while (lines.length < height - 1) lines.push('');
    lines.push(muted + `${repositories.length} shown / ${this.repositories.length} cached${this.showArchived ? ' · archived included' : ''}` + reset);
    return lines.slice(0, height);
  }

  /** Template above the prompt, the less important agent/thinking/model fields below it. */
  private renderPromptPane(width: number): string[] {
    const template = this.subject.kind === 'issue' ? this.renderTemplate(width) : [];
    const launch = this.launchOptions.render(width, this.focused && isLaunchField(this.focus) ? this.focus : undefined);
    const promptHeight = Math.max(3, this.body.height - 1 - template.length - launch.length);
    return [
      ...template,
      bold + 'Prompt' + reset + muted + (this.renderingPrompt ? '  rendering…' : '  editable preview') + reset,
      ...this.renderPrompt(width, promptHeight).map(line => this.focus === 'prompt' ? line : control(line, 'focus:prompt')),
      ...launch,
    ].slice(0, this.body.height);
  }

  /** The template field, and its list below it while expanded. */
  private renderTemplate(width: number): string[] {
    const focused = this.focused && this.focus === 'template';
    if (!focused) this.templateMenu.close();
    this.syncTemplateMenu();
    const label = (focused ? accent : muted) + 'Template ' + reset;
    return [label + this.templateMenu.renderField(Math.max(8, Math.min(40, width - 9)), focused),
      ...this.templateMenu.renderList(Math.max(1, Math.min(48, width - 9))).map(line => ' '.repeat(Math.min(9, width - 1)) + line)];
  }

  private renderFilter(input: Input, width: number, focus: DialogFocus): string {
    if (this.focus === focus) return input.render(width)[0]!;
    return control(muted + (focus === 'name' ? 'Name: ' : 'Topic: ') + reset + safeText(input.getValue() || (focus === 'name' ? 'all repositories' : 'all topics')), 'focus:' + focus);
  }

  private renderPrompt(width: number, height: number): string[] {
    this.promptRows = Math.max(1, height - 2);
    if (this.focus !== 'prompt') {
      const preview = wrap(this.editor.getExpandedText(), Math.max(1, width - 2));
      return [muted + '─'.repeat(width) + reset,
        ...Array.from({ length: height - 2 }, (_, row) => ' ' + padRight(preview[row] ?? '', Math.max(1, width - 2)) + ' '),
        muted + (preview.length > height - 2 ? truncate('↓ Tab to edit / scroll', width) : '─'.repeat(width)) + reset];
    }
    return fitEditorLines(this.editor.render(width), height);
  }

  private separator(leftWidth: number, rightWidth: number, junction: '┬' | '┴'): string {
    // Include the outer padding and the gutter beside each column.
    if (this.single) return muted + '├' + '─'.repeat(this.body.width + 2) + '┤' + reset;
    return muted + '├' + '─'.repeat(leftWidth + 2) + junction + '─'.repeat(rightWidth + 2) + '┤' + reset;
  }

  private row(content: string, width: number): string {
    return muted + '│' + reset + ' ' + linkCell(content, width) + ' ' + muted + '│' + reset;
  }

  private help(width: number): string {
    const start = width < 60 ? '^S start' : 'Ctrl+S start';
    if (this.focus === 'prompt') return `Enter newline · Tab next · ${start} · Esc cancel`;
    if (this.focus === 'name' || this.focus === 'topics') return `Enter list · Tab next · ${start} · Esc cancel`;
    if ((this.focus === 'template' && this.templateMenu.open) || (isLaunchField(this.focus) && this.launchOptions.openField)) return '↑/↓ move · Enter choose · type filter · Esc close';
    if (this.focus === 'template' || isLaunchField(this.focus)) return `Enter open · type search · Tab next · ${start} · Esc cancel`;
    if (this.focus === 'actions') return `←/→ choose · Enter apply · Tab next · Esc cancel`;
    if (this.focus === 'selection') return width < 60 ? 'All = matches · None = clear all · ←/→ · Enter' : 'Select all matches / Unselect all repositories · ←/→ choose · Enter apply · Tab next';
    return width < 60 ? `^A all · ^U clear · Tab · ${start} · Esc` : `Space select · Ctrl+A all · Ctrl+U clear · Tab · ${start} · Esc`;
  }
}
