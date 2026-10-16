import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseMacOSSystemProxySettings,
  proxyUrlFromPacResult,
  resolveMacOSSystemProxy,
} from '../macos-system-proxy.js';

test('parses explicit and automatic macOS proxy settings', () => {
  const settings = parseMacOSSystemProxySettings(`
<dictionary> {
  HTTPEnable : 1
  HTTPPort : 8080
  HTTPProxy : proxy.example.com
  HTTPSEnable : 1
  HTTPSPort : 8443
  HTTPSProxy : secure-proxy.example.com
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : http://config.example.com/proxy.pac
}
`);

  assert.deepEqual(settings, {
    httpEnabled: true,
    httpHost: 'proxy.example.com',
    httpPort: 8080,
    httpsEnabled: true,
    httpsHost: 'secure-proxy.example.com',
    httpsPort: 8443,
    pacEnabled: true,
    pacUrl: 'http://config.example.com/proxy.pac',
  });
});

test('resolves the active PAC configuration for the target URL', async () => {
  let fetchedUrl = '';
  let evaluatedUrl = '';
  const proxyUrl = await resolveMacOSSystemProxy('https://jira.example.com/', {
    readSettings: async () => `
      ProxyAutoConfigEnable : 1
      ProxyAutoConfigURLString : http://config.example.com/proxy.pac
    `,
    fetchPac: async (url) => {
      fetchedUrl = url;
      return 'function FindProxyForURL() { return "PROXY proxy.example.com:8080"; }';
    },
    evaluatePac: async (_source, url) => {
      evaluatedUrl = url;
      return 'PROXY proxy.example.com:8080; DIRECT';
    },
  });

  assert.equal(fetchedUrl, 'http://config.example.com/proxy.pac');
  assert.equal(evaluatedUrl, 'https://jira.example.com/');
  assert.equal(proxyUrl, 'http://proxy.example.com:8080');
});

test('falls back to the explicit secure web proxy when PAC is disabled', async () => {
  const proxyUrl = await resolveMacOSSystemProxy(undefined, {
    readSettings: async () => `
      HTTPSEnable : 1
      HTTPSProxy : proxy.example.com
      HTTPSPort : 8080
      ProxyAutoConfigEnable : 0
    `,
  });

  assert.equal(proxyUrl, 'http://proxy.example.com:8080');
});

test('maps PAC directives to environment proxy URLs', () => {
  assert.equal(proxyUrlFromPacResult('DIRECT'), null);
  assert.equal(proxyUrlFromPacResult('PROXY proxy.example.com:8080; DIRECT'), 'http://proxy.example.com:8080');
  assert.equal(proxyUrlFromPacResult('SOCKS socks.example.com:1080; HTTPS proxy.example.com:8443'), 'https://proxy.example.com:8443');
});
