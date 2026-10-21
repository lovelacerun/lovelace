import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadConfig } from '@lovelace/core';
import { selfInvocation } from './self.js';

const execFileAsync = promisify(execFile);

export const SERVICE_LABEL = 'com.lentfort.lovelace.server';
const USAGE = 'Usage: lovelace service <install|uninstall|restart|status|run>';

export type Launchctl = (args: string[]) => Promise<string>;

const defaultLaunchctl: Launchctl = async (args) => (await execFileAsync('/bin/launchctl', args)).stdout;

export interface ServiceOptions {
  launchctl?: Launchctl;
  plistDir?: string;
  env?: NodeJS.ProcessEnv;
}

export async function service(args: string[], options: ServiceOptions = {}): Promise<unknown> {
  const launchctl = options.launchctl ?? defaultLaunchctl;
  const plistDir = options.plistDir ?? join(homedir(), 'Library', 'LaunchAgents');
  const plistPath = join(plistDir, `${SERVICE_LABEL}.plist`);
  const target = `gui/${process.getuid?.() ?? 501}/${SERVICE_LABEL}`;
  const subcommand = args[0];
  if (subcommand === 'run') return superviseServer(options.env);
  if (process.platform !== 'darwin' && !options.launchctl) throw new Error('lovelace service manages a macOS LaunchAgent; run `lovelace service run` under your own supervisor elsewhere');

  switch (subcommand) {
    case 'install': {
      const config = loadConfig();
      const logDir = join(config.lovelaceDir, 'logs');
      mkdirSync(logDir, { recursive: true });
      mkdirSync(plistDir, { recursive: true });
      writeFileSync(plistPath, renderPlist({ program: [...selfInvocation(options.env), 'service', 'run'], env: options.env ?? process.env, logDir }));
      await launchctl(['bootout', target]).catch(() => undefined);
      await launchctl(['bootstrap', target.slice(0, target.lastIndexOf('/')), plistPath]);
      return { installed: SERVICE_LABEL, plist: plistPath, logs: logDir };
    }
    case 'uninstall':
      await launchctl(['bootout', target]).catch(() => undefined);
      rmSync(plistPath, { force: true });
      return { uninstalled: SERVICE_LABEL };
    case 'restart':
      if (!existsSync(plistPath)) throw new Error(`${SERVICE_LABEL} is not installed; run lovelace service install`);
      await launchctl(['kickstart', '-k', target]);
      return { restarted: SERVICE_LABEL };
    case 'status': {
      const installed = existsSync(plistPath);
      const printed = installed ? await launchctl(['print', target]).catch(() => '') : '';
      const pid = /^\s*pid = (\d+)/m.exec(printed)?.[1];
      return { label: SERVICE_LABEL, installed, loaded: printed !== '', pid: pid ? Number(pid) : null, plist: plistPath };
    }
    default:
      throw new Error(USAGE);
  }
}

/** launchd starts agents with a minimal PATH; keep the installing shell's PATH so agents and tools resolve. */
export function renderPlist({ program, env, logDir }: { program: string[]; env: NodeJS.ProcessEnv; logDir: string }): string {
  const variables = Object.entries({ PATH: env.PATH, LOVELACE_EXECUTABLE: env.LOVELACE_EXECUTABLE })
    .filter((entry): entry is [string, string] => Boolean(entry[1]));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${SERVICE_LABEL}</string>
    <key>WorkingDirectory</key>
    <string>${xml(homedir())}</string>
    <key>ProgramArguments</key>
    <array>
${program.map(arg => `      <string>${xml(arg)}</string>`).join('\n')}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${variables.map(([key, value]) => `      <key>${key}</key>\n      <string>${xml(value)}</string>`).join('\n')}
    </dict>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${xml(join(logDir, 'launchd.log'))}</string>
    <key>StandardErrorPath</key>
    <string>${xml(join(logDir, 'launchd-error.log'))}</string>
  </dict>
</plist>
`;
}

const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const PROXY_VARIABLES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NODE_USE_ENV_PROXY'];

/** Proxy environment for the server: the macOS system proxy (Node reads it only at startup) or none. */
export function serverEnvironment(env: NodeJS.ProcessEnv, proxy: string | null): NodeJS.ProcessEnv {
  const next = Object.fromEntries(Object.entries(env).filter(([key]) => !PROXY_VARIABLES.includes(key)));
  return proxy ? { ...next, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NODE_USE_ENV_PROXY: '1' } : next;
}

/**
 * Runs `lovelace server` as a child and restarts it whenever the macOS system
 * proxy changes (e.g. joining or leaving a VPN), or after it exits.
 */
async function superviseServer(env: NodeJS.ProcessEnv = process.env): Promise<never> {
  const { resolveMacOSSystemProxy } = await import('@lovelace/server');
  const targetUrl = env.LOVELACE_SYSTEM_PROXY_TARGET_URL ?? 'https://api.atlassian.com/';
  const pollMs = (Number(env.LOVELACE_NETWORK_POLL_INTERVAL_SECONDS) || 30) * 1000;
  const resolveProxy = async () => {
    if (process.platform !== 'darwin') return null;
    try {
      return await resolveMacOSSystemProxy(targetUrl);
    } catch (error) {
      console.error(`Could not resolve the macOS system proxy: ${(error as Error).message}`);
      return null;
    }
  };
  const [command, ...prefix] = selfInvocation(env);
  let child: ChildProcess | null = null;
  const stop = () => {
    child?.kill('SIGTERM');
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  process.once('SIGHUP', stop);

  for (;;) {
    const proxy = await resolveProxy();
    console.log(proxy ? 'Starting Lovelace with the macOS system proxy' : 'Starting Lovelace with direct network access');
    const running = spawn(command!, [...prefix, 'server'], { env: serverEnvironment(env, proxy), stdio: 'inherit' });
    child = running;
    const exited = new Promise<void>(resolve => running.once('exit', () => resolve()));
    let alive = true;
    void exited.then(() => { alive = false; });
    while (alive) {
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, pollMs))]);
      if (alive && (await resolveProxy()) !== proxy) {
        console.log('macOS system proxy changed; restarting Lovelace');
        running.kill('SIGTERM');
        await exited;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
