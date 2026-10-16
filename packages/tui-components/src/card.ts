import { Box, type Component, type TuiMouseEventResult, type TuiMouseEvent } from '@earendil-works/pi-tui';

const RESET = '\x1b[0m';
// One unpainted outside margin, two padding cells inside each side.
const MARGIN = 1;
const PADDING_X = 2;

export interface CardTheme {
  background: (text: string) => string;
}

/** Re-open the surface after every full reset inside styled content. */
const surface = (background: (text: string) => string) =>
  (text: string): string => text.split(RESET).map(background).join('');

/**
 * Borderless padded surface with an unpainted margin, like a `Box` that keeps
 * its background behind children that reset their own styles.
 */
export class Card implements Component {
  private readonly box: Box;

  constructor(theme: CardTheme) {
    this.box = new Box(PADDING_X, 1, surface(theme.background));
  }

  /** Width available to children of a card rendered at `width`. */
  static contentWidth(width: number): number { return Math.max(1, width - 2 * (MARGIN + PADDING_X)); }

  addChild(component: Component): void { this.box.addChild(component); }
  clear(): void { this.box.clear(); }
  setTheme(theme: CardTheme): void { this.box.setBgFn(surface(theme.background)); }
  invalidate(): void { this.box.invalidate(); }

  render(width: number): string[] {
    const margin = ' '.repeat(MARGIN);
    return this.box.render(Math.max(1, width - 2 * MARGIN)).map(line => margin + line + margin);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.x < MARGIN || event.x >= event.width - MARGIN) return undefined;
    return this.box.handleMouse({ ...event, x: event.x - MARGIN, width: Math.max(1, event.width - 2 * MARGIN) });
  }
}
