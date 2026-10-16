import type { Component, TuiMouseEvent, TuiMouseEventResult } from '@earendil-works/pi-tui';
import { linkCell } from './text.js';

/**
 * A draggable split divider. Press on it to capture the pointer, drag to
 * resize, double-click to restore the default size (`size` becomes null).
 */
class ResizableDivider {
  size: number | null = null;
  dragging = false;

  /**
   * `onDivider` tells whether the event hit the divider; `sizeAt` converts the
   * pointer column into a clamped size. Returns undefined for unrelated events.
   */
  handleMouse(event: TuiMouseEvent, onDivider: boolean, sizeAt: (x: number) => number): TuiMouseEventResult | undefined {
    if (!this.dragging && !(onDivider && event.button === 'left')) return undefined;
    if (event.type === 'press') this.dragging = true;
    else if (event.type === 'drag') this.size = sizeAt(event.x);
    else if (event.type === 'release') this.dragging = false;
    else if (event.type === 'click' && (event.clickCount ?? 1) >= 2) this.size = null;
    return { capture: true, render: true };
  }
}

export interface SplitPaneTheme {
  divider: (text: string) => string;
  /** Divider while it is dragged; defaults to `divider`. */
  dragging?: (text: string) => string;
}

export interface SplitPaneOptions {
  /** Edge the secondary pane sits on. Default `end`. */
  side?: 'start' | 'end';
  /** Default secondary width for a total width; 0 or less hides the pane. */
  size: (width: number) => number;
  /** Let the divider be dragged; a double-click restores `size`. */
  resizable?: boolean;
  /** Drag bounds for the secondary and primary panes. Default 1. */
  minSize?: number;
  minPrimarySize?: number;
  /** Blank cells on each side of the divider. Default 0. */
  gap?: number;
}

export interface SplitPaneLayout {
  primaryX: number;
  primaryWidth: number;
  /** 0 when the secondary pane is hidden. */
  secondaryX: number;
  secondaryWidth: number;
  /** Column of the divider glyph, or -1 when hidden. */
  dividerX: number;
}

/**
 * Two components side by side with a one-cell divider, like a pi-tui `HStack`
 * with a resizable fixed-width pane. Shorter panes are padded to the taller
 * one, and every cell is fenced so an OSC 8 link cannot bleed across. Mouse
 * events are forwarded to the pane under the pointer in its own coordinates.
 */
export class SplitPane implements Component {
  private readonly divider = new ResizableDivider();
  private side: 'start' | 'end';

  constructor(
    private readonly primary: Component,
    private readonly secondary: Component,
    private readonly theme: SplitPaneTheme,
    private readonly options: SplitPaneOptions,
  ) {
    this.side = options.side ?? 'end';
  }

  get dragging(): boolean { return this.divider.dragging; }

  setSide(side: 'start' | 'end'): void { this.side = side; }


  layout(width: number): SplitPaneLayout {
    const gap = this.options.gap ?? 0;
    const dividerWidth = 1 + 2 * gap;
    const preferred = this.options.size(width);
    if (preferred <= 0 || width < dividerWidth + 2) {
      return { primaryX: 0, primaryWidth: width, secondaryX: 0, secondaryWidth: 0, dividerX: -1 };
    }
    const dragged = this.options.resizable ? this.divider.size : null;
    const size = dragged === null ? preferred : this.clamp(dragged, width);
    const secondaryWidth = Math.max(1, Math.min(size, width - dividerWidth - 1));
    const primaryWidth = width - secondaryWidth - dividerWidth;
    return this.side === 'start'
      ? { primaryX: secondaryWidth + dividerWidth, primaryWidth, secondaryX: 0, secondaryWidth, dividerX: secondaryWidth + gap }
      : { primaryX: 0, primaryWidth, secondaryX: primaryWidth + dividerWidth, secondaryWidth, dividerX: primaryWidth + gap };
  }

  invalidate(): void {
    this.primary.invalidate();
    this.secondary.invalidate();
  }

  render(width: number): string[] {
    const layout = this.layout(width);
    if (!layout.secondaryWidth) return this.primary.render(width).map(line => linkCell(line, width));
    const primary = this.primary.render(layout.primaryWidth);
    const secondary = this.secondary.render(layout.secondaryWidth);
    const gap = ' '.repeat(this.options.gap ?? 0);
    const style = this.dragging ? this.theme.dragging ?? this.theme.divider : this.theme.divider;
    const divider = gap + style('│') + gap;
    const lines: string[] = [];
    for (let row = 0; row < Math.max(primary.length, secondary.length); row++) {
      const main = linkCell(primary[row] ?? '', layout.primaryWidth);
      const side = linkCell(secondary[row] ?? '', layout.secondaryWidth);
      lines.push(this.side === 'start' ? side + divider + main : main + divider + side);
    }
    return lines;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const layout = this.layout(event.width);
    if (this.options.resizable && layout.secondaryWidth) {
      const gap = this.options.gap ?? 0;
      const sizeAt = (x: number) => this.clamp(this.side === 'start' ? x - gap : event.width - x - 1 - gap, event.width);
      const resize = this.divider.handleMouse(event, event.x === layout.dividerX, sizeAt);
      if (resize) return resize;
    }
    const forward = (pane: Component, x: number, width: number) =>
      event.x >= x && event.x < x + width ? pane.handleMouse?.({ ...event, x: event.x - x, width }) : undefined;
    return forward(this.primary, layout.primaryX, layout.primaryWidth)
      ?? (layout.secondaryWidth ? forward(this.secondary, layout.secondaryX, layout.secondaryWidth) : undefined);
  }

  private clamp(size: number, width: number): number {
    const dividerWidth = 1 + 2 * (this.options.gap ?? 0);
    const max = width - (this.options.minPrimarySize ?? 1) - dividerWidth;
    return Math.max(this.options.minSize ?? 1, Math.min(Math.round(size), max));
  }
}
