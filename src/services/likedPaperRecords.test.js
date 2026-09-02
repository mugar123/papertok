import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fetchLikedPaperRecords } from './likedPaperRecords.js';

/**
 * The Liked tab is keyed by the feed's `paper.id`, and for a pre-2007 arXiv
 * paper that id carries a slash (`hep-th/0603001`). Firestore cannot store a
 * document under it — the like reached the aggregate and the document write
 * threw — so the title has to come from arXiv itself, while every other id
 * still goes to the library read.
 */
function stubs({ records = [], fromCache = false, arxiv = [] } = {}) {
  const calls = { firestore: [], arxiv: [] };
  return {
    calls,
    readRecords: async (userId, ids) => { calls.firestore.push(ids); return { records, fromCache }; },
    fetchArxivPapers: async (ids) => { calls.arxiv.push(ids); return arxiv; },
  };
}

test('asks Firestore for every id and arXiv only for the legacy ids it did not answer', async () => {
  const io = stubs({
    records: [{ id: 'openalex:W1', data: { paperTitle: 'Stored title' } }],
    arxiv: [{ id: 'hep-th/0603001', arxivId: 'hep-th/0603001', title: 'Quantum gravity note', authors: [{ name: 'A. Author' }] }],
  });
  const result = await fetchLikedPaperRecords('uid', ['openalex:W1', 'hep-th/0603001'], io);

  assert.deepEqual(io.calls.firestore, [['openalex:W1', 'hep-th/0603001']],
    'the store encodes the slash itself; a legacy paper liked after the fix HAS a document');
  assert.deepEqual(io.calls.arxiv, [['hep-th/0603001']]);
  assert.equal(result.records.length, 2);
  const hydrated = result.records.find(record => record.id === 'hep-th/0603001');
  assert.equal(hydrated.data.paperTitle, 'Quantum gravity note');
  assert.equal(hydrated.data.paper.title, 'Quantum gravity note');
  assert.deepEqual(hydrated.data.paperAuthors, [{ name: 'A. Author' }]);
  assert.equal(result.fromCache, false);
  assert.equal(result.authoritative, true);
  assert.deepEqual(result.unsettled, []);
});

test('a legacy id Firestore already names is not sent to arXiv', async () => {
  const io = stubs({ records: [{ id: 'hep-th/0603001', data: { paperTitle: 'Stored legacy title' } }] });
  const result = await fetchLikedPaperRecords('uid', ['hep-th/0603001'], io);
  assert.deepEqual(io.calls.arxiv, []);
  assert.equal(result.records[0].data.paperTitle, 'Stored legacy title');
});

test('matches an arXiv answer back to the requested id even with a version suffix', async () => {
  const io = stubs({ arxiv: [{ id: 'hep-th/0603001', arxivId: 'hep-th/0603001', title: 'Versioned' }] });
  const result = await fetchLikedPaperRecords('uid', ['hep-th/0603001v2'], io);
  assert.equal(result.records[0].id, 'hep-th/0603001v2');
  assert.equal(result.records[0].data.paperTitle, 'Versioned');
});

test('does not touch arXiv when no legacy id is missing', async () => {
  const io = stubs({ records: [{ id: 'openalex:W1', data: {} }] });
  await fetchLikedPaperRecords('uid', ['openalex:W1'], io);
  assert.deepEqual(io.calls.arxiv, []);
});

test('a failed arXiv read leaves only the legacy ids retryable, not the Firestore-confirmed absences', async () => {
  const io = stubs({ records: [{ id: 'openalex:W1', data: { paperTitle: 'Stored title' } }] });
  io.fetchArxivPapers = async () => { throw new Error('arxiv down'); };
  const result = await fetchLikedPaperRecords('uid', ['openalex:W1', 'openalex:W2', 'hep-th/0603001'], io);
  assert.equal(result.records.length, 1);
  assert.equal(result.authoritative, true, 'Firestore answered from the server: W2 has no record, and that is final');
  assert.deepEqual(result.unsettled, ['hep-th/0603001'], 'only what arXiv failed to answer stays askable');
});

test('a cache-served Firestore answer is still reported as such', async () => {
  const io = stubs({ fromCache: true });
  const result = await fetchLikedPaperRecords('uid', ['openalex:W1'], io);
  assert.equal(result.fromCache, true);
});

test('the Liked tab reads through fetchLikedPaperRecords', async () => {
  const source = await readFile(new URL('../components/Public/PublicProfilePage.jsx', import.meta.url), 'utf8');
  const effect = source.slice(
    source.indexOf('requestMissingRecords({'),
    source.indexOf('}).then(({ records, retryable, attempt, error })'),
  );
  assert.ok(effect.length > 0, 'expected to have found the liked fan-out');
  assert.match(effect, /fetchLikedPaperRecords\(user\.uid, ids\)/);
});
