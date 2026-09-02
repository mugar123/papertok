import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

/**
 * SOURCE tests. The root cause of the "Me gusta" tab never loading was on the
 * WRITE side: liking a pre-2007 arXiv paper (`hep-th/0603001`) recorded the id
 * in the aggregate, then `doc(db, 'users', uid, 'interactions', id)` threw on
 * the slash, and the catch reverted the UI but never the aggregate. Every
 * interaction document must be addressed through one helper that encodes the
 * id into a legal document name, and every reader must decode it back.
 */
test('SOURCE: no interaction document is addressed by a raw paper id anymore', async () => {
  const code = stripComments(await read('./FeedContext.jsx'));
  assert.doesNotMatch(code, /doc\(db, 'users', userId, 'interactions'/,
    'a raw doc() call throws on a slash-bearing id after the aggregate was already written');
  const uses = code.match(/interactionDocRef\(userId, (?:paper\.id|paperId)\)/g) || [];
  assert.ok(uses.length >= 11, `expected the eleven write sites to go through interactionDocRef, found ${uses.length}`);
});

test('SOURCE: the library read encodes before it plans and decodes what comes back', async () => {
  const code = stripComments(await read('../services/interactionProfileStore.js'));
  const body = code.slice(code.indexOf('export async function fetchLibraryRecords'), code.indexOf('countReads(\'library\''));
  assert.ok(body.length > 0, 'expected to have found fetchLibraryRecords');
  assert.match(body, /planLibraryBatches\(paperIds\.map\(encodeInteractionDocId\), LIBRARY_BATCH_SIZE\)/,
    'encoded first, so a legacy id is a batch member and not a dropped one');
  assert.match(body, /records: snapshot\.docs\.map\(item => \(\{ id: decodeInteractionDocId\(item\.id\), data: item\.data\(\) \}\)\)/,
    'and the caller sees the paper id it asked for, never the encoded name');
});

test('SOURCE: the aggregate rebuild scan decodes ids, or a rebuilt aggregate would carry encoded names', async () => {
  const code = stripComments(await read('../services/interactionProfileStore.js'));
  const page = code.slice(code.indexOf('async listInteractionPage('), code.indexOf('async countInteractions('));
  assert.match(page, /startAfter\(encodeInteractionDocId\(startAfterId\)\)/);
  assert.match(page, /\{ id: decodeInteractionDocId\(item\.id\), data: item\.data\(\) \}/);
});
