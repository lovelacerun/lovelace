import type { TUI, TuiAltScreen } from '@earendil-works/pi-tui';
import { Editor } from '@earendil-works/pi-tui';
import { editorTheme } from './theme.js';

/**
 * A submit-less Editor for a dialog's prompt box. Its native viewport is 30%
 * of terminal rows; size that viewport to `rows()` without changing the real
 * terminal or renderer.
 */
export function dialogEditor(tui: TuiAltScreen, rows: () => number): Editor {
  const terminal = new Proxy(tui.terminal, {
    get: (target, key) => key === 'rows' ? Math.ceil(rows() / 0.3) : Reflect.get(target, key, target),
  });
  const editorTui = new Proxy(tui, {
    get: (target, key) => key === 'terminal' ? terminal : typeof Reflect.get(target, key, target) === 'function'
      ? Reflect.get(target, key, target).bind(target) : Reflect.get(target, key, target),
  });
  const editor = new Editor(editorTui as TUI, editorTheme, { paddingX: 1 });
  editor.disableSubmit = true;
  return editor;
}
