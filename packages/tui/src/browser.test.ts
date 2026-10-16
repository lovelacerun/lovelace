import assert from 'node:assert/strict';
import { it } from 'node:test';
import { browserUrl, openBrowser } from './browser.js';

for (const value of [null, '', '--help', '/local', 'file:///etc/passwd', 'javascript:alert(1)', 'https://user:pass@github.com/x', 'https://github.com/\x1b[2J', 'https://github.com/\n']) {
  it(`rejects non-web or unsafe browser input ${JSON.stringify(value)}`, async () => {
    assert.equal(browserUrl(value), null);
    let executed = false;
    await assert.rejects(openBrowser(value as string, async () => { executed = true; }), /HTTP\(S\)/);
    assert.equal(executed, false);
  });
}

for (const [platform, file, prefix] of [
  ['darwin', 'open', []], ['linux', 'xdg-open', []], ['win32', 'rundll32.exe', ['url.dll,FileProtocolHandler']],
] as const) {
  it(`opens a URL on ${platform} as an argument without a shell`, async () => {
    const url = 'https://github.com/example/service/pull/12?label=a&other=b';
    const calls: unknown[] = [];
    await openBrowser(url, async (file, args) => { calls.push([file, args]); }, platform);
    assert.deepEqual(calls, [[file, [...prefix, url]]]);
  });
}

it('propagates launcher failure for the UI to report', async () => {
  await assert.rejects(openBrowser('https://example.com', async () => { throw new Error('Launcher unavailable'); }), /Launcher unavailable/);
});
