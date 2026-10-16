import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createPacResolver } from 'pac-resolver';
import { QuickJS } from 'quickjs-wasi';

const execFile = promisify(execFileCallback);
const DEFAULT_TARGET_URL = 'https://api.atlassian.com/';

interface MacOSSystemProxySettings {
  httpEnabled: boolean;
  httpHost?: string;
  httpPort?: number;
  httpsEnabled: boolean;
  httpsHost?: string;
  httpsPort?: number;
  pacEnabled: boolean;
  pacUrl?: string;
}

export function parseMacOSSystemProxySettings(output: string): MacOSSystemProxySettings {
  const values = new Map<string, string>();
  for (const match of output.matchAll(/^\s*([A-Za-z][A-Za-z0-9]*)\s*:\s*(.*?)\s*$/gm)) {
    values.set(match[1]!, match[2]!);
  }

  return {
    httpEnabled: values.get('HTTPEnable') === '1',
    httpHost: values.get('HTTPProxy'),
    httpPort: parsePort(values.get('HTTPPort')),
    httpsEnabled: values.get('HTTPSEnable') === '1',
    httpsHost: values.get('HTTPSProxy'),
    httpsPort: parsePort(values.get('HTTPSPort')),
    pacEnabled: values.get('ProxyAutoConfigEnable') === '1',
    pacUrl: values.get('ProxyAutoConfigURLString'),
  };
}

export async function resolveMacOSSystemProxy(
  targetUrl = DEFAULT_TARGET_URL,
  dependencies: {
    readSettings?: () => Promise<string>;
    fetchPac?: (url: string) => Promise<string>;
    evaluatePac?: (source: string, url: string) => Promise<string>;
  } = {},
): Promise<string | null> {
  const settingsOutput = await (dependencies.readSettings ?? readSystemProxySettings)();
  const settings = parseMacOSSystemProxySettings(settingsOutput);

  if (settings.pacEnabled && settings.pacUrl) {
    const source = await (dependencies.fetchPac ?? fetchPacFile)(settings.pacUrl);
    const result = await (dependencies.evaluatePac ?? evaluatePacFile)(source, targetUrl);
    return proxyUrlFromPacResult(result);
  }

  if (settings.httpsEnabled && settings.httpsHost && settings.httpsPort) {
    return formatProxyUrl('http', settings.httpsHost, settings.httpsPort);
  }
  if (settings.httpEnabled && settings.httpHost && settings.httpPort) {
    return formatProxyUrl('http', settings.httpHost, settings.httpPort);
  }
  return null;
}

export function proxyUrlFromPacResult(result: string): string | null {
  for (const entry of result.split(';')) {
    const [kind, address] = entry.trim().split(/\s+/, 2);
    switch (kind?.toUpperCase()) {
      case 'DIRECT':
        return null;
      case 'PROXY':
      case 'HTTP':
        return address ? `http://${address}` : null;
      case 'HTTPS':
        return address ? `https://${address}` : null;
    }
  }
  return null;
}

async function readSystemProxySettings(): Promise<string> {
  const { stdout } = await execFile('/usr/sbin/scutil', ['--proxy'], { timeout: 2_000 });
  return stdout;
}

async function fetchPacFile(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) {
    throw new Error(`system PAC request failed (${response.status})`);
  }
  return response.text();
}

async function evaluatePacFile(source: string, targetUrl: string): Promise<string> {
  const quickjs = await QuickJS.create();
  try {
    const resolver = createPacResolver(quickjs, source);
    return await resolver(targetUrl);
  } finally {
    quickjs.dispose();
  }
}

function formatProxyUrl(protocol: 'http' | 'https', host: string, port: number): string {
  const normalizedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${protocol}://${normalizedHost}:${port}`;
}

function parsePort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

async function main(): Promise<void> {
  try {
    console.log((await resolveMacOSSystemProxy(process.argv[2])) ?? 'DIRECT');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Could not resolve the macOS system proxy: ${message}`);
    console.log('DIRECT');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
