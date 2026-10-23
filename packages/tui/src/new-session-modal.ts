import type { Component, Editor, TuiAltScreen, TuiMouseEvent, TuiMouseEventResult } from '@earendil-works/pi-tui';
import { isKeyRelease, matchesKey } from '@earendil-works/pi-tui';
import { fitEditorLines, linkCell, PasteTracker, replaceEditorText, safeText, wrap } from '@lovelace/tui-components';
import type { AppState } from './state.js';
import { accent, bold, canvas, cardBg, danger, muted, reset, selectedBg } from './theme.js';
import { clickable, type ClickTarget } from './clickable.js';
import { dialogEditor } from './dialog-editor.js';
import { LAUNCH_FIELDS, LaunchOptionsRow, type LaunchField } from './launch-options.js';

const control = (text: string, data: string) => clickable(text, { kind: 'modal', data });

type ModalFocus = 'prompt' | LaunchField | 'actions';
const focusOrder: ModalFocus[] = ['prompt', ...LAUNCH_FIELDS, 'actions'];
const isLaunchField = (focus: ModalFocus): focus is LaunchField => (LAUNCH_FIELDS as readonly string[]).includes(focus);

interface NewSessionModalOptions {
  tui: TuiAltScreen;
  state: AppState;
  onClose: () => void;
  onStart: (prompt: string) => Promise<void>;
}

/**
 * One more agent session on the selected work item: a prompt above the shared
 * agent, thinking and model fields. The session reuses the item's ready
 * worktrees; repositories are chosen when work starts, not here.
 */
export class NewSessionModal implements Component {
  focused = true;
  focus: ModalFocus = 'prompt';
  readonly editor: Editor;
  readonly launchOptions: LaunchOptionsRow;
  launching = false;
  error: string | null = null;
  private actionIndex = 0;
  private promptRows = 5;
  private closed = false;
  private readonly paste = new PasteTracker();
  private readonly draftKey: string;
  private readonly title: string;

  constructor(private readonly options: NewSessionModalOptions) {
    this.draftKey = options.state.draftKey;
    this.title = options.state.selectedWorkItemData?.workItem.title ?? '';
    this.launchOptions = new LaunchOptionsRow(options.state);
    this.editor = dialogEditor(options.tui, () => this.promptRows);
    this.editor.onChange = () => {
      if (this.active) options.state.setDraftForKey(this.draftKey, { text: this.editor.getExpandedText() });
    };
    replaceEditorText(this.editor, options.state.draft.text);
  }

  private get active(): boolean {
    return !this.closed && this.options.state.draftKey === this.draftKey;
  }

  private changed(): void { if (this.active) this.options.tui.requestRender(); }

  async start(): Promise<void> {
    if (!this.active || this.launching) return;
    if (!this.editor.getExpandedText().trim()) {
      this.error = 'Write a prompt before starting the session.';
      this.focus = 'prompt';
      this.changed();
      return;
    }
    this.launching = true;
    this.error = null;
    this.changed();
    try {
      await this.options.onStart(this.editor.getExpandedText());
      if (this.active) this.error = this.options.state.error;
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
    this.editor.focused = false;
  }

  invalidate(): void { this.editor.invalidate(); }

  /** Clicked controls arrive as links; see `control`. */
  openLink(link: ClickTarget): void {
    if (!this.active || link.kind !== 'modal') return;
    const field = this.launchOptions.openLink(link.data);
    if (field) this.focus = field;
    else if (link.data === 'focus:prompt') this.focus = 'prompt';
    else if (link.data === 'start') { this.focus = 'actions'; this.actionIndex = 0; void this.start(); }
    else if (link.data === 'cancel') { this.close(); return; }
    this.changed();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== 'wheel' || !this.active || this.focus !== 'prompt') return undefined;
    this.editor.handleInput((event.wheelDelta ?? 0) < 0 ? '\x1b[A' : '\x1b[B');
    this.changed();
    return { handled: true };
  }

  handleInput(data: string): void {
    if (!this.active || isKeyRelease(data)) return;
    if (this.focus === 'prompt' && this.paste.feed(data)) {
      this.editor.handleInput(data);
      this.changed();
      return;
    }
    if (matchesKey(data, 'ctrl+s') || matchesKey(data, 'ctrl+enter')) { void this.start(); return; }
    // Select fields take their keys first; Tab, Esc and keys of a closed field fall through.
    if (isLaunchField(this.focus) && this.launchOptions.handleInput(this.focus, data)) { this.changed(); return; }
    if (matchesKey(data, 'escape')) { this.close(); return; }
    if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
      const delta = matchesKey(data, 'shift+tab') ? -1 : 1;
      this.focus = focusOrder[(focusOrder.indexOf(this.focus) + delta + focusOrder.length) % focusOrder.length]!;
    } else if (this.focus === 'prompt') {
      this.editor.handleInput(matchesKey(data, 'enter') ? '\n' : data);
    } else if (this.focus === 'actions') {
      if (matchesKey(data, 'left') || matchesKey(data, 'right')) this.actionIndex = 1 - this.actionIndex;
      else if (matchesKey(data, 'enter')) {
        if (this.actionIndex) this.close();
        else void this.start();
      }
    }
    this.changed();
  }

  render(width: number): string[] {
    const height = Math.max(8, Math.min(24, this.options.tui.terminal.rows - 2));
    const innerWidth = Math.max(1, width - 4);
    const field = this.focused && isLaunchField(this.focus) ? this.focus : undefined;
    const launch = this.launchOptions.render(innerWidth, field);
    // Short dialogs drop the separators and the prompt label.
    const compact = height < 16;
    // Frame, title, actions, status and the prompt's own border take seven rows.
    this.promptRows = Math.max(1, height - (compact ? 7 : 10) - launch.length);
    this.editor.focused = this.focused && this.focus === 'prompt';
    this.editor.borderColor = text => (this.focus === 'prompt' ? accent : muted) + text + reset;
    const action = (label: string, index: number) => control(
      (this.focus === 'actions' && this.actionIndex === index ? selectedBg : '') + accent + `[ ${label} ]` + reset, index ? 'cancel' : 'start');
    const separator = compact ? [] : [muted + '├' + '─'.repeat(Math.max(0, width - 2)) + '┤' + reset];
    const prompt = this.focus === 'prompt' ? fitEditorLines(this.editor.render(innerWidth), this.promptRows + 2)
      : this.renderPreview(innerWidth).map(line => control(line, 'focus:prompt'));
    const status = this.error ?? (this.launching ? 'Saving the launch request…' : this.help(innerWidth));
    const lines = [
      muted + '╭' + '─'.repeat(Math.max(0, width - 2)) + '╮' + reset,
      this.row(bold + 'New session' + reset + '  ' + safeText(this.title), innerWidth),
      ...separator,
      ...(compact ? [] : [this.row(bold + 'Prompt' + reset, innerWidth)]),
      ...prompt.map(line => this.row(line, innerWidth)),
      ...launch.map(line => this.row(line, innerWidth)),
      ...separator,
      this.row(action(this.launching ? 'Starting…' : 'Start session', 0) + '  ' + action('Cancel', 1), innerWidth),
      this.row((this.error ? danger : muted) + safeText(status) + reset, innerWidth),
      muted + '╰' + '─'.repeat(Math.max(0, width - 2)) + '╯' + reset,
    ];
    // A raised surface over the page.
    return lines.map(line => canvas(line, width, cardBg));
  }

  private renderPreview(width: number): string[] {
    const preview = wrap(this.editor.getExpandedText(), Math.max(1, width - 2));
    return [muted + '─'.repeat(width) + reset,
      ...Array.from({ length: this.promptRows }, (_, row) => ' ' + (preview[row] ?? '')),
      muted + '─'.repeat(width) + reset];
  }

  private row(content: string, width: number): string {
    return muted + '│' + reset + ' ' + linkCell(content, width) + ' ' + muted + '│' + reset;
  }

  private help(width: number): string {
    const start = width < 60 ? '^S start' : 'Ctrl+S start';
    if (this.focus === 'prompt') return `Enter newline · Tab next · ${start} · Esc cancel`;
    if (isLaunchField(this.focus) && this.launchOptions.openField) return '↑/↓ move · Enter choose · type filter · Esc close';
    if (isLaunchField(this.focus)) return `Enter open · type search · Tab next · ${start} · Esc cancel`;
    return `←/→ choose · Enter apply · Tab next · Esc cancel`;
  }
}
