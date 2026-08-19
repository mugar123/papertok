import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  PAPER_STUB_LIMITS,
  buildPaperStubData,
  resolveThreadAnchor,
} from './paperStubService.js';
import { keyFromIdentity } from '../utils/paperCanonicalKey.js';

const BASE = {
  currentUser: { uid: 'u1' },
  isDemo: false,
  document: (database, ...path) => ({ path: path.join('/') }),
};

function snapshot(data) {
  return { exists: () => data !== null, data: () => data };
}

// --- buildPaperStubData ----------------------------------------------------

test('the stub carries the identifiers in the same spelling as its key', () => {
  const stub = buildPaperStubData({
    title: 'A result', authors: ['A. Author'],
    doi: 'https://doi.org/10.1234/AbC', arxivId: '2401.12345v2',
  });
  assert.equal(stub.canonicalKey, 'doi:10.1234/abc');
  assert.equal(stub.doi, '10.1234/abc');
  assert.equal(stub.arxivId, '2401.12345');
});

test('a paper without identity or title cannot anchor a thread', () => {
  assert.equal(buildPaperStubData({ title: 'No identity' }), null);
  assert.equal(buildPaperStubData({ doi: '10.1234/abc' }), null);
  assert.equal(buildPaperStubData(null), null);
});

test('absent optionals are dropped, never written as undefined or empty', () => {
  const stub = buildPaperStubData({ title: 'T', id: 'pmid:1' });
  assert.deepEqual(Object.keys(stub).sort(), ['authors', 'canonicalKey', 'title']);
});

test('author objects and strings both become bounded name strings', () => {
  const stub = buildPaperStubData({
    title: 'T', id: 'pmid:1',
    authors: ['Plain Name', { name: 'From Object' }, { notName: 'x' }, 42,
      ...Array.from({ length: 30 }, (unused, index) => `Extra ${index}`)],
  });
  assert.equal(stub.authors.length, PAPER_STUB_LIMITS.authors);
  assert.deepEqual(stub.authors.slice(0, 2), ['Plain Name', 'From Object']);
});

test('every text field respects its ceiling', () => {
  const stub = buildPaperStubData({
    title: 'T'.repeat(1000), id: 'pmid:1',
    abstract: 'a'.repeat(5000), category: 'c'.repeat(500),
  });
  assert.equal(stub.title.length, PAPER_STUB_LIMITS.title);
  assert.equal(stub.abstract.length, PAPER_STUB_LIMITS.abstract);
  assert.equal(stub.category.length, PAPER_STUB_LIMITS.category);
});

test('only https urls survive into openUrl', () => {
  assert.equal(
    buildPaperStubData({ title: 'T', id: 'pmid:1', landingPageUrl: 'http://x.org/1' }).openUrl,
    undefined,
  );
  assert.equal(
    buildPaperStubData({ title: 'T', id: 'pmid:1', pdfUrl: 'https://arxiv.org/pdf/1' }).openUrl,
    'https://arxiv.org/pdf/1',
  );
});

// --- resolveThreadAnchor ---------------------------------------------------

test('a single-identity paper resolves with one read', async () => {
  const reads = [];
  const anchor = await resolveThreadAnchor({ title: 'T', arxivId: '2401.12345' }, {
    ...BASE,
    getDocument: async (ref) => { reads.push(ref.path); return snapshot(null); },
  });
  assert.equal(reads.length, 1);
  assert.equal(anchor.key, keyFromIdentity('arxiv:2401.12345'));
  assert.equal(anchor.stubExists, false);
  assert.deepEqual(anchor.alternates, []);
});

test('a dual-identity paper checks the arXiv key too, and surfaces what exists', async () => {
  const doiKey = keyFromIdentity('doi:10.1234/abc');
  const arxivKey = keyFromIdentity('arxiv:2401.12345');
  const stored = { [`papers/${arxivKey}`]: { canonicalKey: 'arxiv:2401.12345', title: 'Old thread' } };
  const reads = [];
  const anchor = await resolveThreadAnchor(
    { title: 'T', doi: '10.1234/abc', arxivId: '2401.12345' },
    {
      ...BASE,
      getDocument: async (ref) => { reads.push(ref.path); return snapshot(stored[ref.path] ?? null); },
    },
  );
  assert.equal(reads.length, 2, 'the split-brain read costs exactly two');
  assert.equal(anchor.key, doiKey, 'new comments go to the canonical key');
  assert.equal(anchor.stubExists, false);
  assert.equal(anchor.alternates.length, 1);
  assert.equal(anchor.alternates[0].key, arxivKey);
});

test('an unidentifiable paper resolves to null without reading anything', async () => {
  const anchor = await resolveThreadAnchor({ title: 'No ids' }, {
    ...BASE,
    getDocument: async () => { throw new Error('must not read'); },
  });
  assert.equal(anchor, null);
});

// --- structural ------------------------------------------------------------

test('SOURCE: nothing on the feed path imports the stub service', async () => {
  for (const path of [
    '../context/FeedContext.jsx',
    '../components/Feed/FeedContainer.jsx',
    '../components/Feed/PaperCard.jsx',
    '../utils/interactionProfileLoader.js',
    '../services/interactionProfileStore.js',
  ]) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /paperStubService/, `${path} must stay off the stub collection`);
  }
});
