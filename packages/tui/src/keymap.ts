import { matchesKey, Key } from '@earendil-works/pi-tui';
import { isLaunchFocus, type FocusTarget } from './state.js';
import type { WorkItemState } from '@lovelace/core';

export type KeyIntent =
  | { kind: 'quit' }
  | { kind: 'refresh' }
  | { kind: 'focus-editor' }
  | { kind: 'tab'; direction?: 1 | -1 }
  | { kind: 'escape' }
  | { kind: 'enter' }
  | { kind: 'up' }
  | { kind: 'down' }
  | { kind: 'state-shortcut'; target: WorkItemState }
  | { kind: 'confirm-y' }
  | { kind: 'abandon-launch' }
  | { kind: 'editor-input'; data: string }
  | { kind: 'ignored' };

interface DecodeContext {
  focus: FocusTarget;
  /** The modal confirm dialog accepts only y, n and Esc. */
  pendingConfirm?: boolean;
}

/**
 * Translate a raw stdin chunk into a semantic intent, honoring focus.
 * The editor owns text input and Enter. Tab/Shift+Tab, Esc and Ctrl+C remain
 * application navigation commands (bracketed paste is handled before decoding).
 */
export function decode(data: string, ctx: DecodeContext): KeyIntent {
  // Hard quit regardless of focus. Editors in pi-tui do not consume Ctrl+C.
  if (matchesKey(data, Key.ctrl('c'))) return { kind: 'quit' };

  if (ctx.pendingConfirm) {
    if (data === 'y' || data === 'Y') return { kind: 'confirm-y' };
    if (matchesKey(data, Key.escape) || data === 'n' || data === 'N') return { kind: 'escape' };
    return { kind: 'ignored' };
  }

  if (matchesKey(data, Key.shift('tab'))) return { kind: 'tab', direction: -1 };
  if (matchesKey(data, Key.tab)) return { kind: 'tab' };

  if (ctx.focus === 'editor') {
    // Esc leaves the editor; Tab cycles focus; everything else is the Editor's.
    if (matchesKey(data, Key.escape)) return { kind: 'escape' };
    return { kind: 'editor-input', data };
  }
  // Launch fields take their own keys first; whatever they leave is not a shortcut.
  if (isLaunchFocus(ctx.focus)) return matchesKey(data, Key.escape) ? { kind: 'escape' } : { kind: 'ignored' };

  if (matchesKey(data, Key.escape)) return { kind: 'escape' };
  if (matchesKey(data, Key.enter)) return { kind: 'enter' };
  if (matchesKey(data, Key.up)) return { kind: 'up' };
  if (matchesKey(data, Key.down)) return { kind: 'down' };

  if (data === 'q' || data === 'Q') return { kind: 'quit' };
  if (data === 'r' || data === 'R') return { kind: 'refresh' };
  if (data === 'x' || data === 'X') return { kind: 'abandon-launch' };
  if (data === 'n' || data === 'N') return { kind: 'focus-editor' };
  if (data === 'j') return { kind: 'down' };
  if (data === 'k') return { kind: 'up' };
  if (data === 'd') return { kind: 'state-shortcut', target: 'done' };
  if (data === 'a') return { kind: 'state-shortcut', target: 'active' };
  if (data === 'c') return { kind: 'state-shortcut', target: 'cancelled' };

  return { kind: 'ignored' };
}
