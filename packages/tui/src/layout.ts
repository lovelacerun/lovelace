export const SIDEBAR_WIDTH_WIDE = 40;
export const SIDEBAR_WIDE_COLS = 160;
export const SIDEBAR_WIDTH_FULL = 34;
export const SIDEBAR_FULL_COLS = 120;
export const SIDEBAR_WIDTH_NARROW = 26;
/** Below this the sidebar hides and Home lists active work instead. */
export const SIDEBAR_MIN_COLS = 80;
/** Phone-sized terminals still get the full app. */
export const MIN_WIDTH = 36;
export const MIN_HEIGHT = 10;
/** Bounds for a sidebar resized with the mouse. */
export const SIDEBAR_MIN_WIDTH = 12;
export const CONTENT_MIN_WIDTH = 36;
/** Body rows below which views drop spacing and show one row per entry. */
export const COMPACT_ROWS = 26;
/** Body rows below which the unfocused Quick start dock collapses to one row. */
export const DOCK_MIN_ROWS = 16;

/** Sidebar width until the divider is dragged; 0 hides it. */
export function responsiveSidebarWidth(cols: number): number {
  return cols >= SIDEBAR_WIDE_COLS ? SIDEBAR_WIDTH_WIDE
    : cols >= SIDEBAR_FULL_COLS ? SIDEBAR_WIDTH_FULL
    : cols >= SIDEBAR_MIN_COLS ? SIDEBAR_WIDTH_NARROW : 0;
}

/** Content gutter on each side; generous when there is room. */
export function contentGutter(width: number): number {
  return width >= 90 ? 4 : width >= 60 ? 3 : width >= 44 ? 2 : 1;
}
