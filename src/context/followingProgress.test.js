import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

function bounded(code, from, to, label, maxLines) {
  const start = code.indexOf(from);
  const end = code.indexOf(to, start + 1);
  assert.ok(start >= 0 && end > start, `expected to have found ${label}`);
  const block = code.slice(start, end);
  const lines = block.split('\n').length;
  assert.ok(lines <= maxLines, `${label} capture spans ${lines} lines, past what it names`);
  return block;
}

/**
 * SOURCE tests: the provider is a React context this repo cannot mount under
 * node. Measured with fourteen follows on a cold cache, the Following feed
 * showed its discovery screen for 6.5 s and then every card at once, because
 * the refresh set its items exactly once, when the slowest follow had
 * answered. The service now delivers as each follow answers, and the provider
 * paints those deliveries.
 */
test('SOURCE: the provider paints what each follow answered as it answers', async () => {
  const code = stripComments(await read('./FollowingUpdatesContext.jsx'));
  const request = bounded(code, 'request = fetchFollowingUpdates(followedEntities, {', 'requestsInFlight.set(requestKey, request);', 'the request', 12);
  assert.match(request, /onProgress: applyProgress/);
  const apply = bounded(code, 'const applyProgress = useCallback(', '}, [userId]);', 'the progress handler', 30);
  assert.match(apply, /if \(activeUserIdRef\.current !== userId\) return;/, 'a delivery for an account that signed out meanwhile is dropped');
  assert.match(apply, /setItems\(/, 'a delivery lands in the items the page ranks');
});
