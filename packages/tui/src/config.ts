import { loadConfig, type LovelaceConfig, type TuiThemeMode } from '@lovelace/core';

/** Use the same root configuration as the CLI/server, including file port. */
export function getServerUrl(): string {
  const config = loadConfig();
  const host = process.env.LOVELACE_HOST ?? '127.0.0.1';
  return `http://${host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host}:${config.port}`;
}

/** Icons, theme and colour overrides from the operator's config and environment. */
export function getAppearance(): { icons: 'nerd' | 'unicode'; theme: TuiThemeMode; colors: LovelaceConfig['tui']['colors'] } {
  const { tui } = loadConfig();
  return { icons: tui.icons ?? 'nerd', theme: tui.theme ?? 'dark', colors: tui.colors };
}
