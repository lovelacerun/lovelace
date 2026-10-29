import type { Editor } from '@earendil-works/pi-tui';
import { getKeybindings, matchesKey, visibleWidth } from '@earendil-works/pi-tui';
import { fitEditorLines, replaceEditorText, safeText, truncate } from '@lovelace/tui-components';
import type { AppState } from './state.js';
import { accent, faint, heading, icons, muted, reset } from './theme.js';
import { DOCK_MIN_ROWS } from './layout.js';
import { launchField, LaunchOptionsRow } from './launch-options.js';

/**
 * The Home-only Quick start dock: three input lines above the agent,
 * thinking and model fields (whose lists expand below them), or a single
 * row on short terminals until it is focused.
 */
export class QuickStartDock {
  readonly launchOptions: LaunchOptionsRow;
  /** First content row of the dock, and of its launch fields below the editor. */
  private editorTop = Infinity;
  private optionsTop = Infinity;

  constructor(private readonly state: AppState, readonly editor: Editor, private readonly launch: (prompt: string) => void) {
    // Built-in submit trims and clears before onSubmit. Own submission instead.
    editor.disableSubmit = true;
    // Only ever update the text field, never the pending launch, from a keystroke.
    editor.onChange = () => state.setDraft({ text: editor.getExpandedText() });
    this.launchOptions = new LaunchOptionsRow(state);
  }

  /** The dock's rows at the bottom of a content column `height` rows tall; none away from Home. */
  render(width: number, roomy: boolean, height: number): string[] {
    const lines = this.renderLines(width, roomy, height);
    this.editorTop = lines.length ? height - lines.length : Infinity;
    return lines;
  }

  private renderLines(width: number, roomy: boolean, height: number): string[] {
    this.optionsTop = Infinity;
    if (this.state.route.kind !== 'home') return [];
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
    this.optionsTop = height - options.length;
    return [...(roomy ? [''] : []), title, ...fitEditorLines(this.editor.render(width), 5), ...options];
  }

  /** What a click on content row `y` landed on. */
  hit(y: number): 'options' | 'editor' | undefined {
    if (y >= this.optionsTop) return 'options';
    if (y >= this.editorTop) return 'editor';
    return undefined;
  }

  /** Enter launches; legacy terminals use backslash+Enter for a newline. */
  handleInput(data: string): void {
    if (getKeybindings().matches(data, 'tui.input.submit') && data !== '\n') {
      const cursor = this.editor.getCursor();
      if (matchesKey(data, 'enter') && this.editor.getLines()[cursor.line]?.[cursor.col - 1] === '\\') {
        this.editor.handleInput('\x7f');
        this.editor.insertTextAtCursor('\n');
      } else {
        this.launch(this.editor.getExpandedText());
      }
      return;
    }
    this.editor.handleInput(data);
  }

  /** Reconcile the Editor buffer with the active draft without re-entering onChange. */
  sync(): void {
    const text = this.state.draft.text;
    // Restored large drafts retain native paste-marker performance.
    if (this.editor.getExpandedText() !== text) replaceEditorText(this.editor, text, true);
  }
}
