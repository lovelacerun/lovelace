import { ProcessTerminal, TuiAltScreen } from '@earendil-works/pi-tui';
import { LovelaceClient } from '@lovelace/client';
import type { SidebarSide } from '@lovelace/core';

import { AppRoot } from './app.js';
import { getAppearance, getServerUrl } from './config.js';
import { useIcons, useTheme, type IconSet, type ThemeMode } from './theme.js';

interface ParsedArgs {
  sidebarSide?: SidebarSide;
  icons?: IconSet;
  theme?: ThemeMode;
  url: string;
  /** True when the user asked for --help / -h; the caller should print and exit. */
  help?: boolean;
}

/**
 * Parse the subset of CLI arguments the TUI understands. Rejects non-loopback
 * URLs because the daemon only speaks on 127.0.0.1 by default. Pure — never
 * prints or exits; the caller is responsible for handling `help`.
 */
export function parseArgs(argv: readonly string[], defaults: { url: string }): ParsedArgs {
  let sidebarSide: SidebarSide | undefined;
  let icons: IconSet | undefined;
  let theme: ThemeMode | undefined;
  let url = defaults.url;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--sidebar' || arg === '--sidebar-side') {
      const value = argv[++i];
      if (value !== 'left' && value !== 'right') {
        throw new Error(`--sidebar expects 'left' or 'right' (got ${JSON.stringify(value)})`);
      }
      sidebarSide = value;
    } else if (arg === '--icons') {
      const value = argv[++i];
      if (value !== 'nerd' && value !== 'unicode') {
        throw new Error(`--icons expects 'nerd' or 'unicode' (got ${JSON.stringify(value)})`);
      }
      icons = value;
    } else if (arg === '--theme') {
      const value = argv[++i];
      if (value !== 'dark' && value !== 'light') {
        throw new Error(`--theme expects 'dark' or 'light' (got ${JSON.stringify(value)})`);
      }
      theme = value;
    } else if (arg === '--url') {
      const value = argv[++i];
      if (!value) throw new Error('--url requires a value');
      url = value;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg) {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }
  // Loopback validation. Credentials in the URL are rejected: the loopback
  // daemon does not accept HTTP Basic auth and leaking creds into argv is
  // easy to do by accident.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`--url must be a valid URL (got ${url})`);
  }
  if (parsed.protocol !== 'http:') {
    throw new Error(`--url must use the http:// protocol (got ${parsed.protocol}//)`);
  }
  // WHATWG URL hostnames are lowercase and keep IPv6 brackets.
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error(`--url must point at loopback (127.0.0.1, localhost, ::1) — got ${parsed.hostname}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('--url must not include credentials');
  }
  return { sidebarSide, icons, theme, url, help };
}

function helpText(): string {
  return [
    'lovelace-tui — terminal UI for the Lovelace daemon',
    '',
    'Usage: lovelace-tui [--sidebar left|right] [--icons nerd|unicode] [--theme dark|light] [--url http://host:port]',
    '',
    'Env:',
    '  LOVELACE_PORT   Override daemon port (default 27421).',
    '  LOVELACE_HOST   Override daemon host (default 127.0.0.1).',
    '  LOVELACE_TUI_ICONS  nerd (Nerd Font, default) or unicode.',
    '  LOVELACE_TUI_THEME  dark (Gruvbox, default) or light.',
    '',
  ].join('\n');
}

export async function runTui(argv: readonly string[]): Promise<void> {
  // Help/noninteractive rejection must not load provider credentials from config.
  const passive = argv.includes('--help') || argv.includes('-h') || !process.stdin.isTTY || !process.stdout.isTTY;
  const parsed = parseArgs(argv, { url: passive ? 'http://127.0.0.1:27421' : getServerUrl() });
  if (parsed.help) {
    process.stdout.write(helpText());
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('lovelace-tui requires a TTY. Launch from an interactive terminal.\n');
    process.exitCode = 1;
    return;
  }
  const appearance = getAppearance();
  const theme = parsed.theme ?? appearance.theme;
  useIcons(parsed.icons ?? appearance.icons);
  useTheme(theme, appearance.colors?.[theme]);
  const terminal = new ProcessTerminal();
  // Clicked OSC 8 links (rows, help chips, provider URLs) route through the app.
  let root: AppRoot | undefined;
  const tui = new TuiAltScreen(terminal, undefined, undefined, { openUrl: url => root?.openLink(url) });
  const client = new LovelaceClient(parsed.url);
  root = new AppRoot({ tui, client, sidebarSide: parsed.sidebarSide });
  tui.setLayoutRoot(root);

  const onSignal = () => {
    root.quit();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    await root.start();
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    root.stop();
  }
}
