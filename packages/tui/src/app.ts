import type { Component, OverlayHandle, TuiAltScreen, TuiMouseEvent, TuiMouseEventResult } from '@earendil-works/pi-tui';
import { compositeTuiLine, isKeyRelease, matchesKey, visibleWidth } from '@earendil-works/pi-tui';
import type { LovelaceClient } from '@lovelace/client';
import type { SidebarSide } from '@lovelace/core';

import { AppState } from './state.js';
import { openBrowser } from './browser.js';
import { band, barBg, canvas, bold, accent, muted, faint, icons, panelBg, danger, reset, splitPaneTheme } from './theme.js';
import { LINK_END, padRight, safeText, SplitPane, truncate } from '@lovelace/tui-components';
import {
  COMPACT_ROWS, CONTENT_MIN_WIDTH, contentGutter, MARGIN_MIN_ROWS, MIN_HEIGHT, MIN_WIDTH, responsiveSidebarWidth,
  SIDEBAR_MIN_WIDTH,
} from './layout.js';
import { parseClickTarget } from './clickable.js';
import { connectionStatus, fitChips, helpChips, renderConfirmDialog } from './compositor.js';
import { keyChip } from './key-hints.js';
import { splitIssueKey } from './views/common.js';
import { decode } from './keymap.js';
import { handleKey, handleAction, submitLaunch, type ControllerDeps } from './controller.js';
import { errorMessage } from './errors.js';
import { renderPage } from './views/page.js';
import { renderSidebar } from './views/sidebar.js';
import type { Document } from './views/common.js';
import { LaunchDialog, type LaunchSubject } from './launch-dialog.js';
import { AppRefresh } from './refresh.js';

interface AppRootOptions {
  tui: TuiAltScreen;
  client: LovelaceClient;
  /** The actual client address, shown so a stale port override is visible. */
  serverUrl: string;
  sidebarSide?: SidebarSide;
  /** Injectable browser launcher; tests never open operator browser windows. */
  openUrl?: (url: string) => Promise<void>;
}

/**
 * Root component. Composes sidebar and the current route's page into the
 * terminal viewport, and owns input routing and the launch dialog.
 */
export class AppRoot implements Component {
  readonly state: AppState;
  readonly tui: TuiAltScreen;
  readonly client: LovelaceClient;
  private readonly serverUrl: string;
  /** The open launch dialog, if any. */
  private overlay?: { dialog: LaunchDialog; handle: OverlayHandle };
  private readonly refresh: AppRefresh;
  private removeInputListener?: () => void;
  private quitResolver?: () => void;
  private stopped = false;
  private readonly lifetime = new AbortController();
  private readonly openUrl: (url: string) => Promise<void>;
  /** Size of the last frame's sidebar/content body; 0 while the terminal is too small. */
  private body = { cols: 0, height: 0 };
  /** Content beside the global sidebar, whose divider can be dragged for the session. */
  private readonly split: SplitPane;

  constructor(options: AppRootOptions) {
    this.tui = options.tui;
    this.client = options.client;
    this.serverUrl = options.serverUrl;
    this.openUrl = options.openUrl ?? openBrowser;
    this.state = new AppState({
      sidebarSide: options.sidebarSide,
      onInvalidate: () => { if (!this.stopped) this.tui.requestRender(); },
    });

    this.refresh = new AppRefresh(this.state, this.client, this.lifetime.signal);
    this.split = new SplitPane(
      {
        render: width => this.renderContent(width),
        handleMouse: event => this.handleContentMouse(event),
        invalidate() {},
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
    this.refresh.start();
    return new Promise<void>((resolve) => {
      this.quitResolver = resolve;
    });
  }

  stop(preserveScreen = false): void {
    if (this.stopped) return;
    this.stopped = true;
    this.lifetime.abort();
    this.refresh.stop();
    this.removeInputListener?.();
    this.removeInputListener = undefined;
    this.closeOverlay();
    this.tui.stop({ preserveScreen });
  }

  quit(): void {
    this.stop();
    this.quitResolver?.();
    this.quitResolver = undefined;
  }

  invalidate(): void {
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
    const route = this.state.route;
    const place = route.kind === 'home' ? 'Home'
      : route.kind === 'jira' ? safeText(route.issue.key)
      : route.kind === 'review' ? safeText(`${route.review.repository}#${route.review.number}`)
      : route.details ? splitIssueKey(safeText(route.details.workItem.title)).key ?? safeText(route.details.workItem.title) : 'Work';
    const mark = ' ' + accent + icons.app + reset + '  ' + (cols >= 50 ? bold + 'lovelace' + reset + faint + '  /  ' + reset : '');
    let right = connectionStatus(this.state);
    // The actual client address, so a stale port override is visible.
    if (cols >= 80) right = faint + safeText(this.serverUrl) + reset + '   ' + right;
    const room = cols - visibleWidth(right) - 1;
    const left = padRight(truncate(mark + place, room - 2), room);
    return left + right;
  }

  /** The current page, scrolled to its selection. */
  private renderContent(width: number): string[] {
    const height = this.body.height;
    // Breathing room: a top margin and a generous gutter, dropped first on small screens.
    const gutter = contentGutter(width);
    const top = height >= MARGIN_MIN_ROWS ? [''] : [];
    const document = renderPage(this.state, Math.max(1, width - gutter * 2));
    const viewportHeight = Math.max(0, height - top.length);
    const contentLines = this.applyScroll(document, viewportHeight);
    return padColumn([...top, ...contentLines].map(line => ' '.repeat(gutter) + line), height);
  }

  /** Navigation remains a stable landmark during first load and disconnection. */
  private renderSidebarPane(width: number): string[] {
    const height = this.body.height;
    const sidebar = renderSidebar(this.state, width);
    return padColumn(sidebar.lines.slice(Math.max(0, sidebar.selectedRow - height + 1)), height)
      .map(line => band(line, width, panelBg));
  }

  /** Inset by one cell on each side of the footer bar. */
  private renderBottomBar(width: number): string {
    if (this.state.pendingConfirm) return ' ' + fitChips({ status: '', chips: [keyChip('y', 'confirm'), keyChip('Esc', 'cancel')] }, width);
    if (this.state.offline) {
      const status = `${danger}Offline (${this.state.dashboardData ? 'last-known' : 'no'} data)${reset}`;
      return ' ' + fitChips({ status, chips: [keyChip('r', 'retry'), keyChip('q', 'quit')] }, width);
    }
    return ' ' + fitChips(helpChips(this.state), width);
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
    if (!height || this.stopped || this.overlay || this.state.pendingConfirm) return undefined;
    // The body starts below the header; a captured divider drag continues outside it.
    const y = event.y - 1;
    if ((y < 0 || y >= height) && !this.split.dragging) return undefined;
    return this.split.handleMouse({ ...event, y, width: cols, height });
  }

  private handleContentMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== 'click' || event.button !== 'left') return this.handleWheel(event, 'content');
    return { handled: true };
  }

  /** The wheel moves the selection of the pane under the pointer. */
  private handleWheel(event: TuiMouseEvent, focus: 'sidebar' | 'content'): TuiMouseEventResult | undefined {
    if (event.type !== 'wheel') return undefined;
    if (this.state.focus !== focus) this.state.setFocus(focus);
    this.state.move(Math.sign(event.wheelDelta ?? 0), this.contentActionCount());
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
    if (this.overlay) {
      this.overlay.dialog.openLink(link);
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
    void this.dispatchContentEnter();
  }

  // Input routing ------------------------------------------------------------

  private handleRawInput(data: string): { consume?: boolean } | undefined {
    if (this.stopped) return { consume: true };
    if (this.overlay && !matchesKey(data, 'ctrl+c')) {
      this.overlay.dialog.handleInput(data);
      return { consume: true };
    }
    // Kitty-protocol hosts (e.g. Herdr) also report key releases; only presses act.
    if (isKeyRelease(data)) return { consume: true };
    const intent = decode(data, {
      focus: this.state.focus,
      pendingConfirm: this.state.pendingConfirm !== null,
    });

    if (intent.kind === 'ignored') return undefined;
    if (intent.kind === 'new') {
      this.openLaunchDialog();
      return { consume: true };
    }
    if (intent.kind === 'enter' && this.state.focus !== 'sidebar') {
      void this.dispatchContentEnter();
      return { consume: true };
    }
    if (intent.kind === 'enter') {
      const entry = this.state.sidebarEntries[this.state.sidebarSelectedIndex];
      if (entry) this.state.navigate(entry);
      this.refresh.refreshDetails();
    } else {
      handleKey(this.state, intent, this.makeDeps(), this.contentActionCount());
    }
    return { consume: true };
  }

  private async dispatchContentEnter(): Promise<void> {
    const doc = renderPage(this.state, 80); // width doesn't affect the actions
    const action = doc.actions[this.state.contentSelectedIndex];
    if (!action) return;
    await handleAction(this.state, action, this.makeDeps());
  }

  private contentActionCount(): number {
    return renderPage(this.state, 80).actions.length;
  }

  // Dependencies / helpers --------------------------------------------------

  private makeDeps(): ControllerDeps {
    return {
      client: this.client,
      signal: this.lifetime.signal,
      refreshDashboard: () => this.refresh.refreshDashboard(),
      refreshDetails: () => this.refresh.refreshDetails(),
      openLaunchDialog: () => this.openLaunchDialog(),
      submitLaunch: prompt => this.launch(prompt),
      openUrl: this.openUrl,
      invalidate: () => { if (!this.stopped) this.tui.requestRender(); },
      quit: () => this.quit(),
    };
  }

  /**
   * `n` on any page: new work from Home, work on a Jira issue, a review of a
   * pull request, or another session on an active work item.
   */
  private openLaunchDialog(): void {
    if (this.overlay || this.state.mutationInFlight) return;
    const subject = this.launchSubject();
    if (!subject) return;
    if (this.state.draft.requestId) {
      this.state.setError('Resend or discard (x) the unanswered launch before starting another.');
      return;
    }
    const dialog = new LaunchDialog({
      tui: this.tui, state: this.state, client: this.client, signal: this.lifetime.signal, subject,
      onClose: () => this.closeOverlay(),
      // Failures stay in the dialog to edit or resend.
      onStart: async prompt => { if (await this.launch(prompt)) this.closeOverlay(); },
    });
    const handle = this.tui.showOverlay(dialog, { width: '96%', maxHeight: '96%', margin: 1, anchor: 'center' });
    this.overlay = { dialog, handle };
    void dialog.load();
  }

  private launchSubject(): LaunchSubject | undefined {
    const route = this.state.route;
    if (route.kind === 'home') return { kind: 'home' };
    if (route.kind === 'jira') return { kind: 'issue', issue: route.details ?? route.issue };
    if (route.kind === 'review') {
      if (route.review.repoId) return { kind: 'review', review: route.review, repoId: route.review.repoId };
      this.state.setError(`${route.review.repository} is not in the repository catalog.`);
      return undefined;
    }
    if (!route.details) return undefined;
    if (route.details.workItem.state !== 'active') {
      this.state.setError('Reactivate local work explicitly (press a, then y) before starting a session.');
      return undefined;
    }
    return { kind: 'work', details: route.details };
  }

  private closeOverlay(): void {
    const overlay = this.overlay;
    if (!overlay) return;
    this.overlay = undefined;
    overlay.dialog.dispose();
    overlay.handle.hide();
    if (!this.stopped) {
      this.tui.setFocus(null);
      this.tui.requestRender();
    }
  }

  // Mutations ---------------------------------------------------------------

  private async launch(prompt: string): Promise<boolean> {
    if (this.stopped) return false;
    const accepted = await submitLaunch(this.state, this.makeDeps(), prompt);
    if (this.stopped) return accepted;
    // Accepted launches poll on their work item; no completion callback can
    // navigate away from another draft or task the operator opens meanwhile.
    this.refresh.refreshDetails();
    return accepted;
  }

}

function padColumn(lines: string[], height: number): string[] {
  if (lines.length === height) return lines;
  if (lines.length > height) return lines.slice(0, height);
  const out = [...lines];
  while (out.length < height) out.push('');
  return out;
}
