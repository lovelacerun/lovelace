import { execFile } from 'node:child_process';

/** Provider links are data: only ordinary web URLs may reach the OS launcher. */
export function browserUrl(value: unknown): string | null {
  if (typeof value !== 'string' || /[\x00-\x20\x7f-\x9f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

type BrowserExec = (file: string, args: string[]) => Promise<void>;
const execute: BrowserExec = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 10_000 }, error => error ? reject(error) : resolve());
});

export async function openBrowser(value: string, exec: BrowserExec = execute, platform = process.platform): Promise<void> {
  const url = browserUrl(value);
  if (!url) throw new Error('Cannot open this link: expected an HTTP(S) URL without credentials.');
  if (platform === 'darwin') await exec('open', [url]);
  else if (platform === 'win32') await exec('rundll32.exe', ['url.dll,FileProtocolHandler', url]);
  else await exec('xdg-open', [url]);
}
