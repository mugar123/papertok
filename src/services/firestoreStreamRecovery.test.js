import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
const read = async (path) => stripComments(await readFile(new URL(path, import.meta.url), 'utf8'));

test('SOURCE: the app registers one stream recovery, built on the SDK network toggle', async () => {
  const code = await read('./firebase.js');
  // Both halves of the kick, on the app's own database, in this order.
  assert.match(code, /registerStallRecovery\(createStreamRecovery\(\{\s*disable: \(\) => disableNetwork\(db\),\s*enable: \(\) => enableNetwork\(db\),\s*isOffline,\s*\}\)\);/);
  // Wired at module scope, where every screen inherits it, not inside a
  // component that could mount late or twice.
  assert.doesNotMatch(code, /useEffect[\s\S]*registerStallRecovery/);
});

test('SOURCE: the interaction profile aggregate is read with patience, and a cache-served absence is not an answer', async () => {
  const code = await read('./interactionProfileStore.js');
  const readAggregate = code.match(/async readAggregate\(\) \{[\s\S]*?\n {4}\},/);
  assert.ok(readAggregate, 'readAggregate is gone');
  assert.ok(readAggregate[0].split('\n').filter((line) => line.trim()).length <= 12, 'the capture ran past readAggregate');
  assert.match(readAggregate[0], /patientRead\(\(\) => getDoc\(interactionProfileRef\(userId\)\), \{[\s\S]*isAnswer: documentIsAuthoritative/);
  // The bare read is gone: it never answered on a dead stream, and the feed
  // gave up on the account's likes for the session.
  assert.doesNotMatch(readAggregate[0], /await getDoc\(/);
});

test('SOURCE: a rebuild never consumes a page the server did not send', async () => {
  const code = await read('./interactionProfileStore.js');
  const page = code.match(/async listInteractionPage\(\{ pageSize, startAfterId \}\) \{[\s\S]*?\n {4}\},/);
  assert.ok(page, 'listInteractionPage is gone');
  assert.match(page[0], /const snapshot = await getDocs\([\s\S]*?\);\s*if \(!queryIsAuthoritative\(snapshot\)\) throw unconfirmedPage\(\);/);
  // And what it throws is the "not now" the loader already keeps the old
  // profile for, not a verdict.
  assert.match(code, /function unconfirmedPage\(\) \{[\s\S]*?code: 'unavailable'/);
});
