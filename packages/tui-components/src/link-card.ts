import { hyperlink, Text, type Component } from '@earendil-works/pi-tui';
import { Card } from './card.js';

export interface LinkCardTheme {
  background: (text: string) => string;
  selectedBackground: (text: string) => string;
  selectedMarker: (text: string) => string;
  /** Glyph before the first line of a linked, unselected card. Default `↗`. */
  linkGlyph?: string;
}

/**
 * A card that opens `url` when clicked anywhere (OSC 8). The first line is
 * marked `↗` (or `linkGlyph`), or `›` on the selected surface. Without a URL it is a plain card.
 * Callers validate the URL; this component only links it.
 */
export class LinkCard implements Component {
  private readonly card: Card;
  private selected = false;

  constructor(private readonly lines: string[], private readonly url: string | undefined, private readonly theme: LinkCardTheme) {
    this.card = new Card({ background: theme.background });
    this.update();
  }

  setSelected(selected: boolean): void { this.selected = selected; this.update(); }
  invalidate(): void { this.card.invalidate(); }

  render(width: number): string[] {
    const lines = this.card.render(width);
    return this.url ? lines.map(line => hyperlink(line, this.url!)) : lines;
  }

  private update(): void {
    const marker = this.selected ? this.theme.selectedMarker('›') + ' ' : this.url ? (this.theme.linkGlyph ?? '↗') + ' ' : '';
    this.card.setTheme({ background: this.selected ? this.theme.selectedBackground : this.theme.background });
    this.card.clear();
    for (const [index, line] of this.lines.entries()) this.card.addChild(new Text((index ? '' : marker) + line, 0, 0));
  }
}
