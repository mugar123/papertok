import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import type { Paper } from '../models/Paper.ts';
import { applyKnownPublicationTypes } from '../services/feedPublicationService.ts';
import { isFeedPublication } from '../services/feedPublicationRules.ts';
import { placeNotableCards } from '../utils/feedEnrichment.ts';
import { resumeIndex } from '../utils/feedMountWindow.ts';

const source = readFileSync(new URL('./FeedContext.tsx', import.meta.url), 'utf8');
const start = source.indexOf('function feedSnapshotKey(');
const end = source.indexOf('// ── Demo mode storage helpers', start);
assert.ok(start >= 0 && end > start);
const helpers = stripTypeScriptTypes(source.slice(start, end));
type Publications = Pick<typeof import('../services/feedPublicationService.ts'), 'applyKnownPublicationTypes'>;
function snapshots(publications: Publications = { applyKnownPublicationTypes }) {
  const stored = new Map<string, string>();
  const storage = { getItem: (key: string) => stored.get(key) || null, setItem: (key: string, value: string) => stored.set(key, value) };
  const helpersFor = new Function(
    'localStorage', 'FEED_SNAPSHOT_TTL_MS', 'FEED_SNAPSHOT_MAX_PAPERS', 'applyKnownPublicationTypes', 'isFeedPublication',
    `${helpers}; return { feedSnapshotKey, readFeedSnapshot, writeFeedSnapshot };`,
  );
  return { stored, ...helpersFor(storage, 15 * 60 * 1000, 30, publications.applyKnownPublicationTypes, isFeedPublication) };
}

test('old unchecked snapshots are refreshed, while current snapshots preserve scientific reviews and account isolation', () => {
  const { stored, feedSnapshotKey, readFeedSnapshot, writeFeedSnapshot } = snapshots();
  stored.set(feedSnapshotKey('test-user', 'math.AG'), JSON.stringify({
    savedAt: Date.now(), papers: [{ id: 'W568341909', publicationType: 'article' }], page: 1,
  }));
  assert.equal(readFeedSnapshot('test-user', 'math.AG'), null);
  stored.set(feedSnapshotKey('test-user', 'math.AG'), JSON.stringify({
    publicationPolicy: 1, savedAt: Date.now(), papers: [{ id: 'openalex:W1503277431', publicationType: 'article' }], page: 1,
  }));
  assert.equal(readFeedSnapshot('test-user', 'math.AG'), null);
  stored.set(feedSnapshotKey('test-user', 'math.AG'), JSON.stringify({
    publicationPolicy: 2, savedAt: Date.now(), papers: [{ id: 'W2020715063', abstract: '' }], page: 1,
  }));
  assert.equal(readFeedSnapshot('test-user', 'math.AG'), null, 'pre-admission recovery must run for old snapshots');
  const papers = [{ id: 'scientific-review', publicationType: 'review' }];
  writeFeedSnapshot('test-user', 'math.AG', { papers, page: 2, hasMore: true });
  assert.deepEqual(readFeedSnapshot('test-user', 'math.AG').papers, papers);
  assert.equal(readFeedSnapshot('test-user', 'math.AG').page, 2);
  assert.equal(readFeedSnapshot('different-user', 'math.AG'), null);
});

test('a book Crossref confirmed after its card was saved is left out when the snapshot is restored', async t => {
  // A separate instance of the publication service: its own Crossref cache.
  const publications = await import(new URL('../services/feedPublicationService.ts?snapshot-restore', import.meta.url).href) as typeof import('../services/feedPublicationService.ts');
  const { readFeedSnapshot, writeFeedSnapshot } = snapshots(publications);
  const card = (id: string, doi: string) => ({ id, doi, title: `Synthetic paper ${id}`, authors: [], abstract: '', publicationType: 'article', sources: { primary: 'openalex', enrichedBy: [] } });
  const visible = card('W3029239115', '10.1016/j.indag.2021.09.002');
  const book = card('W568341909', '10.1007/978-3-540-76956-9');
  // Saved while the reader was on these two cards, so the book stayed on screen.
  writeFeedSnapshot('test-user', 'math.AG', { papers: [visible, book], page: 1, hasMore: true });
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const dois = new URL(String(input)).searchParams.get('filter')!.split(',').map(value => value.slice(4));
    return Response.json({ message: { 'total-results': dois.length, items: dois.map(DOI => ({ DOI, type: DOI === book.doi ? 'book' : 'journal-article' })) } });
  });
  await publications.classifyFeedPublications([visible, book]);
  assert.deepEqual(readFeedSnapshot('test-user', 'math.AG').papers.map((paper: { id: string }) => paper.id), [visible.id]);
});

// One feed card in 15 is notable (placeNotableCards). After a reload the reader
// is back on the card they left, found by its id (resumeIndex, as FeedContainer
// restores it).
const card = (id: string, publicationType = 'article'): Paper => ({ id, title: `Synthetic paper ${id}`, abstract: '', authors: [], publicationType, sources: { primary: 'openalex', enrichedBy: [] } });
const notable = (id: string): Paper => ({ ...card(id), _notable: true });
const ids = (papers: Paper[]) => papers.map(paper => paper.id);

for (const past of [1, 2]) {
  test(`a notable card the reader passed stays behind them when books before it leave a restored snapshot (${past} card${past > 1 ? 's' : ''} past it)`, () => {
    // Crossref has since called two cards the reader passed books.
    const books = new Set(['card-3', 'card-5']);
    const { readFeedSnapshot, writeFeedSnapshot } = snapshots({ applyKnownPublicationTypes: papers => papers.map(paper => (books.has(paper.id) ? card(paper.id, 'book') : paper)) });
    const saved = placeNotableCards(Array.from({ length: 28 }, (_, index) => card(`card-${index}`)), [notable('notable-0'), notable('notable-1')]);
    assert.equal(saved[14].id, 'notable-0');
    const readerAt = 14 + past;
    writeFeedSnapshot('test-user', 'cs.AI', { papers: saved, page: 2, hasMore: true });
    const restored: Paper[] = readFeedSnapshot('test-user', 'cs.AI').papers;
    const at = resumeIndex({ papers: restored, savedPaperId: saved[readerAt].id, savedIndex: readerAt });
    assert.ok(ids(restored).indexOf('notable-0') < at, 'the notable card the reader saw does not come again');
    assert.deepEqual(ids(restored.slice(at)), ids(saved.slice(readerAt)), 'the cards from the reader on keep their saved order');
  });
}

// The reader dismissed the notable card at 14. The re-rank that followed placed
// the next one at 29, the fifteenth place after the dismissed card's.
test('a notable card the reader has not reached stays ahead of them in a restored snapshot', () => {
  const { readFeedSnapshot, writeFeedSnapshot } = snapshots({ applyKnownPublicationTypes: papers => papers });
  const saved = [...Array.from({ length: 29 }, (_, index) => card(`card-${index}`)), notable('notable-1')];
  writeFeedSnapshot('test-user', 'cs.AI', { papers: saved, page: 2, hasMore: true });
  const restored: Paper[] = readFeedSnapshot('test-user', 'cs.AI').papers;
  const at = resumeIndex({ papers: restored, savedPaperId: 'card-16', savedIndex: 16 });
  assert.ok(ids(restored).indexOf('notable-1') > at, 'the reader still reaches it');
  assert.deepEqual(ids(restored), ids(saved), 'with no book to leave, the restore keeps the saved list');
});

test('late answers to a restored snapshot keep its save time, while a newly loaded page starts its fifteen minutes', t => {
  const { readFeedSnapshot, writeFeedSnapshot } = snapshots();
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const card = { id: 'W2020715063', abstract: '', sources: { primary: 'openalex', enrichedBy: [] } };
  writeFeedSnapshot('test-user', 'cs.AI', { papers: [card], page: 1, hasMore: true });
  now += 10 * 60 * 1000;
  // A cold open restores it, and a late abstract updates the restored cards.
  const restored = readFeedSnapshot('test-user', 'cs.AI');
  writeFeedSnapshot('test-user', 'cs.AI', { ...restored, papers: [{ ...card, abstract: 'Recovered source text.' }] });
  now += 6 * 60 * 1000;
  assert.equal(readFeedSnapshot('test-user', 'cs.AI'), null, 'the snapshot expires fifteen minutes after its page loaded');
  writeFeedSnapshot('test-user', 'cs.AI', { papers: [card], page: 1, hasMore: true });
  now += 10 * 60 * 1000;
  assert.deepEqual(readFeedSnapshot('test-user', 'cs.AI').papers.map((paper: { id: string }) => paper.id), [card.id]);
});

// FeedContext cannot be mounted under Node; feedUsableBatch.test.ts runs the
// restore itself. This pins that both restoring effects go through it, and
// that a cold mount does not read the snapshot again once it is shown.
test('SOURCE: both snapshot effects restore through one owner, read once on a cold mount', () => {
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.equal(code.match(/restoreFeedSnapshot\(snapshot, feedMode, signature\);/g)?.length, 2);
  assert.equal(code.match(/setPapers\(snapshot\.papers\)/g)?.length, 1, 'only the owner shows a stored page');
  assert.match(code, /if \(isColdMount && restoredFeedKeyRef\.current === `\$\{activeUserId\.current\}:\$\{signature\}`\) return;\s*feedCache\.current = \{\};/);
});
