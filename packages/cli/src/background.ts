import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '@lovelace/core';
import { selfInvocation, version } from './self.js';

const USAGE = 'Usage: lovelace server [start|stop|restart|status]';
const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 10_000;

interface ServerStatus { version: string | null; pid: number | null }

export interface BackgroundDeps {
  port: number;
  lovelaceDir: string;
  fetchStatus: (port: number) => Promise<ServerStatus | null>;
  /** Starts the detached supervisor. */
  launch: (lovelaceDir: string) => void;
  isAlive: (pid: number) => boolean;
  kill: (pid: number) => void;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
}

export function backgroundDeps(overrides: Partial<BackgroundDeps> = {}): BackgroundDeps {
  const config = loadConfig();
  return {
    port: config.port,
    lovelaceDir: config.lovelaceDir,
    fetchStatus,
    launch: launchSupervisor,
    isAlive,
    kill: pid => process.kill(pid, 'SIGTERM'),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    // stdout carries JSON for scripts and agents; progress belongs on an interactive stderr.
    log: message => { if (process.stderr.isTTY) process.stderr.write(`${message}\n`); },
    ...overrides,
  };
}

/** `lovelace server start|stop|restart|status`; bare `lovelace server` runs in the foreground instead. */
export async function serverCommand(subcommand: string, deps = backgroundDeps()): Promise<unknown> {
  switch (subcommand) {
    case 'start':
      await ensureServer(deps, {});
      return status(deps);
    case 'stop':
      return { stopped: await stopServer(deps) };
    case 'restart':
      await stopServer(deps);
      await startServerInBackground(deps);
      return status(deps);
    case 'status':
      return status(deps);
    default:
      throw new Error(USAGE);
  }
}

/**
 * Starts the server in the background unless it already answers, and replaces
 * one this CLI started from another version (e.g. after `brew upgrade`). A
 * server running in the foreground is left alone.
 */
export async function ensureServer(deps = backgroundDeps(), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  // Scripts and tests that must never spawn a server opt out; requests then fail as unreachable.
  if (env.LOVELACE_NO_AUTOSTART === '1') return;
  const current = await deps.fetchStatus(deps.port);
  if (current && (current.version === null || current.version === version)) return;
  if (current && !supervisorPid(deps)) return;
  if (current) {
    deps.log(`Restarting the Lovelace server ${current.version} as ${version}…`);
    await stopServer(deps);
  }
  await startServerInBackground(deps);
}

async function startServerInBackground(deps: BackgroundDeps): Promise<void> {
  // A foreground server keeps its port; a second one could never bind it.
  if (await deps.fetchStatus(deps.port)) return;
  deps.log('Starting the Lovelace server…');
  deps.launch(deps.lovelaceDir);
  for (let waited = 0; waited < START_TIMEOUT_MS; waited += 250) {
    if (await deps.fetchStatus(deps.port)) return;
    await deps.sleep(250);
  }
  throw new Error(`The Lovelace server did not start on port ${deps.port}; see ${serverLogPath(deps.lovelaceDir)}`);
}

async function stopServer(deps: BackgroundDeps): Promise<boolean> {
  const pid = supervisorPid(deps);
  if (!pid) return false;
  deps.kill(pid);
  for (let waited = 0; waited < STOP_TIMEOUT_MS; waited += 100) {
    if (!deps.isAlive(pid)) return true;
    await deps.sleep(100);
  }
  throw new Error(`The Lovelace server (pid ${pid}) did not stop`);
}

async function status(deps: BackgroundDeps) {
  const current = await deps.fetchStatus(deps.port);
  return {
    running: Boolean(current), port: deps.port, version: current?.version ?? null, pid: current?.pid ?? null,
    background: supervisorPid(deps) !== null, log: serverLogPath(deps.lovelaceDir),
  };
}

const pidPath = (lovelaceDir: string) => join(lovelaceDir, 'server.pid');
export const serverLogPath = (lovelaceDir: string) => join(lovelaceDir, 'logs', 'server-process.log');

/** The background supervisor's pid when it is alive. */
function supervisorPid(deps: Pick<BackgroundDeps, 'lovelaceDir' | 'isAlive'>): number | null {
  try {
    const pid = Number.parseInt(readFileSync(pidPath(deps.lovelaceDir), 'utf8'), 10);
    return Number.isInteger(pid) && pid > 0 && deps.isAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Claims the pid file for this process; false when another live supervisor holds it. */
export function claimPidFile(lovelaceDir: string, alive = isAlive): boolean {
  mkdirSync(lovelaceDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(pidPath(lovelaceDir), 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (supervisorPid({ lovelaceDir, isAlive: alive })) return false;
      rmSync(pidPath(lovelaceDir), { force: true });
    }
  }
  return false;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function fetchStatus(port: number): Promise<ServerStatus | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return null;
    const body = (await response.json()) as { version?: unknown; pid?: unknown };
    return { version: typeof body.version === 'string' ? body.version : null, pid: typeof body.pid === 'number' ? body.pid : null };
  } catch {
    return null;
  }
}

const INHERITED = /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|LANG|LC_\w+|TZ|SSH_AUTH_SOCK|XDG_\w+|NODE_EXTRA_CA_CERTS|SSL_CERT_(FILE|DIR)|LOVELACE_(CONFIG|ROOT|PORT|EXECUTABLE|LOG_LEVEL))$/;

/**
 * Whichever shell first needs the server starts it, often an agent's worktree
 * with its own direnv. Keep only what the server needs to find tools and
 * reach git remotes; provider settings come from the config file.
 */
export function backgroundEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => INHERITED.test(key)));
}

function launchSupervisor(lovelaceDir: string): void {
  mkdirSync(join(lovelaceDir, 'logs'), { recursive: true });
  const log = openSync(serverLogPath(lovelaceDir), 'a');
  const [command, ...prefix] = selfInvocation();
  // Its own session, so closing the terminal or Herdr pane that started it does not stop it.
  const child = spawn(command!, [...prefix, 'server', 'supervise'], {
    detached: true, stdio: ['ignore', log, log], cwd: lovelaceDir, env: backgroundEnvironment(process.env),
  });
  // The caller's wait for /status reports the failure and points at the log.
  child.once('error', error => appendFileSync(serverLogPath(lovelaceDir), `Could not start the server: ${error.message}\n`));
  child.unref();
  closeSync(log);
}

const PROXY_VARIABLES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NODE_USE_ENV_PROXY'];

/** Proxy environment for the server: the macOS system proxy (Node reads it only at startup) or none. */
export function serverEnvironment(env: NodeJS.ProcessEnv, proxy: string | null): NodeJS.ProcessEnv {
  const next = Object.fromEntries(Object.entries(env).filter(([key]) => !PROXY_VARIABLES.includes(key)));
  return proxy ? { ...next, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NODE_USE_ENV_PROXY: '1' } : next;
}

/**
 * The background process: runs `lovelace server` as a child, restarts it when
 * the macOS system proxy changes (e.g. joining a VPN) or after it exits, and
 * stops it on SIGTERM.
 */
export async function superviseServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { lovelaceDir } = loadConfig();
  if (!claimPidFile(lovelaceDir)) {
    console.log('Another Lovelace server supervisor is running');
    return;
  }
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
  // Exit only once the server has released its port, so a restart can bind it again.
  const stop = () => {
    const done = () => {
      rmSync(pidPath(lovelaceDir), { force: true });
      process.exit(0);
    };
    if (!child || child.exitCode !== null || child.signalCode !== null) return done();
    child.once('exit', done);
    child.kill('SIGTERM');
    setTimeout(() => { child?.kill('SIGKILL'); done(); }, 5_000).unref();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  process.once('SIGHUP', stop);

  let backoffMs = 1_000;
  for (;;) {
    const proxy = await resolveProxy();
    console.log(`${new Date().toISOString()} Starting Lovelace ${version} ${proxy ? 'with the macOS system proxy' : 'with direct network access'}`);
    const startedAt = Date.now();
    const running = spawn(command!, [...prefix, 'server'], { env: serverEnvironment(env, proxy), stdio: 'inherit' });
    child = running;
    const exited = new Promise<void>(resolve => running.once('exit', () => resolve()));
    let alive = true;
    void exited.then(() => { alive = false; });
    while (alive) {
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, pollMs))]);
      if (alive && (await resolveProxy()) !== proxy) {
        console.log(`${new Date().toISOString()} macOS system proxy changed; restarting Lovelace`);
        running.kill('SIGTERM');
        await exited;
        backoffMs = 0;
      }
    }
    // A server that keeps failing at startup (e.g. its port is taken) backs off up to a minute.
    backoffMs = Date.now() - startedAt > 60_000 ? 1_000 : Math.min(Math.max(backoffMs * 2, 1_000), 60_000);
    await new Promise(resolve => setTimeout(resolve, backoffMs));
  }
}
