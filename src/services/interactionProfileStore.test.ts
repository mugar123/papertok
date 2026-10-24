import test from 'node:test';
import assert from 'node:assert/strict';
import { connectFirestoreEmulator, disableNetwork, doc, setDoc, terminate } from 'firebase/firestore';
import { db } from './firebase.ts';
import { fetchLibraryRecords, interactionsRef } from './interactionProfileStore.ts';
import { encodeInteractionDocId } from '../utils/interactionDocId.ts';

/**
 * The app's own Firestore client, kept off every network: pointed at a port
 * nothing listens on, then offline. Writes land in its in-memory cache only
 * and reads are answered from it, which is all `fetchLibraryRecords` needs to
 * show which ids reach an `in` query. The SDK validates those queries on the
 * client, so an id it refuses rejects here exactly as it does in the browser.
 */
connectFirestoreEmulator(db, '127.0.0.1', 1);
await disableNetwork(db);
test.after(() => terminate(db));

const USER = 'library-reader';
// Never settled while offline; held only so the cache keeps the documents.
const pendingWrites: Promise<void>[] = [];
const like = (paperId: string) => {
  pendingWrites.push(setDoc(doc(interactionsRef(USER), encodeInteractionDocId(paperId)), { liked: true }));
};

// One liked paper with a pre-2007 arXiv id (`hep-th/0603001`) used to reject
// the `in` query it rode in, and with it every other liked paper of the batch:
// the whole Liked tab sat on a skeleton, retrying the same rejection.
test('a pre-2007 arXiv id and an empty id do not blank the rest of the Liked tab', async () => {
  like('2401.00001');
  like('hep-th/0603001');
  like('2401.00002');
  const { records, fromCache } = await fetchLibraryRecords(USER, ['2401.00001', 'hep-th/0603001', '', '2401.00002']);
  assert.deepEqual(records.map(record => record.id).sort(), ['2401.00001', '2401.00002', 'hep-th/0603001']);
  assert.deepEqual(records[0].data, { liked: true });
  assert.equal(fromCache, true);
});

test('a library larger than one `in` query is read in full across its batches', async () => {
  const ids = Array.from({ length: 65 }, (_, index) => `2402.${String(index).padStart(5, '0')}`);
  ids.forEach(like);
  const { records } = await fetchLibraryRecords(USER, ids);
  assert.equal(records.length, 65);
  assert.deepEqual(records.map(record => record.id).sort(), ids);
});

test('nothing to read without a user or ids', async () => {
  assert.deepEqual(await fetchLibraryRecords('', ['2401.00001']), { records: [], fromCache: false });
  assert.deepEqual(await fetchLibraryRecords(USER, []), { records: [], fromCache: false });
  assert.deepEqual(await fetchLibraryRecords(USER, ['']), { records: [], fromCache: false });
});
