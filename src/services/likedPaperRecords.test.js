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

test('sends legal ids to Firestore and slash-bearing arXiv ids to arXiv', async () => {
  const io = stubs({
    records: [{ id: 'openalex:W1', data: { paperTitle: 'Stored title' } }],
    arxiv: [{ id: 'hep-th/0603001', arxivId: 'hep-th/0603001', title: 'Quantum gravity note', authors: [{ name: 'A. Author' }] }],
  });
  const result = await fetchLikedPaperRecords('uid', ['openalex:W1', 'hep-th/0603001'], io);

  assert.deepEqual(io.calls.firestore, [['openalex:W1']]);
  assert.deepEqual(io.calls.arxiv, [['hep-th/0603001']]);
  assert.equal(result.records.length, 2);
  const hydrated = result.records.find(record => record.id === 'hep-th/0603001');
  assert.equal(hydrated.data.paperTitle, 'Quantum gravity note');
  assert.equal(hydrated.data.paper.title, 'Quantum gravity note');
  assert.deepEqual(hydrated.data.paperAuthors, [{ name: 'A. Author' }]);
  assert.equal(result.fromCache, false);
  assert.equal(result.authoritative, true);
});

test('matches an arXiv answer back to the requested id even with a version suffix', async () => {
  const io = stubs({ arxiv: [{ id: 'hep-th/0603001', arxivId: 'hep-th/0603001', title: 'Versioned' }] });
  const result = await fetchLikedPaperRecords('uid', ['hep-th/0603001v2'], io);
  assert.equal(result.records[0].id, 'hep-th/0603001v2');
  assert.equal(result.records[0].data.paperTitle, 'Versioned');
});

test('does not touch arXiv when no id needs it', async () => {
  const io = stubs({ records: [{ id: 'openalex:W1', data: {} }] });
  await fetchLikedPaperRecords('uid', ['openalex:W1'], io);
  assert.deepEqual(io.calls.arxiv, []);
});

test('does not touch Firestore when only legacy ids are wanted', async () => {
  const io = stubs({ arxiv: [] });
  const result = await fetchLikedPaperRecords('uid', ['hep-th/0603001'], io);
  assert.deepEqual(io.calls.firestore, []);
  assert.deepEqual(result.records, []);
  assert.equal(result.authoritative, true, 'arXiv answered and had nothing: that absence is final');
});

test('a failed arXiv read leaves those ids retryable without losing the Firestore answer', async () => {
  const io = stubs({ records: [{ id: 'openalex:W1', data: { paperTitle: 'Stored title' } }] });
  io.fetchArxivPapers = async () => { throw new Error('arxiv down'); };
  const result = await fetchLikedPaperRecords('uid', ['openalex:W1', 'hep-th/0603001'], io);
  assert.equal(result.records.length, 1);
  assert.equal(result.authoritative, false);
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
