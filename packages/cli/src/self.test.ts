import assert from 'node:assert/strict';
import test from 'node:test';
import { selfInvocation, shellQuote } from './self.js';

test('the CLI reinvokes Homebrew\'s stable wrapper, else this Node and entry', () => {
  assert.deepEqual(selfInvocation({ LOVELACE_EXECUTABLE: '/opt/homebrew/opt/lovelace/bin/lovelace' }), ['/opt/homebrew/opt/lovelace/bin/lovelace']);
  assert.equal(selfInvocation({})[0], process.execPath);
  assert.equal(selfInvocation({}).at(-1), process.argv[1]);
  assert.equal(shellQuote('/opt/homebrew/bin/lovelace'), '/opt/homebrew/bin/lovelace');
  assert.equal(shellQuote("/Users/me/My Code/it's"), "'/Users/me/My Code/it'\\''s'");
});
