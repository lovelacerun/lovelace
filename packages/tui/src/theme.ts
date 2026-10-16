import type { EditorTheme } from '@earendil-works/pi-tui';
import { padRight, type LinkCardTheme, type SplitPaneTheme } from '@lovelace/tui-components';

export type ThemeMode = 'dark' | 'light';

/** Configurable colour roles; text roles are foregrounds, the rest backgrounds. */
export const COLOR_TOKENS = [
  'background', 'foreground', 'panel', 'bar', 'card', 'selection', 'jiraCard', 'prCard',
  'muted', 'faint', 'accent', 'key', 'success', 'warning', 'danger', 'special',
] as const;
export type ColorToken = typeof COLOR_TOKENS[number];
/** `#rrggbb`, or null for the terminal's own default colour. */
export type Palette = Record<ColorToken, string | null>;

/** Gruvbox, dark and light. */
export const PALETTES: Record<ThemeMode, Palette> = {
  dark: {
    background: '#282828', foreground: '#ebdbb2', panel: '#1d2021', bar: '#3c3836', card: '#32302f', selection: '#504945',
    jiraCard: '#343a3a', prCard: '#363a2e',
    muted: '#a89984', faint: '#7c6f64', accent: '#83a598', key: '#fabd2f',
    success: '#b8bb26', warning: '#fe8019', danger: '#fb4934', special: '#d3869b',
  },
  light: {
    background: '#fbf1c7', foreground: '#3c3836', panel: '#f9f5d7', bar: '#ebdbb2', card: '#f2e5bc', selection: '#d5c4a1',
    jiraCard: '#e6e3c8', prCard: '#eae6bf',
    muted: '#7c6f64', faint: '#a89984', accent: '#076678', key: '#b57614',
    success: '#79740e', warning: '#af3a03', danger: '#9d0006', special: '#8f3f71',
  },
};

const sgr = (layer: 38 | 48, hex: string | null): string => {
  if (!hex) return layer === 38 ? '\x1b[39m' : '\x1b[49m';
  const value = Number.parseInt(hex.slice(1), 16);
  return `\x1b[${layer};2;${value >> 16 & 255};${value >> 8 & 255};${value & 255}m`;
};

export const bold = '\x1b[1m';
export const reset = '\x1b[0m';

// Live bindings: `useTheme` reassigns them, and importers see the new values.
export let accent = '', keyColor = '', success = '', warning = '', danger = '', special = '';
/** Secondary text; `faint` is quieter still, for separators and counts. */
export let muted = '', faint = '';
/** The app's own canvas, so a light theme works in a dark terminal and vice versa. */
export let appBg = '', appFg = '';
/** Header and footer bars; the navigation panel; raised cards and dialogs; the focused selection. */
export let barBg = '', panelBg = '', cardBg = '', selectedBg = '';
/** Quiet provider-specific surfaces, distinct from the focused selection. */
export let jiraCardBg = '', prCardBg = '';

/** Apply `mode`'s palette with operator `overrides` (`#rrggbb`, or `none` for the terminal default). */
export function useTheme(mode: ThemeMode, overrides: Record<string, string> = {}): void {
  const palette = { ...PALETTES[mode] };
  for (const token of COLOR_TOKENS) {
    if (Object.hasOwn(overrides, token)) palette[token] = overrides[token] === 'none' ? null : overrides[token]!;
  }
  [appBg, appFg] = [sgr(48, palette.background), sgr(38, palette.foreground)];
  [barBg, panelBg, cardBg, selectedBg] = [sgr(48, palette.bar), sgr(48, palette.panel), sgr(48, palette.card), sgr(48, palette.selection)];
  [jiraCardBg, prCardBg] = [sgr(48, palette.jiraCard), sgr(48, palette.prCard)];
  [muted, faint, accent, keyColor] = [sgr(38, palette.muted), sgr(38, palette.faint), sgr(38, palette.accent), sgr(38, palette.key)];
  [success, warning, danger, special] = [sgr(38, palette.success), sgr(38, palette.warning), sgr(38, palette.danger), sgr(38, palette.special)];
}
useTheme('dark');

const colored = (text: string, color: string): string => color + text + reset;

/** Paint `text` on `background` across `width`, resumed after resets inside `text`. */
export const band = (text: string, width: number, background: string): string =>
  background + padRight(text.replaceAll(reset, reset + background), width) + reset;

/**
 * Paint a full line on the app canvas: theme background and foreground,
 * restored after full and partial colour resets inside `text`.
 */
export function canvas(text: string, width: number, background = appBg): string {
  const base = background + appFg;
  return base + padRight(text, width).replaceAll(reset, reset + base)
    .replaceAll('\x1b[39m', appFg).replaceAll('\x1b[49m', background) + reset;
}

/** The focused selection's band across `width`; text keeps its own colour. */
export const selectedBand = (text: string, width: number): string => band(text, width, selectedBg);

const linkCardTheme = (background: () => string): LinkCardTheme => ({
  background: text => background() + text + reset,
  selectedBackground: text => selectedBg + text + reset,
  selectedMarker: text => colored(text, accent),
  get linkGlyph() { return icons.link; },
});
export const jiraCardTheme = linkCardTheme(() => jiraCardBg);
export const prCardTheme = linkCardTheme(() => prCardBg);

/** The divider stays faint and lights up while it is dragged. */
export const splitPaneTheme: SplitPaneTheme = { divider: text => colored(text, faint), dragging: text => colored(text, accent) };

/** Sentence-case section label with optional quiet metadata, e.g. "Pending Jira  2". */
export const heading = (label: string, meta?: string | number, glyph = ''): string =>
  (glyph ? muted + glyph + reset + '  ' : '') + bold + label + reset +
  (meta === undefined || meta === '' ? '' : '  ' + faint + meta + reset);

/** Small-caps style group label for the navigation panel, e.g. "ACTIVE WORK  5". */
export const groupLabel = (label: string, meta?: string | number): string =>
  muted + label.toUpperCase() + reset + (meta === undefined || meta === '' ? '' : '  ' + faint + meta + reset);

export const editorTheme: EditorTheme = {
  borderColor: text => colored(text, faint),
  selectList: {
    selectedPrefix: text => colored(text, accent),
    selectedText: text => colored(text, accent),
    description: text => colored(text, muted),
    scrollInfo: text => colored(text, muted),
    noMatch: text => colored(text, muted),
  },
};

export type IconSet = 'nerd' | 'unicode';

const UNICODE = {
  app: '◆', home: '⌂', work: '◉', jira: '◆', pr: '↗', recent: '◷', pending: '○', quickStart: '›', new: '+',
  session: '▸', description: '≡', state: '◌', link: '↗', warning: '!', offline: '×', online: '●',
  check: '✓', cross: '×', open: '○', draft: '◇', merged: '✓', closed: '×', waiting: '○', unknown: '?',
  active: '◉', todo: '○', resume: '▸', done: '✓', cancel: '×', retry: '↻', start: '▸',
  checkboxOn: '[x]', checkboxOff: '[ ]',
};

/** Hack/Nerd Font codepoints (Octicons, Font Awesome, Material Design), each one cell wide. */
const NERD: typeof UNICODE = {
  app: '\uF0E7', home: '\u{F02DC}', work: '\uF418', jira: '\u{F0303}', pr: '\uF407', recent: '\u{F02DA}',
  pending: '\uF48D', quickStart: '\uF489', new: '\uF067', session: '\u{F06A9}', description: '\uF4AD', state: '\uF444',
  link: '\uF08E', warning: '\uF071', offline: '\u{F05AA}', online: '\uF444',
  check: '\uF42E', cross: '\uF467', open: '\uF407', draft: '\uF4DD', merged: '\uF419', closed: '\uF4DC',
  waiting: '\uF43A', unknown: '\uF128', active: '\uF192', todo: '\uF10C', resume: '\uF04B', done: '\uF42E',
  cancel: '\uF05E', retry: '\uF46A', start: '\uF04B',
  checkboxOn: '\u{F0132}', checkboxOff: '\u{F0131}',
};

/** Glyphs for the current icon set; Unicode until `useIcons` picks one. */
export const icons = { ...UNICODE };

export function useIcons(set: IconSet): void {
  Object.assign(icons, set === 'nerd' ? NERD : UNICODE);
}
