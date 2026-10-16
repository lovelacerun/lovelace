import type { Component, OverlayHandle, TuiAltScreen, TuiMouseEvent, TuiMouseEventResult } from '@earendil-works/pi-tui';
import { compositeTuiLine, Editor, getKeybindings, isKeyRelease, matchesKey } from '@earendil-works/pi-tui';
import type { LovelaceClient } from '@lovelace/client';
import type { SidebarSide } from '@lovelace/core';

import { AppState } from './state.js';
import { openBrowser } from './browser.js';
import { RefreshPoller } from './poller.js';
import { band, barBg, canvas, bold, accent, muted, editorTheme, faint, heading, icons, panelBg, danger, reset, splitPaneTheme } from './theme.js';
import { visibleWidth } from '@earendil-works/pi-tui';
import {
  fitEditorLines, LINK_END, padRight, PasteTracker, replaceEditorText, safeText, SplitPane, truncate,
} from '@lovelace/tui-components';
import {
  COMPACT_ROWS, CONTENT_MIN_WIDTH, contentGutter, DOCK_MIN_ROWS, MIN_HEIGHT, MIN_WIDTH, responsiveSidebarWidth,
  SIDEBAR_MIN_WIDTH,
} from './layout.js';
import { parseClickTarget } from './clickable.js';
import { connectionStatus, fitChips, helpChips, renderConfirmDialog } from './compositor.js';
import { keyChip } from './key-hints.js';
import { splitIssueKey } from './views/common.js';
import { decode } from './keymap.js';
import { handleKey, handleAction, submitLaunch, type ControllerDeps } from './controller.js';
import { errorMessage, isOffline } from './errors.js';
import { renderDashboard } from './views/dashboard.js';
import { renderSidebar } from './views/sidebar.js';
import { renderWorkItem } from './views/work-item.js';
import { renderJira } from './views/jira.js';
import type { Document } from './views/common.js';
import { JiraStartModal } from './jira-start-modal.js';
import { launchField, launchFocus, LaunchOptionsRow } from './launch-options.js';

interface AppRootOptions {
  tui: TuiAltScreen;
  client: LovelaceClient;
  sidebarSide?: SidebarSide;
  /** Injectable browser launcher; tests never open operator browser windows. */
  openUrl?: (url: string) => Promise<void>;
}

/**
 * Root component. Composes sidebar, main view, and the pi-tui Editor instance
 * into the terminal viewport. Owns input routing and the two refresh pollers.
 */
export class AppRoot implements Component {
  readonly state: AppState;
  readonly tui: TuiAltScreen;
  readonly client: LovelaceClient;
  readonly editor: Editor;
  private jiraStart?: { modal: JiraStartModal; handle: OverlayHandle };
  private readonly dashboardPoller: RefreshPoller;
  private readonly detailsPoller: RefreshPoller;
  private detailLoadToken = 0;
  private removeInputListener?: () => void;
  private quitResolver?: () => void;
  private stopped = false;
  private readonly lifetime = new AbortController();
  private readonly paste = new PasteTracker();
  private opening = false;
  private readonly openUrl: (url: string) => Promise<void>;
  /** Size of the last frame's sidebar/content body; 0 while the terminal is too small. */
  private body = { cols: 0, height: 0 };
  /** First content row of the quick-start dock, and of its launch fields below the editor. */
  private editorTop = Infinity;
  private optionsTop = Infinity;
  private optionsHeight = 0;
  private readonly launchOptions: LaunchOptionsRow;
  /** Content beside the global sidebar, whose divider can be dragged for the session. */
  private readonly split: SplitPane;

  constructor(options: AppRootOptions) {
    this.tui = options.tui;
    this.client = options.client;
    this.openUrl = options.openUrl ?? openBrowser;
    this.state = new AppState({
      sidebarSide: options.sidebarSide,
      onInvalidate: () => { if (!this.stopped) this.tui.requestRender(); },
    });

    this.editor = new Editor(this.tui, editorTheme);
    // Built-in submit trims and clears before onSubmit. Own submission instead.
    this.editor.disableSubmit = true;
    // Only ever update the text field, never the pending launch, from a keystroke.
    this.editor.onChange = () => this.state.setDraft({ text: this.editor.getExpandedText() });
    this.launchOptions = new LaunchOptionsRow(this.state);

    this.dashboardPoller = new RefreshPoller((signal) => this.fetchDashboard(signal),
      () => this.state.activeWorkItems.some(item => ['accepted', 'preparing', 'starting'].includes(item.launchPhase ?? '')) ? 2000 : 7000);
    this.detailsPoller = new RefreshPoller((signal) => this.fetchDetails(signal),
      () => this.state.selectedWorkItemData?.launchOperations?.some(operation => operation.status === 'pending') ? 1000 : 7000);
    this.split = new SplitPane(
      {
        render: width => this.renderContent(width),
        handleMouse: event => this.handleContentMouse(event),
        invalidate: () => this.editor.invalidate(),
      },
      {
        render: width => this.renderSidebarPane(width),
        handleMouse: event => this.handleWheel(event, 'sidebar'),
        invalidate() {},
      },
      splitPaneTheme,
      { size: responsiveSidebarWidth, resizable: true, minSize: SIDEBAR_MIN_WIDTH, minPrimarySize: CONTENT_MIN_WIDTH },
    );
  }

  // Public lifecycle ---------------------------------------------------------

  start(): Promise<void> {
    this.removeInputListener = this.tui.addInputListener((data) => this.handleRawInput(data));
    this.tui.start();
    this.dashboardPoller.start();
    this.detailsPoller.start();
    void this.loadTools();
    return new Promise<void>((resolve) => {
      this.quitResolver = resolve;
    });
  }

  stop(preserveScreen = false): void {
    if (this.stopped) return;
    this.stopped = true;
    this.lifetime.abort();
    this.dashboardPoller.stop();
    this.detailsPoller.stop();
    this.removeInputListener?.();
    this.removeInputListener = undefined;
    this.editor.focused = false;
    this.closeJiraStart();
    this.tui.stop({ preserveScreen });
  }

  quit(): void {
    this.stop();
    this.quitResolver?.();
    this.quitResolver = undefined;
  }

  invalidate(): void {
    this.editor.invalidate();
    this.tui.requestRender();
  }

  // Rendering ----------------------------------------------------------------

  render(width: number): string[] {
    const cols = this.tui.terminal.columns || width;
    const rows = this.tui.terminal.rows || 24;
    if (cols < MIN_WIDTH || rows < MIN_HEIGHT) {
      this.body = { cols, height: 0 };
      return [
        `${danger}${bold}Terminal too small${reset}`,
        `${muted}Need ≥${MIN_WIDTH}×${MIN_HEIGHT} (now ${cols}×${rows}).${reset}`,
        `${muted}Resize and the dashboard reappears automatically.${reset}`,
      ].slice(0, Math.max(0, rows)).map(line => canvas(line, cols));
    }

    // The header and footer bars take one row each.
    this.body = { cols, height: rows - 2 };
    const sidebar = this.split.layout(cols).secondaryWidth > 0;
    this.state.layout = { sidebar, compact: this.body.height < COMPACT_ROWS };
    if (!sidebar && this.state.focus === 'sidebar') this.state.focus = 'content';

    // Sync editor contents against the active draft before every render so
    // navigation across drafts is always reflected visually. No-op when the
    // text already matches.
    this.syncEditor();
    this.applyFocusToTui();

    this.split.setSide(this.state.sidebarSide === 'left' ? 'start' : 'end');
    // Every row is painted with the theme, independent of the terminal's own colours.
    const frame = [
      band(this.renderHeader(cols), cols, barBg) + LINK_END,
      ...this.split.render(cols),
      band(this.renderBottomBar(cols - 2), cols, barBg) + LINK_END,
    ].map(line => canvas(line, cols));
    return this.overlayConfirmDialog(frame, cols);
  }

  /** A pending confirmation sits in the middle of the frame, where it is seen. */
  private overlayConfirmDialog(frame: string[], cols: number): string[] {
    const dialog = renderConfirmDialog(this.state, cols);
    if (!dialog.length) return frame;
    const width = visibleWidth(dialog[0]!);
    const top = Math.max(0, Math.floor((frame.length - dialog.length) / 2));
    const left = Math.floor((cols - width) / 2);
    return frame.map((line, row) => {
      const overlay = dialog[row - top];
      return overlay === undefined ? line : compositeTuiLine(line, overlay + LINK_END, left, width, cols);
    });
  }

  /** App mark and location on the left, connection state on the right. */
  private renderHeader(cols: number): string {
    const view = this.state.view;
    const title = view === 'work-item' ? this.state.selectedWorkItemData?.workItem.title
      : view === 'jira' ? this.state.selectedJira?.key : undefined;
    const place = view === 'dashboard' ? 'Home' : safeText(title ? splitIssueKey(safeText(title)).key ?? title
      : view === 'jira' ? 'Jira' : 'Work');
    const mark = ' ' + accent + icons.app + reset + '  ' + (cols >= 50 ? bold + 'lovelace' + reset + faint + '  /  ' + reset : '');
    let right = connectionStatus(this.state);
    // The actual client address, so a stale port override is visible.
    if (cols >= 80) right = faint + safeText(this.client.serverUrl) + reset + '   ' + right;
    const room = cols - visibleWidth(right) - 1;
    const left = padRight(truncate(mark + place, room - 2), room);
    return left + right;
  }

  /** The current view, scrolled to its selection, above the Home dock. */
  private renderContent(width: number): string[] {
    const height = this.body.height;
    // Breathing room: a top margin and a generous gutter, dropped first on small screens.
    const roomy = !this.state.layout.compact;
    const gutter = contentGutter(width);
    const top = height >= DOCK_MIN_ROWS ? [''] : [];
    const panelWidth = Math.max(1, width - gutter * 2);
    const document = this.renderCurrentView(panelWidth);
    const editorLines = this.renderDock(panelWidth, roomy, height);
    const viewportHeight = Math.max(0, height - editorLines.length - top.length);
    const contentLines = padColumn(this.applyScroll(document, viewportHeight), viewportHeight);
    this.editorTop = editorLines.length ? height - editorLines.length : Infinity;
    this.optionsTop = editorLines.length ? height - this.optionsHeight : Infinity;
    return padColumn([...top, ...contentLines, ...editorLines].map(line => ' '.repeat(gutter) + line), height);
  }

  /**
   * The Home-only Quick start dock: three input lines above the agent,
   * thinking and model fields (whose lists expand below them), or a single
   * row on short terminals until it is focused. Jira's prompt lives in its overlay.
   */
  private renderDock(width: number, roomy: boolean, height: number): string[] {
    this.optionsHeight = 0;
    if (this.state.view !== 'dashboard') return [];
    const focused = this.state.focus === 'editor';
    const field = launchField(this.state.focus);
    const title = heading('Quick start', '', icons.quickStart);
    if (height < DOCK_MIN_ROWS && !focused && !field) {
      this.launchOptions.render(width);
      const draft = safeText(this.state.draft.text).trim();
      return [title + '  ' + (draft ? muted + truncate(draft, Math.max(1, width - visibleWidth(title) - 2)) : faint + 'n to write') + reset];
    }
    this.editor.borderColor = text => (focused ? accent : faint) + text + reset;
    const options = this.launchOptions.render(width, field);
    this.optionsHeight = options.length;
    return [...(roomy ? [''] : []), title, ...fitEditorLines(this.editor.render(width), 5), ...options];
  }

  /** Navigation remains a stable landmark during first load and disconnection. */
  private renderSidebarPane(width: number): string[] {
    const height = this.body.height;
    const sidebar = renderSidebar(this.state, width);
    return padColumn(sidebar.lines.slice(Math.max(0, sidebar.selectedRow - height + 1)), height)
      .map(line => band(line, width, panelBg));
  }

  private renderCurrentView(width: number): Document {
    // Even when offline, keep rendering the last-known view; the offline/stale
    // state is surfaced in the help bar.
    if (this.state.view === 'work-item') return renderWorkItem(this.state, width);
    if (this.state.view === 'jira') return renderJira(this.state, width);
    return renderDashboard(this.state, width);
  }

  /** Inset by one cell on each side of the footer bar. */
  private renderBottomBar(width: number): string {
    if (this.state.pendingConfirm) return ' ' + fitChips({ status: '', chips: [keyChip('y', 'confirm'), keyChip('Esc', 'cancel')] }, width);
    if (this.state.offline) {
      const status = `${danger}Offline (${this.state.dashboardData ? 'last-known' : 'no'} data)${reset}`;
      return ' ' + fitChips({ status, chips: [keyChip('r', 'retry'), keyChip('q', 'quit')] }, width);
    }
    return ' ' + fitChips(helpChips(this.state, this.launchOptions.openField !== undefined), width);
  }

  private applyScroll(document: Document, viewportHeight: number): string[] {
    const total = document.lines.length;
    if (viewportHeight <= 0) return [];
    let offset = this.state.getScrollOffset();
    const maxOffset = Math.max(0, total - viewportHeight);
    if (offset > maxOffset) offset = maxOffset;
    // Keep selected row visible.
    const selected = document.selectedRow;
    if (selected < offset) offset = selected;
    else if (selected >= offset + viewportHeight) offset = selected - viewportHeight + 1;
    this.state.setScrollOffset(offset);
    return document.lines.slice(offset, offset + viewportHeight);
  }

  // Mouse --------------------------------------------------------------------

  /**
   * Presses outside the divider stay unhandled so pi-tui keeps native text
   * selection; it reports a click back here, or to `openLink` on a link.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const { cols, height } = this.body;
    // The confirmation dialog is modal: only its own y/Esc links respond.
    if (!height || this.stopped || this.jiraStart || this.state.pendingConfirm) return undefined;
    // The body starts below the header; a captured divider drag continues outside it.
    const y = event.y - 1;
    if ((y < 0 || y >= height) && !this.split.dragging) return undefined;
    return this.split.handleMouse({ ...event, y, width: cols, height });
  }

  private handleContentMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== 'click' || event.button !== 'left') return this.handleWheel(event, 'content');
    if (event.y >= this.optionsTop) this.state.setFocus(launchField(this.state.focus) ? this.state.focus : launchFocus('agent'));
    else if (event.y >= this.editorTop) this.focusEditor();
    else if (this.state.focus === 'editor' || launchField(this.state.focus)) this.state.setFocus('content');
    this.applyFocusToTui();
    return { handled: true };
  }

  /** The wheel moves the selection of the pane under the pointer. */
  private handleWheel(event: TuiMouseEvent, focus: 'sidebar' | 'content'): TuiMouseEventResult | undefined {
    if (event.type !== 'wheel') return undefined;
    if (this.state.focus !== focus) this.state.setFocus(focus);
    this.state.move(Math.sign(event.wheelDelta ?? 0), this.contentActionCount());
    this.applyFocusToTui();
    return { handled: true };
  }

  /** Target of every clicked OSC 8 link: in-app rows, help chips and provider URLs. */
  openLink(url: string): void {
    if (this.stopped) return;
    const link = parseClickTarget(url);
    if (!link) {
      // Overlay and view links are already filtered through browserUrl.
      this.openUrl(url).catch((error: unknown) => {
        this.state.setError(errorMessage(error, 'Opening the link failed'));
      });
      return;
    }
    if (this.jiraStart) {
      this.jiraStart.modal.openLink(link);
      return;
    }
    const field = link.kind === 'modal' && !this.state.pendingConfirm ? this.launchOptions.openLink(link.data) : undefined;
    if (field) {
      this.state.setFocus(launchFocus(field));
      this.applyFocusToTui();
      return;
    }
    if (link.kind === 'key') {
      this.handleRawInput(link.data);
      return;
    }
    // Like Enter, a clicked row never bypasses a pending y/Esc confirmation.
    if (link.kind === 'modal' || this.state.pendingConfirm) return;
    if (link.kind === 'nav') {
      this.state.sidebarSelectedIndex = link.index;
      this.state.setFocus('sidebar');
      this.handleRawInput('\r');
      return;
    }
    this.state.contentSelectedIndex = link.index;
    this.state.setFocus('content');
    this.applyFocusToTui();
    void this.dispatchContentEnter();
  }

  // Input routing ------------------------------------------------------------

  private handleRawInput(data: string): { consume?: boolean } | undefined {
    if (this.stopped) return { consume: true };
    if (this.jiraStart && !matchesKey(data, 'ctrl+c')) {
      this.jiraStart.modal.handleInput(data);
      return { consume: true };
    }
    // Paste chunks containing Enter/Esc/Tab are data, not application commands.
    if (this.state.focus === 'editor' && this.paste.feed(data)) {
      this.editor.handleInput(data);
      this.tui.requestRender();
      return { consume: true };
    }
    // Kitty-protocol hosts (e.g. Herdr) also report key releases; only presses act.
    if (isKeyRelease(data)) return { consume: true };
    // A launch field takes its keys first; Tab, Esc and keys of a closed field fall through.
    const field = launchField(this.state.focus);
    if (field && !this.state.pendingConfirm && this.launchOptions.handleInput(field, data)) {
      this.tui.requestRender();
      return { consume: true };
    }
    const intent = decode(data, {
      focus: this.state.focus,
      pendingConfirm: this.state.pendingConfirm !== null,
    });

    if (intent.kind === 'ignored') return undefined;
    if (intent.kind === 'editor-input') {
      this.handleEditorInput(intent.data);
      this.tui.requestRender();
      return { consume: true };
    }
    if (intent.kind === 'focus-editor') {
      this.focusEditor();
      return { consume: true };
    }
    // The editor owns its Enter; elsewhere Enter opens the selection.
    if (intent.kind === 'enter' && this.state.focus !== 'sidebar') {
      void this.dispatchContentEnter();
      return { consume: true };
    }
    if (intent.kind === 'enter') {
      const entry = this.state.sidebarEntries[this.state.sidebarSelectedIndex];
      if (entry) this.state.navigate(entry);
      this.triggerDetailsRefresh();
    } else {
      handleKey(this.state, intent, this.makeDeps(), this.contentActionCount());
      if (this.stopped) return { consume: true };
    }
    // Keep editor focus state and text synced with any navigation side-effect.
    this.applyFocusToTui();
    this.syncEditor();
    return { consume: true };
  }

  private handleEditorInput(data: string): void {
    if (getKeybindings().matches(data, 'tui.input.submit') && data !== '\n') {
      // Legacy terminals use backslash+Enter for a newline.
      const cursor = this.editor.getCursor();
      if (matchesKey(data, 'enter') && this.editor.getLines()[cursor.line]?.[cursor.col - 1] === '\\') {
        this.editor.handleInput('\x7f');
        this.editor.insertTextAtCursor('\n');
      } else {
        void this.launchFromEditor(this.editor.getExpandedText());
      }
      return;
    }
    this.editor.handleInput(data);
  }

  private async dispatchContentEnter(): Promise<void> {
    const doc = this.renderCurrentView(80); // width doesn't affect the actions
    const action = doc.actions[this.state.contentSelectedIndex];
    if (!action) return;
    await handleAction(this.state, action, this.makeDeps());
    if (this.stopped) return;
    this.syncEditor();
    this.applyFocusToTui();
  }

  private contentActionCount(): number {
    return this.renderCurrentView(80).actions.length;
  }

  // Dependencies / helpers --------------------------------------------------

  private makeDeps(): ControllerDeps {
    return {
      client: this.client,
      signal: this.lifetime.signal,
      refreshDashboard: () => this.dashboardPoller.refresh(),
      startJiraWork: () => this.openJiraStart(),
      refreshDetails: () => this.triggerDetailsRefresh(),
      submitLaunch: (prompt) => this.launchFromEditor(prompt),
      openSession: (metaId) => this.openSession(metaId),
      openUrl: this.openUrl,
      resetEditor: () => {
        replaceEditorText(this.editor, '');
        this.state.setDraft({ text: '' });
      },
      focusEditor: () => this.focusEditor(),
      invalidate: () => { if (!this.stopped) this.tui.requestRender(); },
      quit: () => this.quit(),
    };
  }

  private focusEditor(): void {
    if (this.state.view === 'jira') {
      if (!this.state.draft.pendingLaunch) this.openJiraStart();
      return;
    }
    if (this.state.view !== 'dashboard') return;
    this.state.setFocus('editor');
    this.applyFocusToTui();
  }

  /** Keep pi-tui focus + the editor's `focused` flag in sync with AppState. */
  private applyFocusToTui(): void {
    if (this.jiraStart) {
      this.editor.focused = false;
      return; // The native overlay remains the keyboard focus owner.
    }
    if (this.state.focus === 'editor' && this.state.view === 'dashboard') {
      this.tui.setFocus(this.editor);
      this.editor.focused = true;
    } else {
      this.tui.setFocus(null);
      this.editor.focused = false;
    }
  }

  /** Reconcile the Editor buffer with the active draft without re-entering onChange. */
  private syncEditor(): void {
    if (this.jiraStart) return;
    const text = this.state.draft.text;
    // Restored large drafts retain native paste-marker performance.
    if (this.editor.getExpandedText() !== text) replaceEditorText(this.editor, text, true);
  }

  private openJiraStart(): void {
    if (this.jiraStart || this.state.view !== 'jira' || !this.state.selectedJira || this.state.mutationInFlight) return;
    if (this.state.draft.pendingLaunch) {
      this.state.setError('Resolve or discard the pending launch before changing its template or repositories.');
      return;
    }
    const draftKey = this.state.draftKey;
    const modal = new JiraStartModal({
      tui: this.tui, state: this.state, client: this.client, signal: this.lifetime.signal,
      onClose: () => this.closeJiraStart(),
      onStart: async prompt => {
        await this.launchFromEditor(prompt);
        if (this.state.draftKey !== draftKey) this.closeJiraStart();
      },
    });
    const handle = this.tui.showOverlay(modal, { width: '96%', maxHeight: '96%', margin: 1, anchor: 'center' });
    this.jiraStart = { modal, handle };
    this.editor.focused = false;
    void modal.load();
  }

  private closeJiraStart(): void {
    const overlay = this.jiraStart;
    if (!overlay) return;
    this.jiraStart = undefined;
    overlay.modal.dispose();
    overlay.handle.hide();
    if (!this.stopped) {
      this.syncEditor();
      this.applyFocusToTui();
      this.tui.requestRender();
    }
  }

  /** Harness detection is cheap and rarely changes: once per TUI, and again with each Jira setup. */
  private async loadTools(): Promise<void> {
    try {
      const tools = await this.client.getTools({ signal: this.lifetime.signal });
      if (!this.stopped) this.state.setTools(tools);
    } catch (error) {
      // Launches still fall back to the server's default agent.
      if (!this.stopped && !isOffline(error) && !this.lifetime.signal.aborted) this.state.setError(errorMessage(error, 'Loading coding harnesses failed'));
    }
  }

  // Pollers ------------------------------------------------------------------

  private async fetchDashboard(signal: AbortSignal): Promise<void> {
    try {
      const data = await this.client.getDashboard({ signal });
      if (signal.aborted || this.stopped) return;
      this.state.applyDashboardResponse(data);
    } catch (error) {
      if (signal.aborted) return;
      // Keep sidebar/last known view; surface the message in the help bar.
      if (isOffline(error)) this.state.setOffline();
      else this.state.setError(errorMessage(error, 'Dashboard refresh failed'));
    }
  }

  private triggerDetailsRefresh(): void {
    this.detailLoadToken++;
    this.detailsPoller.refresh();
  }

  private async fetchDetails(signal: AbortSignal): Promise<void> {
    const token = this.detailLoadToken;
    const { view, selectedWorkItemId, selectedJira } = this.state;
    const current = () => !signal.aborted && token === this.detailLoadToken;
    try {
      if (view === 'work-item' && selectedWorkItemId) {
        const details = await this.client.getWorkItem(selectedWorkItemId, { signal });
        if (current() && this.state.selectedWorkItemId === details.workItem.id) this.state.setWorkItemData(details);
      } else if (view === 'jira' && selectedJira) {
        const issues = await this.client.getJiraIssues({ signal });
        if (current()) this.state.setJiraDetails(issues.find(issue => issue.id === this.state.selectedJira?.id) ?? null);
      }
    } catch (error) {
      if (!current()) return;
      if (isOffline(error)) this.state.setOffline();
      else this.state.setError(errorMessage(error, view === 'jira' ? 'Jira fetch failed' : 'Work item fetch failed'));
    }
  }

  // Mutations ---------------------------------------------------------------

  private async launchFromEditor(prompt: string): Promise<void> {
    if (this.stopped) return;
    await submitLaunch(this.state, this.makeDeps(), prompt);
    if (this.stopped) return;
    // Accepted launches poll on their work item; no completion callback can
    // navigate away from another draft or task the operator opens meanwhile.
    this.triggerDetailsRefresh();
    // Reflect state back onto the editor contents.
    this.syncEditor();
    this.applyFocusToTui();
  }

  /**
   * Herdr focuses the session's live pane, or continues its exact native
   * conversation when the agent ended. Selecting the session is the request.
   */
  private async openSession(metaId: string): Promise<void> {
    const workItemId = this.state.selectedWorkItemId;
    if (!workItemId || this.stopped || this.opening) return;
    const details = this.state.selectedWorkItemData;
    if (details && details.workItem.state !== 'active') {
      this.state.setError('Reactivate local work explicitly (press a, then y) before opening or continuing this session.');
      return;
    }
    this.opening = true;
    this.state.setError(null);
    this.state.setNotice('Opening session in Herdr…');
    try {
      const response = await this.client.openSession(workItemId, metaId, { signal: this.lifetime.signal });
      if (this.stopped || this.state.selectedWorkItemId !== workItemId) return;
      this.state.setWorkItemData(response.details);
      this.state.setNotice(response.action === 'continued' ? 'Continued the conversation in Herdr.' : null);
      this.dashboardPoller.refresh();
    } catch (error) {
      if (this.stopped || this.state.selectedWorkItemId !== workItemId) return;
      this.state.setNotice(null);
      if (isOffline(error)) this.state.setOffline();
      else this.state.setError(errorMessage(error, 'Opening the session failed'));
    } finally {
      this.opening = false;
    }
  }
}

function padColumn(lines: string[], height: number): string[] {
  if (lines.length === height) return lines;
  if (lines.length > height) return lines.slice(0, height);
  const out = [...lines];
  while (out.length < height) out.push('');
  return out;
}
