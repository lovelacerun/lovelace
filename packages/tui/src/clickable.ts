import { hyperlink } from '@earendil-works/pi-tui';

/**
 * Clickable regions are OSC 8 hyperlinks. pi-tui's fullscreen viewport already
 * hit-tests them on click and hands the URL to `openUrl`, so in-app targets
 * only need a private scheme instead of a parallel geometry model. Provider
 * URLs use plain `hyperlink` and open in the browser.
 */
export type ClickTarget =
  | { kind: 'action'; index: number }
  | { kind: 'nav'; index: number }
  | { kind: 'key'; data: string }
  | { kind: 'modal'; data: string };

const SCHEME = 'lovelace:';

export function clickable(text: string, target: ClickTarget): string {
  return hyperlink(text, SCHEME + target.kind + ':' + ('data' in target ? encodeURIComponent(target.data) : target.index));
}

export function parseClickTarget(url: string): ClickTarget | undefined {
  if (!url.startsWith(SCHEME)) return undefined;
  const [kind, value = ''] = url.slice(SCHEME.length).split(':', 2) as [string, string?];
  if (kind === 'key' || kind === 'modal') {
    try { return { kind, data: decodeURIComponent(value) }; } catch { return undefined; }
  }
  const index = Number(value);
  if ((kind === 'action' || kind === 'nav') && Number.isInteger(index) && index >= 0) return { kind, index };
  return undefined;
}
